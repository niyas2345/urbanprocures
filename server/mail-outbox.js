import {ZohoEmailProvider} from './ai/outreach-provider.js';
const encode=new TextEncoder(),decode=new TextDecoder();
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
const bytes=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
async function key(env){
  if(!/^[a-f0-9]{64}$/.test(env.NATIVE_EMAIL_KEY||''))throw Error('Email outbox key unavailable');
  return crypto.subtle.importKey('raw',Uint8Array.from(env.NATIVE_EMAIL_KEY.match(/../g),x=>parseInt(x,16)),{name:'AES-GCM'},false,['encrypt','decrypt']);
}
async function seal(env,value){const iv=crypto.getRandomValues(new Uint8Array(12));return JSON.stringify({iv:b64(iv),data:b64(await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(env),encode.encode(JSON.stringify(value))))});}
async function open(env,payload){const value=JSON.parse(payload);return JSON.parse(decode.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(value.iv)},await key(env),bytes(value.data))));}
const provider=env=>new ZohoEmailProvider({env:{ZOHO_CLIENT_ID:env.ZOHO_CLIENT_ID,ZOHO_CLIENT_SECRET:env.ZOHO_CLIENT_SECRET,ZOHO_REFRESH_TOKEN:env.ZOHO_REFRESH_TOKEN,ZOHO_ACCOUNT_ID:env.ZOHO_ACCOUNT_ID,ZOHO_DC:env.ZOHO_DC,ZOHO_FROM_EMAIL:env.ZOHO_FROM_EMAIL}});
export async function queueEmail(env,to,kind,subject,body){
  const id=crypto.randomUUID(),now=new Date().toISOString();
  const ttl=kind==='password_reset'?3600000:kind==='verification'?86400000:7*86400000;
  const payload=await seal(env,{to,kind,subject,body,expires:new Date(Date.now()+ttl).toISOString()});
  await env.URBAN_PROCURE_DB.batch([
    env.URBAN_PROCURE_DB.prepare("INSERT INTO jobs(id,kind,payload,next_at) VALUES(?,'transactional_email',?,?)").bind(id,payload,now),
    env.URBAN_PROCURE_DB.prepare("INSERT INTO email_log(id,recipient,kind,status) VALUES(?,?,?,'queued')").bind(id,to,kind)
  ]);
  return sendJob(env,id);
}
async function sendJob(env,id){
  const db=env.URBAN_PROCURE_DB,now=new Date().toISOString();
  const job=await db.prepare("UPDATE jobs SET status='sending',attempts=attempts+1,next_at=? WHERE id=? AND kind='transactional_email' AND status IN ('queued','sending') AND next_at<=? RETURNING *").bind(new Date(Date.now()+10*60000).toISOString(),id,now).first();
  if(!job)return {success:false,reason:'Delivery is already processing'};
  let result,expired=false;
  try{
    const message=await open(env,job.payload);expired=message.expires<=now;
    if(expired)result={success:false,reason:'Message expired'};
    else {const mail=provider(env);result=await mail.ready()?await mail.sendEmail(message):{success:false,reason:'Zoho is not configured'};}
  }catch(error){result={success:false,reason:error?.name||'Delivery failed'};}
  const dead=expired||job.attempts>=7,success=result.success===true;
  await db.batch([
    db.prepare('UPDATE jobs SET status=?,payload=?,next_at=? WHERE id=?').bind(success?'completed':dead?'failed':'queued',success||dead?'{}':job.payload,new Date(Date.now()+Math.min(30,2**job.attempts)*60000).toISOString(),id),
    db.prepare('UPDATE email_log SET status=?,provider_id=?,error_code=? WHERE id=?').bind(success?'sent':dead?'failed':'pending_provider',result.messageId||null,success?null:String(result.reason||'Delivery failed').slice(0,100),id)
  ]);
  return result;
}
export async function processEmailJobs(env){
  const rows=await env.URBAN_PROCURE_DB.prepare("SELECT id FROM jobs WHERE kind='transactional_email' AND status IN ('queued','sending') AND next_at<=? ORDER BY next_at LIMIT 20").bind(new Date().toISOString()).all();
  const deadline=Date.now()+25000;
  let sent=0,processed=0;
  for(const row of rows.results){
    if(Date.now()>=deadline)break;
    if((await sendJob(env,row.id)).success)sent++;
    processed++;
  }
  return {processed,sent};
}
