import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleNative} from './cloudflare-native.js';
import {verifyPassword} from './passwords.js';
function database(){
  const sql=new DatabaseSync(':memory:');
  for(const path of ['0001_initial.sql','0002_public_upload.sql','0003_native_production_guards.sql'])sql.exec(readFileSync(new URL('../d1/migrations/'+path,import.meta.url),'utf8'));
  const db={prepare(text){let args=[];return {bind(...values){args=values;return this},async first(){return sql.prepare(text).get(...args)||null},async run(){return {meta:sql.prepare(text).run(...args)}},async all(){return {results:sql.prepare(text).all(...args)}},execute(){return {meta:sql.prepare(text).run(...args)}}}},async batch(statements){sql.exec('BEGIN');try{const results=statements.map(s=>s.execute());sql.exec('COMMIT');return results}catch(e){sql.exec('ROLLBACK');throw e}}};
  return {sql,db};
}
for(const purpose of ['verify','reset'])test(`${purpose} token authorizes only one concurrent request`,async()=>{
  const {sql,db}=database();
  const token='one-use-token';
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');
  sql.prepare('INSERT INTO users(id,email,password_hash,password_salt,role) VALUES(?,?,?,?,?)').run('u','account@example.test','old','salt','client');
  sql.prepare('INSERT INTO auth_tokens(id,user_id,token_hash,purpose,expires_at) VALUES(?,?,?,?,?)').run('t','u',hash,purpose,'2099-01-01T00:00:00Z');
  sql.prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)').run('s','u','session','2099-01-01T00:00:00Z');
  const request=password=>new Request(`https://app.test/api/native/auth/${purpose==='verify'?'verify':'reset/confirm'}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,password})});
  const passwords=['first long new password','second long new password'];
  const responses=await Promise.all(passwords.map(p=>handleNative(request(p),{URBAN_PROCURE_DB:db})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,400]);
  if(purpose==='reset'){
    const row=sql.prepare('SELECT * FROM users').get();
    assert.equal((await verifyPassword(passwords[responses.findIndex(r=>r.status===200)],row.password_salt,row.password_hash)).valid,true);
    assert.equal(sql.prepare('SELECT count(*) AS total FROM sessions').get().total,0);
  }
  assert.equal((await handleNative(request(passwords[0]),{URBAN_PROCURE_DB:db})).status,400);
  sql.close();
});
