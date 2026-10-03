import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleNative} from './cloudflare-native.js';
import {verifyPassword} from './passwords.js';
function database(){
  const sql=new DatabaseSync(':memory:');
  for(const path of ['0001_initial.sql','0002_public_upload.sql','0003_native_production_guards.sql','0004_public_owners.sql'])sql.exec(readFileSync(new URL('../d1/migrations/'+path,import.meta.url),'utf8'));
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
test('legacy login upgrades the password and creates a session guarded by current credentials',async()=>{
  const {sql,db}=database();
  const password='legacy account password';
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`urban-procures-native-v1:salt:${password}`))).toString('hex');
  sql.prepare('INSERT INTO users(id,email,password_hash,password_salt,role,verified_at) VALUES(?,?,?,?,?,?)').run('u','legacy@example.test',hash,'salt','client','2026-01-01');
  const request=()=>new Request('https://app.test/api/native/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'legacy@example.test',password})});
  assert.equal((await handleNative(request(),{URBAN_PROCURE_DB:db})).status,200);
  assert.match(sql.prepare('SELECT password_hash FROM users').get().password_hash,/^scrypt\$/);
  assert.equal(sql.prepare('SELECT count(*) AS total FROM sessions').get().total,1);
  const prepare=db.prepare;
  db.prepare=text=>{if(text.startsWith('INSERT INTO sessions'))sql.prepare("UPDATE users SET password_hash='changed-by-reset'").run();return prepare(text)};
  assert.equal((await handleNative(request(),{URBAN_PROCURE_DB:db})).status,401);
  assert.equal(sql.prepare('SELECT count(*) AS total FROM sessions').get().total,1);
  sql.close();
});
test('public owner access is scoped and only owner confirmation releases contacts',async()=>{
  const {sql,db}=database();
  const token='public-owner-access';
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');
  sql.exec("INSERT INTO users(id,email,password_hash,password_salt,role) VALUES('owner','owner@example.test','unused','salt','client'),('vendor','vendor@example.test','unused','salt','vendor'); INSERT INTO companies(id,owner_user_id,role,company_name,contact_name,contact_email) VALUES('v','vendor','vendor','Vendor Identity','Vendor','vendor@example.test'); INSERT INTO public_requests(id,reference,name,phone,email,location,category,title,scope) VALUES('public','PUB-1','Owner Name','1234','owner@example.test','Private site','Waterproofing','Roof repair','Repair membrane'); INSERT INTO rfqs(id,reference,public_request_id,title,category,sanitized_scope,original_scope,status) VALUES('rfq','RFQ-1','public','Roof repair','Waterproofing','Repair membrane','Private scope','quoting'),('other','RFQ-2',NULL,'Other roof','Waterproofing','Other membrane','Other scope','quoting'); INSERT INTO quotations(id,rfq_id,vendor_company_id,amount_fils) VALUES('quote','rfq','v',1000000);");
  sql.prepare('INSERT INTO public_owners(request_id,user_id,token_hash,expires_at) VALUES(?,?,?,?)').run('public','owner',hash,'2099-01-01T00:00:00Z');
  const request=(path,body,access=token)=>new Request('https://app.test/api/native/rfqs/'+path,{method:body?'POST':'GET',headers:{'X-Owner-Token':access,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const env={URBAN_PROCURE_DB:db};
  assert.equal((await handleNative(request('other'),env)).status,403);
  assert.equal((await handleNative(request('rfq',null,'wrong'),env)).status,401);
  let detail=await (await handleNative(request('rfq'),env)).json();
  assert.equal(detail.rfq.quotations[0].vendor,undefined);
  const award=await handleNative(request('rfq/award',{quotation_id:'quote'}),env);
  assert.equal(award.status,201);
  assert.equal((await award.json()).service_charge_aed,500);
  detail=await (await handleNative(request('rfq'),env)).json();
  assert.equal(detail.rfq.quotations[0].vendor.company_name,'Vendor Identity');
  assert.equal((await handleNative(request('rfq/award',{quotation_id:'quote'}),env)).status,403);
  sql.prepare("UPDATE public_owners SET expires_at='2000-01-01T00:00:00Z'").run();
  assert.equal((await handleNative(request('rfq'),env)).status,401);
  sql.close();
});
