import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {queueEmail,processEmailJobs} from './mail-outbox.js';
function database(){
  const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../d1/migrations/0001_initial.sql',import.meta.url),'utf8'));
  const db={prepare(text){let values=[];return {bind(...args){values=args;return this},async first(){return sql.prepare(text).get(...values)||null},async all(){return {results:sql.prepare(text).all(...values)}},async run(){return this.execute()},execute(){return {meta:sql.prepare(text).run(...values)}}}},async batch(statements){sql.exec('BEGIN');try{const results=statements.map(s=>s.execute());sql.exec('COMMIT');return results}catch(error){sql.exec('ROLLBACK');throw error}}};
  return {sql,db};
}
test('mail provider failure retains encrypted durable payload and retry wipes delivered secrets',async()=>{
  const {sql,db}=database(),env={URBAN_PROCURE_DB:db,NATIVE_EMAIL_KEY:'12'.repeat(32)};
  const result=await queueEmail(env,'qa@example.test','password_reset','Reset password','private-reset-token');
  assert.equal(result.success,false);
  const job=sql.prepare('SELECT * FROM jobs').get();assert.equal(job.status,'queued');assert.equal(job.attempts,1);assert.equal(job.payload.includes('private-reset-token'),false);
  assert.equal(sql.prepare('SELECT status FROM email_log').get().status,'pending_provider');
  sql.prepare("UPDATE jobs SET next_at='2000-01-01T00:00:00Z'").run();
  Object.assign(env,{ZOHO_CLIENT_ID:'client',ZOHO_CLIENT_SECRET:'secret',ZOHO_REFRESH_TOKEN:'refresh',ZOHO_ACCOUNT_ID:'account'});
  const original=globalThis.fetch;let sends=0;
  globalThis.fetch=async(url,options)=>{
    if(url.includes('/oauth/'))return Response.json({access_token:'access'});
    const body=JSON.parse(options.body);assert.equal(body.content,'private-reset-token');sends++;
    return Response.json({status:{code:200},data:{messageId:'provider-message'}});
  };
  try{
    const results=await Promise.all([processEmailJobs(env),processEmailJobs(env)]);
    assert.equal(results.reduce((sum,row)=>sum+row.sent,0),1);assert.equal(sends,1);
    const saved=sql.prepare('SELECT * FROM jobs').get();assert.equal(saved.status,'completed');assert.equal(saved.payload,'{}');
    assert.equal(sql.prepare('SELECT status FROM email_log').get().status,'sent');
  }finally{globalThis.fetch=original;sql.close();}
});
test('mail retries stop after bounded attempts and retain failure visibility',async()=>{
  const {sql,db}=database(),env={URBAN_PROCURE_DB:db,NATIVE_EMAIL_KEY:'12'.repeat(32)};
  await queueEmail(env,'qa@example.test','verification','Verify','opaque-link');
  sql.prepare("UPDATE jobs SET attempts=6,next_at='2000-01-01T00:00:00Z'").run();
  await processEmailJobs(env);
  const job=sql.prepare('SELECT * FROM jobs').get();assert.equal(job.status,'failed');assert.equal(job.payload,'{}');
  assert.equal(sql.prepare('SELECT status FROM email_log').get().status,'failed');
  assert.equal((await processEmailJobs(env)).processed,0);sql.close();
});
