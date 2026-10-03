import test from 'node:test';
import assert from 'node:assert/strict';
import { handleNative } from './cloudflare-native.js';

const digest = async token => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('hex');
function sessionDatabase(tokenHash) {
  const sessions = new Set([tokenHash]);
  return {
    sessions,
    prepare(sql) {
      return { bind(hash) {
        return {
          async first() {
            assert.match(sql, /FROM sessions s JOIN users/);
            return sessions.has(hash) ? { id: 'client-1', email: 'client@example.test', role: 'client', verified_at: '2026-01-01' } : null;
          },
          async run() {
            if(sql.startsWith('INSERT INTO audit_log'))return {meta:{changes:1}};
            assert.match(sql, /^DELETE FROM sessions WHERE token_hash=/);
            return { meta: { changes: Number(sessions.delete(hash)) } };
          }
        };
      } };
    }
  };
}

for (const transport of ['cookie', 'bearer']) {
  test(`native logout revokes the ${transport} session on the server`, async () => {
    const token = 'disposable-test-session';
    const db = sessionDatabase(await digest(token));
    const headers = transport === 'cookie' ? { Cookie: `up_session=${token}`, Origin: 'https://app.test' } : { Authorization: `Bearer ${token}` };
    const me = () => handleNative(new Request('https://app.test/api/native/auth/me', { headers }), { URBAN_PROCURE_DB: db });
    assert.equal((await me()).status, 200);
    const response = await handleNative(new Request('https://app.test/api/native/auth/logout', { method: 'POST', headers }), { URBAN_PROCURE_DB: db });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
    assert.equal((await me()).status, 401);
    assert.equal(db.sessions.size, 0);
  });
}

for (const headers of [
  { Cookie: 'up_session=test', Origin: 'https://outside.test' },
  { Cookie: 'up_session=test', 'Sec-Fetch-Site': 'cross-site' },
  { Cookie: 'up_session=test', Origin: 'null' }
]) {
  test(`native cookie mutation denies cross-site metadata ${JSON.stringify(headers)}`, async () => {
    const response = await handleNative(new Request('https://app.test/api/native/auth/logout', { method: 'POST', headers }), {
      URBAN_PROCURE_DB: { prepare() { throw new Error('Denied requests must not touch database sessions'); } }
    });
    assert.equal(response.status, 403);
  });
}

test('a similarly named cookie cannot be treated as the native session', async () => {
  const response = await handleNative(new Request('https://app.test/api/native/auth/me', { headers: { Cookie: 'fake_up_session=attacker' } }), {
    URBAN_PROCURE_DB: { prepare() { throw new Error('No session cookie supplied'); } }
  });
  assert.equal(response.status, 401);
});
