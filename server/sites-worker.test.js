import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './sites-worker.js';

test('runtime config exposes public Supabase config without server secrets', async () => {
  const response = await worker.fetch(new Request('https://app.test/api/config'), {
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_ANON_KEY: 'anon-public',
    SUPABASE_SERVICE_ROLE_KEY: 'service-secret'
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.supabaseUrl, 'https://supabase.test');
  assert.equal(body.supabaseAnonKey, 'anon-public');
  assert.equal(JSON.stringify(body).includes('service-secret'), false);
});

test('terms status rejects a browser-supplied identity without a session', async () => {
  const response = await worker.fetch(new Request('https://app.test/api/terms/status?user_id=someone'), {
    SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role'
  });
  assert.equal(response.status, 401);
});

test('terms acceptance still sends bearer auth when only the legacy secret key is configured', async () => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/rest/v1/terms_documents?')) {
      return new Response(JSON.stringify([{ doc_type: 'client_tnc', version: '1.0.0', content: 'Terms', published_at: '2026-08-30T00:00:00Z' }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).includes('/rest/v1/terms_acceptances')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected ${url}`);
  };
  try {
    const response = await worker.fetch(new Request('https://app.test/api/terms/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer test:client:c1' },
      body: JSON.stringify({ doc_type: 'client_tnc' })
    }), {
      SUPABASE_URL: 'https://supabase.test',
      SUPABASE_SECRET_KEY: 'legacy-secret',
      PROCUREMENT_TEST_AUTH: '1'
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(calls.some((call) => call.url.includes('/rest/v1/terms_acceptances?') && call.init?.headers?.Authorization === 'Bearer legacy-secret'), true);
  } finally {
    globalThis.fetch = previous;
  }
});

test('registration rejects self-selected admin roles', async () => {
  const response = await worker.fetch(new Request('https://app.test/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@test.invalid', password: 'password123', role: 'admin' })
  }), { SUPABASE_URL: 'https://supabase.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service-role' });
  assert.equal(response.status, 400);
});

test('reserved admin email cannot self-register, even as a client', async () => {
  const response = await worker.fetch(new Request('https://app.test/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'urbanprocures@gmail.com', password: 'password123', role: 'client' })
  }), { SUPABASE_URL: 'https://supabase.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service-role' });
  assert.equal(response.status, 400);
});

test('registration provisions client accounts through the supported auth admin API', async () => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/auth/v1/admin/users') && init.method === 'POST') {
      return new Response(JSON.stringify({ user: { id: 'u1', email: 'client@test.invalid', app_metadata: { role: 'client' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).includes('/auth/v1/token?grant_type=password')) {
      return new Response(JSON.stringify({
        access_token: 'access-token',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: 1234567890,
        refresh_token: 'refresh-token',
        user: { id: 'u1', email: 'client@test.invalid', app_metadata: { role: 'client' } }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).includes('/rest/v1/procurement_audit_events') && init.method === 'POST') {
      return new Response('{}', { status: 201 });
    }
    throw new Error(`unexpected ${url}`);
  };
  try {
    const response = await worker.fetch(new Request('https://app.test/api/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'client@test.invalid', password: 'password123', role: 'client' })
    }), { SUPABASE_URL: 'https://supabase.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service-role' });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.ok, true);
    assert.equal(body.user.id, 'u1');
    assert.equal(body.session.access_token, 'access-token');
    assert.equal(JSON.stringify(body).includes('service-role'), false);
    assert.equal(calls.some((call) => call.url.includes('/auth/v1/signup')), false);
  } finally {
    globalThis.fetch = previous;
  }
});

test('public RFQ stores guest contact off the vendor pack fields', async () => {
  const previous = globalThis.fetch;
  const inserts = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('/rest/v1/rfqs') && init.method === 'POST') {
      inserts.push(JSON.parse(init.body));
      return new Response(JSON.stringify([{ id: 'UP-TEST' }]), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).includes('/rest/v1/procurement_notifications') && init.method === 'POST') {
      return new Response('[]', { status: 201 });
    }
    throw new Error(`unexpected ${url}`);
  };
  try {
    const response = await worker.fetch(new Request('https://app.test/api/public/rfq', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Villa painting',
        category: 'finishing',
        scope: 'Repaint interior walls',
        full_name: 'Aisha Khan',
        phone: '+971501111111',
        email: 'aisha@test.invalid',
        address: 'Villa 12, Al Barsha',
        tracking_code: 'UP-TEST'
      })
    }), { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role' });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.tracking_code, 'UP-TEST');
    assert.equal(inserts[0].title, 'Villa painting');
    assert.equal(inserts[0].location, 'Villa 12, Al Barsha');
    assert.match(inserts[0].special_requirements, /Aisha Khan/);
    assert.equal(inserts[0].sanitized_ready, false);
  } finally {
    globalThis.fetch = previous;
  }
});

test('provision-role infers client from session metadata', async () => {
  const response = await worker.fetch(new Request('https://app.test/api/auth/provision-role', {
    method: 'POST',
    headers: { Authorization: 'Bearer test:client:c9', 'content-type': 'application/json' },
    body: '{}'
  }), { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role', PROCUREMENT_TEST_AUTH: '1' });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.role, 'client');
});

test('public stats never exposes client or vendor names', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (/[?&]select=id(?:&|$)/.test(path)) {
      return new Response('[]', { status: 200, headers: { 'content-range': '0-0/2' } });
    }
    if (path.includes('/rest/v1/awards?')) {
      return new Response(JSON.stringify([
        { rfq_id: 'RFQ-1', awarded_amount: 1000, created_at: '2026-09-15T00:00:00Z', winner_vendor_id: 'secret-vendor', notes: 'ABC Contracting' }
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path.includes('/rest/v1/rfqs?')) {
      return new Response(JSON.stringify([{ id: 'RFQ-1', category: 'MEP', status: 'Awarded', deadline: null, created_at: '2026-09-14T00:00:00Z' }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path.includes('/rest/v1/procurement_notifications?')) {
      return new Response(JSON.stringify([{ event_type: 'award', created_at: '2026-09-15T00:00:00Z', message: 'Awarded to ABC Contracting' }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected ${url}`);
  };
  try {
    const response = await worker.fetch(new Request('https://app.test/api/public/stats'), {
      SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role'
    });
    const body = await response.json();
    const blob = JSON.stringify(body);
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(blob.includes('ABC Contracting'), false);
    assert.equal(blob.includes('secret-vendor'), false);
    assert.equal(body.awardsFeed[0].category, 'MEP');
    assert.equal(body.activity[0].event, 'A job was awarded');
  } finally {
    globalThis.fetch = previous;
  }
});

test('public vendor directory omits contact details', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/rest/v1/vendor_profiles')) {
      return new Response(JSON.stringify([{
        company_name: 'Live Vendor LLC',
        trading_name: 'Live Vendor',
        categories: ['MEP'],
        emirate: 'Dubai',
        status: 'verified',
        contact_email: 'hidden@test.invalid',
        phone: '+971500000000'
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected ${url}`);
  };
  try {
    const response = await worker.fetch(new Request('https://app.test/api/public/vendors'), {
      SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role'
    });
    const body = await response.json();
    const blob = JSON.stringify(body);
    assert.equal(response.status, 200);
    assert.equal(body.vendors[0].company_name, 'Live Vendor LLC');
    assert.equal(blob.includes('hidden@test.invalid'), false);
    assert.equal(blob.includes('+971500000000'), false);
  } finally {
    globalThis.fetch = previous;
  }
});
