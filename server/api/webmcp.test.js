import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWebMcp } from './webmcp.js';

test('WebMCP manifest exposes only safe high-level actions', async () => {
  const response = await handleWebMcp(new Request('https://app.test/.well-known/webmcp.json'), {});
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.actions.map((action) => action.name), ['get_desk']);
  assert.equal(body.security.privateDocumentsExcluded, true);
  assert.equal(JSON.stringify(body).includes('SERVICE_ROLE'), false);
});

test('WebMCP actions require an authenticated session', async () => {
  const response = await handleWebMcp(new Request('https://app.test/api/webmcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get_desk' })
  }), {});
  assert.equal(response.status, 401);
});

test('WebMCP rejects non-allow-listed actions after authentication', async () => {
  const response = await handleWebMcp(new Request('https://app.test/api/webmcp', {
    method: 'POST',
    headers: { Authorization: 'Bearer test:admin:owner-1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'award_rfq' })
  }), { PROCUREMENT_TEST_AUTH: '1' });
  assert.equal(response.status, 400);
});
