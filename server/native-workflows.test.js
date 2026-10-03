import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {handleNative} from './cloudflare-native.js';
import {passwordHash} from './passwords.js';

function fixture(){
  const sql=new DatabaseSync(':memory:');
  const dir=new URL('../d1/migrations/',import.meta.url);
  for(const file of readdirSync(dir).filter(name=>name.endsWith('.sql')).sort())sql.exec(readFileSync(new URL(file,dir),'utf8'));
  const db={prepare(text){let values=[];return {bind(...args){values=args;return this},async first(){return sql.prepare(text).get(...values)||null},async all(){return {results:sql.prepare(text).all(...values)}},async run(){return this.execute()},execute(){return {meta:sql.prepare(text).run(...values)}}}},async batch(statements){sql.exec('BEGIN');try{const results=statements.map(s=>s.execute());sql.exec('COMMIT');return results}catch(error){sql.exec('ROLLBACK');throw error}}};
  const objects=new Map(),bucket={async put(key,value){objects.set(key,typeof value==='string'?new TextEncoder().encode(value):value)},async get(key){return objects.has(key)?{body:objects.get(key)}:null},async delete(key){objects.delete(key)}};
  const env={URBAN_PROCURE_DB:db,URBAN_PROCURE_RFQ_DOCUMENTS:bucket,URBAN_PROCURE_QUOTE_DOCUMENTS:bucket,NATIVE_EMAIL_KEY:'34'.repeat(32),TURNSTILE_SECRET:'fixture-only',RATE_LIMIT_SALT:'fixture-only'};
  async function api(path,{body,cookie,method=body?'POST':'GET',status=200,headers={}}={}){
    const response=await handleNative(new Request('https://app.test/api/native/'+path,{method,headers:{Origin:'https://app.test',...(cookie?{Cookie:cookie}:{}),...(!(body instanceof FormData)?{'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{body:body instanceof FormData?body:JSON.stringify(body)}:{})}),env);
    assert.equal(response.status,status,`${path}: ${await response.clone().text()}`);
    return {response,data:response.headers.get('Content-Type')?.includes('json')?await response.json():null};
  }
  async function mailToken(address){
    const job=sql.prepare('SELECT payload FROM jobs j JOIN email_log e ON e.id=j.id WHERE e.recipient=? ORDER BY e.rowid DESC LIMIT 1').get(address);
    const payload=JSON.parse(job.payload),key=await crypto.subtle.importKey('raw',Buffer.from(env.NATIVE_EMAIL_KEY,'hex'),{name:'AES-GCM'},false,['decrypt']);
    const message=JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(payload.iv,'base64')},key,Buffer.from(payload.data,'base64'))));
    return new URL(message.body).searchParams.get('token');
  }
  async function account(role){
    const email=role+'@example.test',password='Disposable account password!';
    const terms=(await api('public/terms/vendor')).data;
    await api('auth/register',{body:{role,email,password,company_name:role+' Company',contact_name:role+' Person',phone:'+971501234567',accept_vendor_terms:role==='vendor',terms_version:terms.version,terms_hash:terms.agreement_hash},status:201});
    const token=await mailToken(email);await api('auth/verify',{body:{token}});await api('auth/verify',{body:{token},status:400});
    const login=await api('auth/login',{body:{email,password}});
    return {email,password,cookie:login.response.headers.get('Set-Cookie').split(';')[0],id:login.data.user.id,company:sql.prepare('SELECT id FROM companies WHERE owner_user_id=?').get(login.data.user.id).id};
  }
  async function admin(){
    sql.prepare('INSERT INTO users(id,email,password_hash,password_salt,role,verified_at) VALUES(?,?,?,?,?,?)').run('admin','admin@example.test',await passwordHash('Admin fixture password','salt'),'salt','admin','2026-01-01');
    return (await api('auth/login',{body:{email:'admin@example.test',password:'Admin fixture password'}})).response.headers.get('Set-Cookie').split(';')[0];
  }
  const upload=(kind,id,name='source.pdf',content='%PDF-1.7\nPrivate document from client Company\n%%EOF')=>{const body=new FormData();body.set('kind',kind);body.set('owner_id',id);body.set('file',new File([content],name,{type:'application/pdf'}));return body};
  return {sql,env,api,account,admin,upload};
}

test('native client, vendor, document review, clarification and concurrent award workflow',async()=>{
  const {sql,env,api,account,admin,upload}=fixture();
  try{
    const client=await account('client'),vendor=await account('vendor'),adminCookie=await admin();
    assert.equal(sql.prepare('SELECT verification_status FROM companies WHERE id=?').get(vendor.company).verification_status,'pending','email proof does not approve a company');
    assert.equal(sql.prepare('SELECT agreement_hash FROM agreement_acceptances WHERE user_id=?').get(vendor.id).agreement_hash.length,64);
    await api('admin/accounts',{cookie:vendor.cookie,status:403});
    await api('auth/register',{body:{role:'admin',email:'attacker@example.test',password:'A long password',company_name:'Attack',contact_name:'Attack'},status:400});
    const rfq=(await api('rfqs',{cookie:client.cookie,body:{title:'Roof membrane repair',category:'Waterproofing',scope:'Original membrane scope',sanitized_scope:'Repair membrane with warranty',location:'Private site address'},status:201})).data.id;
    await api('documents',{cookie:client.cookie,body:upload('rfq',rfq,'spoof.pdf','<html>attack</html>'),status:400});
    const doc=(await api('documents',{cookie:client.cookie,body:upload('rfq',rfq),status:201})).data.id;
    const original=await api('documents/'+doc+'?view=1',{cookie:adminCookie});assert.match(await original.response.text(),/Private document/);
    await api(`admin/rfqs/${rfq}/publish`,{cookie:adminCookie,body:{},status:409});
    await api(`admin/documents/${doc}/review`,{cookie:adminCookie,body:{status:'approved',sanitized_text:'Email contact@example.test'},status:422});
    await api(`admin/documents/${doc}/review`,{cookie:adminCookie,body:{status:'approved',sanitized_text:'Reviewed roof membrane measurements'}});
    await api(`admin/rfqs/${rfq}/publish`,{cookie:adminCookie,body:{}});
    await api(`admin/rfqs/${rfq}/invite`,{cookie:adminCookie,body:{vendor_company_id:vendor.company},status:409});
    await api(`admin/companies/${vendor.company}/verify`,{cookie:adminCookie,body:{status:'verified'}});
    await api(`admin/rfqs/${rfq}/invite`,{cookie:adminCookie,body:{vendor_company_id:vendor.company}});
    assert.equal((await api(`admin/rfqs/${rfq}/invite`,{cookie:adminCookie,body:{vendor_company_id:vendor.company}})).data.alreadyInvited,true);
    const safe=(await api('rfqs/'+rfq,{cookie:vendor.cookie})).data.rfq;assert.equal(safe.client,undefined);assert.equal(safe.location,undefined);
    await api('documents/'+doc,{cookie:vendor.cookie,status:403});
    assert.match(await (await api('documents/'+doc+'?sanitized=1',{cookie:vendor.cookie})).response.text(),/Reviewed roof/);
    await api(`rfqs/${rfq}/clarifications`,{cookie:vendor.cookie,body:{message:'Contact vendor@example.test'},status:422});
    await api(`rfqs/${rfq}/clarifications`,{cookie:vendor.cookie,body:{message:'Is access available during normal working hours?'},status:201});
    await api(`rfqs/${rfq}/clarifications`,{cookie:client.cookie,body:{message:'Access is available during the day.'},status:201});
    assert.equal((await api(`rfqs/${rfq}/clarifications`,{cookie:vendor.cookie})).data.clarifications.length,2);
    const quote=(await api(`rfqs/${rfq}/quotations`,{cookie:vendor.cookie,body:{amount_aed:10000,sanitized_notes:'Includes membrane and warranty'},status:201})).data.id;
    const quoteDoc=(await api('documents',{cookie:vendor.cookie,body:upload('quotation',quote),status:201})).data.id;
    assert.equal((await api('rfqs/'+rfq,{cookie:client.cookie})).data.rfq.quotations[0].vendor,undefined);
    await api(`rfqs/${rfq}/award`,{cookie:vendor.cookie,body:{quotation_id:quote},status:403});
    await api(`rfqs/${rfq}/award`,{cookie:adminCookie,body:{quotation_id:quote},status:403});
    await api(`rfqs/${rfq}/award`,{cookie:client.cookie,body:{quotation_id:quote},status:409});
    await api(`admin/documents/${quoteDoc}/review`,{cookie:adminCookie,body:{status:'approved',sanitized_text:'Membrane repair offer and warranty'}});
    const awards=await Promise.all([201,200].map(async()=>{
      const response=await handleNative(new Request(`https://app.test/api/native/rfqs/${rfq}/award`,{method:'POST',headers:{Cookie:client.cookie,Origin:'https://app.test','Content-Type':'application/json'},body:JSON.stringify({quotation_id:quote})}),env);
      return {status:response.status,data:await response.json()};
    }));
    assert.deepEqual(awards.map(a=>a.status).sort(),[200,201]);assert.equal(awards[0].data.award_id,awards[1].data.award_id);assert.equal(awards[0].data.service_charge_aed,500);
    assert.equal(sql.prepare('SELECT count(*) AS n FROM awards').get().n,1);
    assert.equal((await api('rfqs/'+rfq,{cookie:client.cookie})).data.rfq.quotations[0].vendor.contact_email,vendor.email);
    assert.equal((await api('rfqs/'+rfq,{cookie:vendor.cookie})).data.rfq.client.contact_email,client.email);
    await api('auth/logout',{cookie:client.cookie,body:{}});await api('workspace',{cookie:client.cookie,status:401});
  }finally{sql.close()}
});

test('native public site visit requires verified payment and completed inspection',async()=>{
  const {sql,env,api,admin}=fixture(),original=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({success:true,hostname:'app.test',action:'public_rfq'});
  try{
    const adminCookie=await admin();
    const request=(await api('public/requests',{body:{name:'Property owner',phone:'+971505555555',email:'owner@example.test',location:'Private villa',category:'Waterproofing',title:'Roof waterproofing',scope:'Replace membrane',site_visit:true,turnstile_token:'test-token'},status:201})).data;
    assert.equal(request.site_visit.amount_aed,100);
    const visit=sql.prepare('SELECT id FROM site_visits WHERE request_id=?').get(request.id).id;
    const create=()=>api('rfqs',{cookie:adminCookie,body:{public_request_id:request.id,sanitized_scope:'Replace membrane'},status:409});await create();
    await api('admin/site-visits/'+visit,{cookie:adminCookie,method:'PATCH',body:{status:'completed'},status:409});
    await api('admin/site-visits/'+visit,{cookie:adminCookie,method:'PATCH',body:{payment_status:'paid'},status:400});
    await api('admin/site-visits/'+visit,{cookie:adminCookie,method:'PATCH',body:{payment_status:'paid',payment_reference:'fixture-receipt'}});await create();
    await api('admin/site-visits/'+visit,{cookie:adminCookie,method:'PATCH',body:{status:'completed',inspection_notes:'Roof inspected'}});
    await api('rfqs',{cookie:adminCookie,body:{public_request_id:request.id,sanitized_scope:'Replace membrane'},status:201});await create();
    globalThis.fetch=async()=>Response.json({success:true,hostname:'another.test',action:'public_rfq'});
    await api('public/requests',{body:{turnstile_token:'wrong-host'},status:403});
  }finally{globalThis.fetch=original;sql.close()}
});
