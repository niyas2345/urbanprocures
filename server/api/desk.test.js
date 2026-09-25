import test from 'node:test';
import assert from 'node:assert/strict';
import { handleDeskApi } from './desk.js';

const env = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role', PROCUREMENT_TEST_AUTH: '1' };

function request(role, userId, path, { method = 'GET', body } = {}) {
  return new Request(`https://app.test${path}`, {
    method,
    headers: { Authorization: `Bearer test:${role}:${userId}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('desk rejects client attempts to use admin status controls', async () => {
  const response = await handleDeskApi(request('client', 'c1', '/api/desk/rfqs/RFQ-1/status', { method: 'POST', body: { status: 'Quoting' } }), env);
  assert.equal(response.status, 403);
});

test('vendor bootstrap exposes only invited sanitized RFQ data', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/procurement_notifications?')) return json([]);
    if (url.includes('/vendor_profiles?')) return json([{ id: 'v1', company_name: 'Private Vendor', status: 'verified' }]);
    if (url.includes('/rfq_invitations?')) return json([{ rfq_id: 'RFQ-1', vendor_user_id: 'v1', status: 'invited' }]);
    if (url.includes('/rfqs?')) return json([{ id: 'RFQ-1', title: 'Server title', category: 'MEP', status: 'Quoting', sanitized_payload: { title: 'Sanitized RFQ', scope: 'Install equipment' }, client_id: 'c1', location: 'Client HQ', scope: 'Private scope' }]);
    if (url.includes('/quotations?')) return json([]);
    if (url.includes('/awards?')) return json([]);
    if (url.includes('/rfq_clarifications?')) return json([]);
    throw new Error(`unexpected ${url}`);
  };
  try {
    const response = await handleDeskApi(request('vendor', 'v1', '/api/desk/bootstrap'), env);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.rfqs[0].title, 'Sanitized RFQ');
    assert.equal(body.rfqs[0].scope, 'Install equipment');
    assert.equal(JSON.stringify(body).includes('client_id'), false);
    assert.equal(JSON.stringify(body).includes('Client HQ'), false);
    assert.equal(JSON.stringify(body).includes('Private scope'), false);
    assert.equal(JSON.stringify(body).includes('storage_'), false);
  } finally { globalThis.fetch = previous; }
});

test('client bootstrap keeps vendor identity anonymous before award', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/procurement_notifications?')) return json([]);
    if (url.includes('/client_profiles?')) return json([{ id: 'c1', company_name: 'Client One' }]);
    if (url.includes('/rfqs?')) return json([{ id: 'RFQ-1', client_id: 'c1', status: 'Comparing' }]);
    if (url.includes('/quotations?')) return json([{ id: 'q1', rfq_id: 'RFQ-1', vendor_user_id: 'vendor-secret-id', total: 100 }]);
    if (url.includes('/awards?')) return json([]);
    if (url.includes('/attachments?') || url.includes('/rfq_documents?')) return json([]);
    if (url.includes('/rfq_clarifications?')) return json([]);
    throw new Error(`unexpected ${url}`);
  };
  try {
    const response = await handleDeskApi(request('client', 'c1', '/api/desk/bootstrap'), env);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.quotations[0].vendor_label, 'Vendor A');
    assert.equal(body.quotations[0].vendor_id, undefined);
    assert.equal(JSON.stringify(body).includes('vendor-secret-id'), false);
  } finally { globalThis.fetch = previous; }
});

test('vendor cannot download an original client RFQ document', async () => {
  const previous = globalThis.fetch; let storageCalled = false;
  globalThis.fetch = async (url) => {
    if (url.includes('/rfq_documents?')) return json([{ id: 'doc1', rfq_id: 'RFQ-1', storage_bucket: 'rfq-documents', storage_path: 'c1/private.pdf' }]);
    if (url.includes('/rfqs?')) return json([{ id: 'RFQ-1', client_id: 'c1' }]);
    if (url.includes('/storage/')) { storageCalled = true; return json({}); }
    throw new Error(`unexpected ${url}`);
  };
  try {
    const response = await handleDeskApi(request('vendor', 'v1', '/api/desk/documents/rfq/doc1'), env);
    assert.equal(response.status, 403);
    assert.equal(storageCalled, false);
  } finally { globalThis.fetch = previous; }
});

test('client cannot download an original vendor quotation', async () => {
  const previous = globalThis.fetch; let storageCalled = false;
  globalThis.fetch = async (url) => {
    if (url.includes('/quote_documents?')) return json([{ id: 'doc1', rfq_id: 'RFQ-1', vendor_user_id: 'v1', storage_bucket: 'quote-documents', storage_key: 'v1/private.pdf' }]);
    if (url.includes('/storage/')) { storageCalled = true; return json({}); }
    throw new Error(`unexpected ${url}`);
  };
  try {
    const response = await handleDeskApi(request('client', 'c1', '/api/desk/documents/quote/doc1'), env);
    assert.equal(response.status, 403);
    assert.equal(storageCalled, false);
  } finally { globalThis.fetch = previous; }
});

test('client can download own original RFQ document from private R2 binding', async () => {
  const previous = globalThis.fetch; let storageCalled = false;
  globalThis.fetch = async (url) => {
    if (url.includes('/rfq_documents?')) return json([{ id: 'doc1', rfq_id: 'RFQ-1', original_filename: 'scope.txt', mime_type: 'text/plain', storage_bucket: 'rfq-documents', storage_path: 'c1/scope.txt' }]);
    if (url.includes('/rfqs?')) return json([{ id: 'RFQ-1', client_id: 'c1' }]);
    if (url.includes('/storage/')) { storageCalled = true; return json({}); }
    if (url.includes('/procurement_audit_events')) return json([{ id: 'audit-1' }]);
    throw new Error(`unexpected ${url}`);
  };
  try {
    const response = await handleDeskApi(request('client', 'c1', '/api/desk/documents/rfq/doc1'), {
      ...env,
      URBAN_PROCURE_RFQ_DOCUMENTS: {
        async get(path) {
          assert.equal(path, 'c1/scope.txt');
          return new Response('scope', { headers: { 'Content-Type': 'text/plain' } });
        }
      }
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'scope');
    assert.equal(storageCalled, false);
  } finally { globalThis.fetch = previous; }
});

test('client cannot award another client RFQ', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/rfqs?')) return json([{ id: 'RFQ-1', client_id: 'c1', status: 'Comparing' }]);
    throw new Error(`unexpected ${url}`);
  };
  try {
    const response = await handleDeskApi(request('client', 'c2', '/api/desk/rfqs/RFQ-1/award', { method: 'POST', body: { quotation_id: 'q1' } }), env);
    assert.equal(response.status, 403);
  } finally { globalThis.fetch = previous; }
});

test('admin cannot award a quotation on behalf of a client', async () => {
  const response = await handleDeskApi(request('admin', 'a1', '/api/desk/rfqs/RFQ-1/award', { method: 'POST', body: { quotation_id: 'q1' } }), env);
  assert.equal(response.status, 403);
});

test('description-only RFQ with no documents becomes sanitizable from scope text', async () => {
  const previous = globalThis.fetch; let patchedReady = null;
  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    if (url.includes('/document_processing_jobs?')) return json([]);
    if (url.includes('/rfq_documents?')) return json([]);
    if (url.includes('/client_profiles?')) return json([{ company_name: 'Acme Development LLC', contact_name: 'Ahmed Ali', phone: '+971501234567', whatsapp: '+971501234567' }]);
    if (url.includes('/rfqs?')) {
      if (method === 'PATCH') { patchedReady = JSON.parse(init.body).sanitized_ready; return json([{}]); }
      return json([{ id: 'RFQ-1', client_id: 'c1', scope: 'Supply and install MEP first-fix and second-fix works for a residential lobby.', category: 'MEP', title: 'MEP lobby fit-out', emirate: 'Dubai', status: 'Submitted' }]);
    }
    if (url.includes('/procurement_audit_events')) return json([{}]);
    throw new Error(`unexpected ${method} ${url}`);
  };
  try {
    const response = await handleDeskApi(request('client', 'c1', '/api/desk/rfqs/RFQ-1/process', { method: 'POST', body: {} }), env);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.sanitized, true);
    assert.equal(patchedReady, true);
    assert.equal(JSON.stringify(body).includes('Acme Development LLC'), false);
    assert.equal(JSON.stringify(body).includes('+971501234567'), false);
  } finally { globalThis.fetch = previous; }
});

test('description-only RFQ fails closed when client identity leaks into scope text', async () => {
  const previous = globalThis.fetch; let patchedReady = null;
  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    if (url.includes('/document_processing_jobs?')) return json([]);
    if (url.includes('/rfq_documents?')) return json([]);
    if (url.includes('/client_profiles?')) return json([{ company_name: 'Acme Development LLC', contact_name: 'Ahmed Ali', phone: '+971501234567', whatsapp: '+971501234567' }]);
    if (url.includes('/rfqs?')) {
      if (method === 'PATCH') { patchedReady = JSON.parse(init.body).sanitized_ready; return json([{}]); }
      return json([{ id: 'RFQ-1', client_id: 'c1', scope: 'Carry out works for Acme Development LLC at the Marina lobby, contact Ahmed Ali +971501234567.', category: 'MEP', title: 'MEP lobby fit-out', emirate: 'Dubai', status: 'Submitted' }]);
    }
    if (url.includes('/procurement_audit_events')) return json([{}]);
    throw new Error(`unexpected ${method} ${url}`);
  };
  try {
    const response = await handleDeskApi(request('client', 'c1', '/api/desk/rfqs/RFQ-1/process', { method: 'POST', body: {} }), env);
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.error, 'review_required');
    assert.equal(patchedReady, false);
  } finally { globalThis.fetch = previous; }
});

test('only admin can issue a work pack', async () => {
  const response = await handleDeskApi(request('client', 'c1', '/api/desk/rfqs/RFQ-1/issue', { method: 'POST', body: {} }), env);
  assert.equal(response.status, 403);
});

test('admin issue work pack publishes and invites matching vendors', async () => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: (init.method || 'GET').toUpperCase(), body: init.body });
    if (url.includes('/vendor_profiles?')) return json([{ id: 'v1', company_name: 'MEP Co', status: 'verified', categories: ['MEP'], emirate: 'Dubai', capacity: 10 }]);
    if (url.includes('/client_profiles?')) return json([]);
    if (url.includes('/rfq_invitations')) return json([{ rfq_id: 'RFQ-1', vendor_user_id: 'v1' }]);
    if (url.includes('/procurement_notifications') || url.includes('/procurement_audit_events')) return json([{}]);
    if (url.includes('/rfqs?')) {
      if ((init.method || 'GET').toUpperCase() === 'PATCH') return json([{}]);
      return json([{ id: 'RFQ-1', title: 'Lobby MEP', category: 'MEP', emirate: 'Dubai', scope: 'Install FCUs on the lobby floor.', status: 'Under Review', sanitized_ready: false }]);
    }
    throw new Error(`unexpected ${url}`);
  };
  try {
    const response = await handleDeskApi(request('admin', 'a1', '/api/desk/rfqs/RFQ-1/issue', { method: 'POST', body: {} }), env);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.invited, 1);
    assert.equal(calls.some((c) => c.url.includes('/rfq_invitations') && c.method === 'POST'), true);
  } finally { globalThis.fetch = previous; }
});
