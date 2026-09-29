import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoIdentityLeak, sanitizeIdentity, scanIdentityLeakage } from './identity-scan.js';

test('detects email and phone leakage', () => {
  const scan = scanIdentityLeakage({ scope: 'Call +971 50 111 2222 or write owner@acme.example' });
  assert.equal(scan.leaked, true);
  assert.ok(scan.hits.some((hit) => hit.type === 'email'));
});

test('sanitize strips identity keys and contact strings', () => {
  const clean = sanitizeIdentity({
    title: 'HVAC works',
    clientEmail: 'hidden@client.example',
    storage_path: 'secret/path',
    scope: 'Company: Hidden LLC email hidden@client.example',
  });
  assert.equal(clean.title, 'HVAC works');
  assert.equal('clientEmail' in clean, false);
  assert.equal('storage_path' in clean, false);
  assert.equal(String(clean.scope).includes('hidden@client.example'), false);
});

test('assertNoIdentityLeak fails closed', () => {
  assert.throws(() => assertNoIdentityLeak('Contact procurement@secret.example'), /Identity leakage/);
});
