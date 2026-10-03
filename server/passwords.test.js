import test from 'node:test';
import assert from 'node:assert/strict';
import {passwordHash, verifyPassword} from './passwords.js';
test('password KDF preserves exact characters and separates salts', async () => {
  const password='  correct horse battery staple  ';
  const stored=await passwordHash(password,'salt-one');
  assert.match(stored,/^scrypt\$32768\$8\$3\$/);
  assert.equal((await verifyPassword(password,'salt-one',stored)).valid,true);
  assert.equal((await verifyPassword(password.trim(),'salt-one',stored)).valid,false);
  assert.equal((await verifyPassword(password,'salt-two',stored)).valid,false);
});
test('legacy accounts authenticate for upgrade and malformed versions fail closed',async()=>{
  const password='existing account password';
  const stored=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`urban-procures-native-v1:salt:${password}`))).toString('hex');
  assert.deepEqual(await verifyPassword(password,'salt',stored),{valid:true,upgrade:true});
  assert.equal((await verifyPassword('wrong','salt',stored)).valid,false);
  assert.equal((await verifyPassword(password,'salt','pbkdf2-sha256$1$abc')).valid,false);
});
