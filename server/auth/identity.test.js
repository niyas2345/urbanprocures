import test from 'node:test';
import assert from 'node:assert/strict';
import { isRegisteredAdmin, provisionedSignupRole, requireIdentity } from './identity.js';

test('admin role cannot be acquired through public signup', () => {
  assert.equal(provisionedSignupRole('urbanprocures@gmail.com', 'client'), null);
  assert.equal(provisionedSignupRole('other@example.com', 'admin'), null);
});

test('a valid admin token still needs an app_admins grant', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).endsWith('/auth/v1/user')) return Response.json({ id: 'owner-1', email: 'urbanprocures@gmail.com', app_metadata: { role: 'admin' } });
    if (String(url).includes('/rest/v1/app_admins')) return Response.json([]);
    throw new Error('unexpected request');
  };
  try {
    const env = { SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'public', SUPABASE_SERVICE_ROLE_KEY: 'private' };
    assert.equal(await isRegisteredAdmin(env, { id: 'owner-1' }), false);
    const actor = await requireIdentity(new Request('https://app.test/api/desk/bootstrap', { headers: { Authorization: 'Bearer valid-token' } }), env, { roles: ['admin'] });
    assert.equal(actor.status, 403);
  } finally { globalThis.fetch = previous; }
});
