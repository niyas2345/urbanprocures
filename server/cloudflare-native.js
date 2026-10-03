import { calculateVendorServiceCharge } from './commercial/service-fee.js';
import { scanIdentityLeakage } from './ai/identity-scan.js';
import { queueEmail, processEmailJobs } from './mail-outbox.js';
import { ZohoEmailProvider } from './ai/outreach-provider.js';
import { passwordHash, verifyPassword, equalHash } from './passwords.js';
import { validateUpload, validStorageKey } from './native-files.js';
import { rfqAccess } from './native-access.js';
import { RELEASE_COMMIT } from './release.js';
import { inspectOperations } from './native-operations.js';

const json = (data, status=200) => new Response(JSON.stringify(data), {status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const bad = (message,status=400) => json({ok:false,error:message},status);
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const clean = (value,max=1000) => String(value??'').trim().slice(0,max);
const sha = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join('');
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const random = () => b64(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const sessionToken = request => request.headers.get('Cookie')?.match(/(?:^|;\s*)up_session=([^;]+)/)?.[1] || request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];

async function actor(request,env) {
  const ownerToken=request.headers.get('X-Owner-Token');
  if(ownerToken){const owner=await env.URBAN_PROCURE_DB.prepare('SELECT p.request_id,p.user_id AS id,u.email FROM public_owners p JOIN users u ON u.id=p.user_id WHERE p.token_hash=? AND p.expires_at>?').bind(await sha(ownerToken),now()).first();return owner?{...owner,role:'public_owner',public_request_id:owner.request_id}:null;}
  const token=sessionToken(request);
  if(!token)return null;
  const row=await env.URBAN_PROCURE_DB.prepare('SELECT u.id,u.email,u.role,u.verified_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').bind(await sha(token),now()).first();
  return row||null;
}
function requireRole(user,roles) {if(!user)return bad('Authentication required',401);if(!roles.includes(user.role))return bad('Access denied',403);return null;}
async function audit(db,user,kind,entity,event,detail={}) {await db.prepare('INSERT INTO audit_log(id,actor_user_id,entity_kind,entity_id,event,detail) VALUES(?,?,?,?,?,?)').bind(id(),user?.id||null,kind,entity,event,JSON.stringify(detail)).run();}
async function identityTerms(db,rfqId){
  const companies=await db.prepare('SELECT company_name,contact_name,contact_email,phone,trade_license_no FROM companies WHERE id IN (SELECT client_company_id FROM rfqs WHERE id=? UNION SELECT vendor_company_id FROM quotations WHERE rfq_id=?)').bind(rfqId,rfqId).all();
  const owners=await db.prepare('SELECT name,email,phone,location FROM public_requests WHERE id IN (SELECT public_request_id FROM rfqs WHERE id=?)').bind(rfqId).all();
  return [...companies.results,...owners.results].flatMap(row=>Object.values(row));
}
async function pageList(db,request,sql,values=[]){
  const raw=new URL(request.url).searchParams.get('page')||'0';
  if(!/^\d{1,4}$/.test(raw)||Number(raw)>2000){const error=Error('Valid page number required');error.name='InputError';throw error}
  const page=Number(raw),query=sql.replace(/\s+LIMIT\s+\d+\s*$/i,'')+' LIMIT 51 OFFSET '+page*50;
  const prepared=db.prepare(query),rows=await (values.length?prepared.bind(...values):prepared).all();
  return {rows:rows.results.slice(0,50),pagination:{page,pageSize:50,next:rows.results.length>50}};
}
async function email(env,to,kind,subject,body) {
  // Outreach is quota reserved and confirmed synchronously; automatic retries
  // must not deliver after a prospect opts out or after its reservation is released.
  if(kind==='invitation'){
    const provider=new ZohoEmailProvider({env});
    const result=await provider.sendEmail({to,subject,body});
    await env.URBAN_PROCURE_DB.prepare('INSERT INTO email_log(id,recipient,kind,status,provider_id,error_code) VALUES(?,?,?,?,?,?)').bind(id(),to,kind,result.success?'sent':'failed',result.messageId||null,result.success?null:'provider_failure').run();
    return result;
  }
  return queueEmail(env,to,kind,subject,body);
}
function directMailConfigured(env) {
  return Boolean(env.ZOHO_CLIENT_ID&&env.ZOHO_CLIENT_SECRET&&env.ZOHO_REFRESH_TOKEN&&env.ZOHO_ACCOUNT_ID);
}
async function issueSession(db,user) {
  const token=random();const expires=new Date(Date.now()+7*86400000).toISOString();
  const inserted=await db.prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at) SELECT ?,id,?,? FROM users WHERE id=? AND password_hash=?').bind(id(),await sha(token),expires,user.id,user.password_hash).run();
  if(!inserted.meta.changes){const error=new Error('Credentials changed');error.name='AuthChangedError';throw error;}
  return {token,expires};
}
function sessionResponse(user,session,status=200) {
  const out=json({ok:true,user:{id:user.id,email:user.email,role:user.role},role:user.role},status);
  out.headers.set('Set-Cookie',`up_session=${session.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${new Date(session.expires).toUTCString()}`);
  return out;
}
async function verifyTurnstile(token,request,env) {
  if(!env.TURNSTILE_SECRET)return false;
  const body=new URLSearchParams({secret:env.TURNSTILE_SECRET,response:clean(token,2000),remoteip:request.headers.get('CF-Connecting-IP')||''});
  const r=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',body});
  if(!r.ok)return false;
  const result=await r.json();
  const testing=env.APP_ENV==='preview'&&env.TURNSTILE_SECRET==='1x0000000000000000000000000000000AA';
  return result.success===true&&(testing||result.hostname===new URL(request.url).hostname&&result.action==='public_rfq');
}
async function limitAttempts(db,request,env,purpose,maximum,identifier='') {
  const hash=await sha(`${purpose}:${identifier||request.headers.get('CF-Connecting-IP')||'unknown'}:${env.RATE_LIMIT_SALT||'urbanprocures'}`),hour=now().slice(0,13);
  await db.prepare('INSERT OR IGNORE INTO public_rate_limits(client_hash,hour,attempts) VALUES(?,?,0)').bind(hash,hour).run();
  const update=await db.prepare('UPDATE public_rate_limits SET attempts=attempts+1 WHERE client_hash=? AND hour=? AND attempts<?').bind(hash,hour,maximum).run();
  return Boolean(update.meta.changes);
}
async function sendOwnerLink(request,env,rfq) {
  const owner=await env.URBAN_PROCURE_DB.prepare('SELECT id,email FROM public_requests WHERE id=?').bind(rfq.public_request_id).first();
  const address=owner.email.toLowerCase(),salt=random(),uid=id();
  await env.URBAN_PROCURE_DB.prepare('INSERT OR IGNORE INTO users(id,email,password_hash,password_salt,role) VALUES(?,?,?,?,?)').bind(uid,address,await passwordHash(random(),salt),salt,'client').run();
  const account=await env.URBAN_PROCURE_DB.prepare('SELECT id FROM users WHERE email=?').bind(address).first();
  const token=random();
  await env.URBAN_PROCURE_DB.prepare('INSERT INTO public_owners(request_id,user_id,token_hash,expires_at) VALUES(?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at').bind(owner.id,account.id,await sha(token),new Date(Date.now()+7*86400000).toISOString()).run();
  return email(env,address,'owner_access','Review your Urban Procures quotations',`${new URL(request.url).origin}/public-request#rfq=${encodeURIComponent(rfq.id)}&token=${encodeURIComponent(token)}`);
}
async function handle(request,env) {
  const db=env.URBAN_PROCURE_DB;if(!db)return bad('Database unavailable',503);
  const path=new URL(request.url).pathname,method=request.method;
  // Browser cookie sessions must not authorize cross-origin state changes.
  if(!['GET','HEAD','OPTIONS'].includes(method)) {
    const origin=request.headers.get('Origin');
    if(request.headers.get('Sec-Fetch-Site')==='cross-site'||origin&&origin!==new URL(request.url).origin)return bad('Cross-origin request denied',403);
  }
  if(path==='/api/native/internal/email-jobs'&&method==='POST'){
    const credential=request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
    if(!env.NATIVE_JOBS_SECRET||!equalHash(credential,env.NATIVE_JOBS_SECRET))return bad('Access denied',403);
    const processed=await processEmailJobs(env);return json({ok:true,...processed,...await inspectOperations(env)});
  }
  const user=await actor(request,env);
  if(path==='/api/native/public/config'&&method==='GET')return json({ok:true,turnstileSiteKey:env.TURNSTILE_SITE_KEY||'0x4AAAAAAFD42QgkC2tOQXoA'});
  if(path==='/api/native/public/terms/vendor'&&method==='GET'){
    const terms=await db.prepare("SELECT version,agreement_hash FROM agreement_versions WHERE kind='vendor' AND active=1").first();return terms?json({ok:true,...terms,url:'/terms/vendor'}):bad('Vendor Terms unavailable',503);
  }
  if(path==='/api/native/public/vendors'&&method==='GET'){
    const rows=await db.prepare("SELECT company_name,categories,emirate FROM companies WHERE role='vendor' AND verification_status='verified' ORDER BY company_name LIMIT 200").all();
    return json({ok:true,vendors:rows.results.map(row=>({...row,categories:JSON.parse(row.categories||'[]')}))});
  }
  if(path==='/api/native/documents'&&method==='POST') {
    const error=requireRole(user,['client','vendor','admin']);if(error)return error;
    const form=await request.formData();const file=form.get('file'),kind=clean(form.get('kind'),30),ownerId=clean(form.get('owner_id'),100);
    let validated;try{validated=await validateUpload(file)}catch(error){return bad(error.message)}
    if(!['company','rfq','quotation','site_visit'].includes(kind))return bad('Invalid document type');
    const owner=kind==='company'?await db.prepare('SELECT owner_user_id FROM companies WHERE id=?').bind(ownerId).first():kind==='rfq'?await db.prepare('SELECT c.owner_user_id,r.status FROM rfqs r LEFT JOIN companies c ON c.id=r.client_company_id WHERE r.id=?').bind(ownerId).first():kind==='quotation'?await db.prepare('SELECT c.owner_user_id,r.status FROM quotations q JOIN companies c ON c.id=q.vendor_company_id JOIN rfqs r ON r.id=q.rfq_id WHERE q.id=?').bind(ownerId).first():await db.prepare('SELECT id FROM site_visits WHERE id=?').bind(ownerId).first();
    if(!owner)return bad('Document owner not found',404);
    if(kind==='rfq'&&owner.status!=='under_review'||kind==='quotation'&&owner.status!=='quoting')return bad('Documents cannot be added at this request stage',409);
    if(user.role!=='admin'&&owner?.owner_user_id!==user.id)return bad('Document owner required',403);
    const bucket=kind==='quotation'?env.URBAN_PROCURE_QUOTE_DOCUMENTS:env.URBAN_PROCURE_RFQ_DOCUMENTS;
    if(!bucket)return bad('Private storage unavailable',503);
    const docId=id(),key=`private/${kind}/${ownerId}/${docId}`;
    await bucket.put(key,validated.bytes,{httpMetadata:{contentType:validated.mime}});
    try{await db.prepare('INSERT INTO documents(id,owner_kind,owner_id,uploaded_by,storage_key,original_name,mime_type,size_bytes) VALUES(?,?,?,?,?,?,?,?)').bind(docId,kind,ownerId,user.id,key,validated.name,validated.mime,file.size).run()}catch(error){await bucket.delete(key);throw error}
    await audit(db,user,'document',docId,'uploaded',{kind});return json({ok:true,id:docId,review_status:'pending'},201);
  }
  const documentMatch=path.match(/^\/api\/native\/documents\/([^/]+)$/);
  if(documentMatch&&method==='GET') {
    const error=requireRole(user,['client','vendor','admin','public_owner']);if(error)return error;
    const doc=await db.prepare('SELECT * FROM documents WHERE id=?').bind(documentMatch[1]).first();if(!doc)return bad('Not found',404);
    const sanitized=new URL(request.url).searchParams.get('sanitized')==='1';
    if(user.role!=='admin'&&!(doc.uploaded_by===user.id&&!sanitized)){
      let rfqId=doc.owner_kind==='rfq'?doc.owner_id:null;
      if(doc.owner_kind==='quotation'){const quote=await db.prepare('SELECT rfq_id FROM quotations WHERE id=?').bind(doc.owner_id).first();rfqId=quote?.rfq_id}
      if(doc.owner_kind==='public_request'){const rfq=await db.prepare('SELECT id FROM rfqs WHERE public_request_id=?').bind(doc.owner_id).first();rfqId=rfq?.id}
      const access=rfqId?await rfqAccess(db,user,rfqId):null;
      if(!access||!sanitized||doc.review_status!=='approved'||!doc.sanitized_key||doc.owner_kind==='quotation'&&!access.owner)return bad('Access denied',403);
    }
    const bucket=doc.owner_kind==='quotation'?env.URBAN_PROCURE_QUOTE_DOCUMENTS:env.URBAN_PROCURE_RFQ_DOCUMENTS;
    const key=sanitized?doc.sanitized_key:doc.storage_key;if(!validStorageKey(key))return bad('Document unavailable',404);
    const object=await bucket?.get(key);if(!object)return bad('Not found',404);
    const inline=new URL(request.url).searchParams.get('view')==='1'&&['application/pdf','image/png','image/jpeg','text/plain'].includes(sanitized?'text/plain':doc.mime_type);
    await audit(db,user,'document',doc.id,sanitized?'sanitized_opened':'original_opened');
    return new Response(object.body,{headers:{'Content-Type':sanitized?'text/plain; charset=utf-8':doc.mime_type,'Content-Disposition':`${inline?'inline':'attachment'}; filename="${sanitized?'reviewed-work-pack.txt':encodeURIComponent(doc.original_name||'document')}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'; frame-ancestors 'self'"}});
  }
  if(path==='/api/native/health'&&method==='GET'){
    await db.prepare('SELECT 1 AS healthy').first();
    return json({ok:true,commit:RELEASE_COMMIT,database:true,emailConfigured:directMailConfigured(env),emailOutboxConfigured:!!env.NATIVE_EMAIL_KEY,turnstileConfigured:!!env.TURNSTILE_SECRET,privateStorageConfigured:!!env.URBAN_PROCURE_RFQ_DOCUMENTS&&!!env.URBAN_PROCURE_QUOTE_DOCUMENTS});
  }
  if(path==='/api/native/public/stats'&&method==='GET') {
    const stats=await db.prepare("SELECT (SELECT count(*) FROM companies) companies,(SELECT count(*) FROM companies WHERE role='vendor' AND verification_status='verified') vendors,(SELECT count(*) FROM rfqs WHERE status='quoting') open_rfqs,(SELECT count(*) FROM awards) awards").first();
    return json({ok:true,...stats});
  }
  let body={};
  if((method==='POST'||method==='PATCH')&&!/^\/api\/native\/public\/requests\/[^/]+\/documents$/.test(path)){
    const raw=await request.text();if(raw.length>50000)return bad('Request is too large',413);
    try{body=raw?JSON.parse(raw):{}}catch{return bad('Valid JSON is required')}
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length>40||Object.values(body).some(v=>typeof v==='string'&&v.length>20000||Array.isArray(v)&&v.length>100))return bad('Invalid request payload');
    for(const [key,value] of Object.entries(body)){
      if(value===null)continue;
      if(['site_visit','accept_vendor_terms','accept'].includes(key)){if(typeof value!=='boolean')return bad('Invalid '+key);continue}
      if(key==='categories'){if(!Array.isArray(value)||value.some(item=>typeof item!=='string'||item.length>120))return bad('Invalid categories');continue}
      if(['amount_aed','labourer_count','hours_per_labourer'].includes(key)){if(!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(Number(value)))return bad('Invalid '+key);continue}
      if(typeof value!=='string')return bad('Invalid '+key);
    }
  }
  if(path==='/api/native/auth/register'&&method==='POST') {
    if(!await limitAttempts(db,request,env,'register',5))return bad('Please try again later',429);
    const address=clean(body.email,200).toLowerCase(),role=clean(body.role,20);
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)||!['client','vendor'].includes(role)||(String(body.password||'').length<12||String(body.password||'').length>4096))return bad('Valid email, role and password of at least 12 characters required');
    if(role==='vendor' && body.accept_vendor_terms!==true)return bad('Vendor Terms acceptance is required');
    const salt=random(),uid=id(),companyId=id();
    const agreement=role==='vendor'?await db.prepare("SELECT version,agreement_hash FROM agreement_versions WHERE kind='vendor' AND active=1").first():null;
    if(role==='vendor'&&!agreement)return bad('Vendor Terms are not published',503);
    if(agreement&&(body.terms_version!==agreement.version||body.terms_hash!==agreement.agreement_hash))return bad('Vendor Terms changed. Refresh, review and accept the current version',409);
    if(body.license_expiry&&!/^\d{4}-\d{2}-\d{2}$/.test(body.license_expiry))return bad('Valid licence expiry date required');
    if(body.categories&&(!Array.isArray(body.categories)||body.categories.some(v=>typeof v!=='string'||v.length>120)))return bad('Valid service categories required');
    if(await db.prepare('SELECT id FROM users WHERE email=?').bind(address).first())return bad('This email already has an account. Sign in or use forgot password',409);
    const company=clean(body.company_name,180),contact=clean(body.contact_name,180);
    if(!company||!contact)return bad('Company and contact person are required');
    const statements=[db.prepare('INSERT INTO users(id,email,password_hash,password_salt,role) VALUES(?,?,?,?,?)').bind(uid,address,await passwordHash(body.password,salt),salt,role),db.prepare('INSERT INTO companies(id,owner_user_id,role,company_name,contact_name,contact_email,phone,trade_license_no,license_expiry,categories,emirate) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(companyId,uid,role,company,contact,address,clean(body.phone,60),clean(body.trade_license_no,120),body.license_expiry||null,JSON.stringify(body.categories||[]),clean(body.emirate,80))];
    if(agreement)statements.push(db.prepare('INSERT INTO agreement_acceptances(id,user_id,company_id,agreement_type,version,agreement_hash,accepted_at,ip_address,user_agent,service_charge_terms) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id(),uid,companyId,'vendor',agreement.version,agreement.agreement_hash,now(),request.headers.get('CF-Connecting-IP'),request.headers.get('User-Agent'),JSON.stringify({general:{rate:.025,minimum_aed:500},manpower:{aed_per_labourer_hour:1}})));
    await db.batch(statements);
    const verification=random();await db.prepare('INSERT INTO auth_tokens(id,user_id,token_hash,purpose,expires_at) VALUES(?,?,?,?,?)').bind(id(),uid,await sha(verification),'verify',new Date(Date.now()+86400000).toISOString()).run();
    const delivery=await email(env,address,'verification','Verify your Urban Procures account',`${new URL(request.url).origin}/verify-email?token=${encodeURIComponent(verification)}`);
    await audit(db,{id:uid},'user',uid,'registration',{role,emailSent:delivery.success});return json({ok:true,verificationRequired:true,emailSent:delivery.success},201);
  }
  if(path==='/api/native/auth/verify'&&method==='POST') {
    const hash=await sha(clean(body.token,200)),at=now();
    const results=await db.batch([
      db.prepare("UPDATE users SET verified_at=? WHERE id IN (SELECT user_id FROM auth_tokens WHERE token_hash=? AND purpose='verify' AND consumed_at IS NULL AND expires_at>?)").bind(at,hash,at),
      db.prepare("UPDATE auth_tokens SET consumed_at=? WHERE token_hash=? AND purpose='verify' AND consumed_at IS NULL AND expires_at>?").bind(at,hash,at)
    ]);
    return results[1].meta.changes?json({ok:true}):bad('Invalid or expired token');
  }
  if(path==='/api/native/auth/login'&&method==='POST') {
    if(!await limitAttempts(db,request,env,'login',10))return bad('Too many sign-in attempts. Try again later',429);
    if(String(body.password||'').length>4096)return bad('Invalid credentials',401);
    const address=clean(body.email,200).toLowerCase();
    if(!await limitAttempts(db,request,env,'login_account',10,address))return bad('Too many sign-in attempts. Try again later',429);
    const row=await db.prepare('SELECT * FROM users WHERE email=?').bind(address).first();
    const check=row?await verifyPassword(String(body.password||''),row.password_salt,row.password_hash):{valid:false};
    if(!check.valid)return bad('Invalid credentials',401);
    if(!row.verified_at)return bad('Email verification required',403);
    if(check.upgrade){const salt=random(),hash=await passwordHash(String(body.password),salt);const updated=await db.prepare('UPDATE users SET password_hash=?,password_salt=? WHERE id=? AND password_hash=?').bind(hash,salt,row.id,row.password_hash).run();if(!updated.meta.changes)return bad('Please sign in again',409);row.password_hash=hash;row.password_salt=salt;}
    const session=await issueSession(db,row);await audit(db,row,'user',row.id,'login');return sessionResponse(row,session);
  }
  if(path==='/api/native/auth/logout'&&method==='POST') {
    const token=sessionToken(request);if(token){const removed=await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha(token)).run();if(removed.meta.changes)await audit(db,user,'user',user?.id||null,'logout')}
    const out=json({ok:true});out.headers.set('Set-Cookie','up_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');return out;
  }
  if(path==='/api/native/auth/reset/request'&&method==='POST') {
    if(!directMailConfigured(env))return bad('Password reset email is pending Zoho connection',503);
    if(!await limitAttempts(db,request,env,'reset',5))return bad('Please try again later',429);
    const address=clean(body.email,200).toLowerCase();const found=await db.prepare('SELECT id FROM users WHERE email=?').bind(address).first();
    if(found){const token=random();await db.prepare('INSERT INTO auth_tokens(id,user_id,token_hash,purpose,expires_at) VALUES(?,?,?,?,?)').bind(id(),found.id,await sha(token),'reset',new Date(Date.now()+3600000).toISOString()).run();await email(env,address,'password_reset','Reset your Urban Procures password',`${new URL(request.url).origin}/reset-password?token=${encodeURIComponent(token)}`)}
    return json({ok:true});
  }
  if(path==='/api/native/auth/reset/confirm'&&method==='POST') {
    if((String(body.password||'').length<12||String(body.password||'').length>4096))return bad('Invalid reset token or password');
    const hash=await sha(clean(body.token,200)),at=now(),salt=random();
    const token=await db.prepare("SELECT user_id FROM auth_tokens WHERE token_hash=? AND purpose='reset' AND consumed_at IS NULL AND expires_at>?").bind(hash,at).first();
    if(!token)return bad('Invalid reset token or password');
    const results=await db.batch([
      db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM auth_tokens WHERE token_hash=? AND purpose='reset' AND consumed_at IS NULL AND expires_at>?)").bind(hash,at),
      db.prepare("UPDATE users SET password_hash=?,password_salt=?,verified_at=COALESCE(verified_at,?) WHERE id IN (SELECT user_id FROM auth_tokens WHERE token_hash=? AND purpose='reset' AND consumed_at IS NULL AND expires_at>?)").bind(await passwordHash(body.password,salt),salt,at,hash,at),
      db.prepare("UPDATE auth_tokens SET consumed_at=? WHERE purpose='reset' AND consumed_at IS NULL AND user_id IN (SELECT user_id FROM auth_tokens WHERE token_hash=? AND purpose='reset' AND consumed_at IS NULL AND expires_at>?)").bind(at,hash,at)
    ]);
    if(!results[2].meta.changes)return bad('Invalid reset token or password');
    await audit(db,{id:token.user_id},'user',token.user_id,'password_reset');return json({ok:true});
  }
  if(path==='/api/native/auth/me'&&method==='GET')return user?json({ok:true,user}):bad('Authentication required',401);
  if(path==='/api/native/workspace'&&method==='GET') {
    const error=requireRole(user,['client','vendor','admin']);if(error)return error;
    const profile=await db.prepare('SELECT id,company_name,contact_name,contact_email,phone,trade_license_no,license_expiry,categories,emirate,verification_status FROM companies WHERE owner_user_id=?').bind(user.id).first();
    const rfqs=user.role==='client'?await db.prepare('SELECT r.id,r.reference,r.title,r.category,r.sanitized_scope,r.status,r.created_at FROM rfqs r JOIN companies c ON c.id=r.client_company_id WHERE c.owner_user_id=? ORDER BY r.created_at DESC LIMIT 100').bind(user.id).all():user.role==='vendor'?await db.prepare('SELECT r.id,r.reference,r.title,r.category,r.sanitized_scope,r.status,r.created_at FROM rfqs r JOIN rfq_invitations i ON i.rfq_id=r.id WHERE i.vendor_company_id=? ORDER BY r.created_at DESC LIMIT 100').bind(profile?.id||'').all():await db.prepare('SELECT id,reference,title,category,status,created_at,public_request_id FROM rfqs ORDER BY created_at DESC LIMIT 100').all();
    const quotations=user.role==='vendor'?await db.prepare('SELECT q.id,q.rfq_id,q.amount_fils,q.status,q.created_at FROM quotations q WHERE q.vendor_company_id=? ORDER BY q.created_at DESC LIMIT 100').bind(profile?.id||'').all():user.role==='client'?await db.prepare('SELECT q.id,q.rfq_id,q.amount_fils,q.sanitized_notes,q.status,q.created_at FROM quotations q JOIN rfqs r ON r.id=q.rfq_id WHERE r.client_company_id=? ORDER BY q.created_at DESC LIMIT 100').bind(profile?.id||'').all():{results:[]};
    const awards=user.role==='vendor'?await db.prepare('SELECT a.id,a.rfq_id,a.quotation_id,a.awarded_amount_fils,a.awarded_at,s.amount_fils AS service_charge_fils,s.status AS charge_status FROM awards a LEFT JOIN service_charges s ON s.award_id=a.id WHERE a.vendor_company_id=? ORDER BY a.awarded_at DESC LIMIT 100').bind(profile?.id||'').all():user.role==='client'?await db.prepare('SELECT a.id,a.rfq_id,a.quotation_id,a.awarded_amount_fils,a.awarded_at FROM awards a JOIN rfqs r ON r.id=a.rfq_id WHERE r.client_company_id=? ORDER BY a.awarded_at DESC LIMIT 100').bind(profile?.id||'').all():{results:[]};
    let agreement=null;
    if(user.role==='vendor'){agreement=await db.prepare("SELECT version,agreement_hash FROM agreement_versions WHERE kind='vendor' AND active=1").first();if(agreement)agreement.accepted=!!await db.prepare("SELECT id FROM agreement_acceptances WHERE user_id=? AND agreement_type='vendor' AND version=? AND agreement_hash=?").bind(user.id,agreement.version,agreement.agreement_hash).first()}
    return json({ok:true,role:user.role,user,profile,agreement,rfqs:rfqs.results,quotations:quotations.results,awards:awards.results});
  }
  if(path==='/api/native/agreements/vendor'&&method==='POST'){
    const error=requireRole(user,['vendor']);if(error)return error;
    const agreement=await db.prepare("SELECT version,agreement_hash FROM agreement_versions WHERE kind='vendor' AND active=1").first();
    if(!agreement||body.accept!==true||body.version!==agreement.version||body.agreement_hash!==agreement.agreement_hash)return bad('Review and accept the current Vendor Terms',409);
    const company=await db.prepare("SELECT id FROM companies WHERE owner_user_id=? AND role='vendor'").bind(user.id).first();if(!company)return bad('Company profile required',409);
    await db.prepare('INSERT OR IGNORE INTO agreement_acceptances(id,user_id,company_id,agreement_type,version,agreement_hash,accepted_at,ip_address,user_agent,service_charge_terms) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id(),user.id,company.id,'vendor',agreement.version,agreement.agreement_hash,now(),request.headers.get('CF-Connecting-IP'),request.headers.get('User-Agent'),JSON.stringify({general:{rate:.025,minimum_aed:500},manpower:{aed_per_labourer_hour:1}})).run();
    await audit(db,user,'agreement',agreement.version,'accepted',{hash:agreement.agreement_hash});return json({ok:true});
  }
  if(path==='/api/native/admin/accounts'&&method==='GET') {
    const error=requireRole(user,['admin']);if(error)return error;
    const rows=await pageList(db,request,'SELECT u.id AS user_id,u.email,u.role,u.verified_at,u.created_at,c.id AS company_id,c.company_name,c.contact_name,c.contact_email,c.phone,c.trade_license_no,c.license_expiry,c.categories,c.emirate,c.verification_status,c.verified_at AS company_verified_at,c.created_at AS company_created_at FROM users u LEFT JOIN companies c ON c.owner_user_id=u.id ORDER BY u.created_at DESC LIMIT 100');return json({ok:true,accounts:rows.rows,pagination:rows.pagination});
  }
  if(path==='/api/native/admin/operations'&&method==='GET'){
    const error=requireRole(user,['admin']);if(error)return error;
    const alerts=await db.prepare('SELECT id,kind,state,last_seen_at,notified_at,detail FROM operations_alerts ORDER BY last_seen_at DESC LIMIT 50').all();
    const jobs=await db.prepare("SELECT j.id,e.kind,e.status,j.attempts,j.next_at,e.error_code FROM jobs j JOIN email_log e ON e.id=j.id WHERE j.kind='transactional_email' AND j.status IN ('queued','sending','failed') ORDER BY j.created_at DESC LIMIT 100").all();
    return json({ok:true,commit:RELEASE_COMMIT,alerts:alerts.results,jobs:jobs.results});
  }
  const verifyAccount=path.match(/^\/api\/native\/admin\/accounts\/([^/]+)\/verify$/);
  if(verifyAccount&&method==='POST') {
    const error=requireRole(user,['admin']);if(error)return error;
    const update=await db.prepare('UPDATE users SET verified_at=? WHERE id=? AND verified_at IS NULL').bind(now(),verifyAccount[1]).run();
    if(!update.meta.changes)return bad('Account not pending',404);
    await audit(db,user,'user',verifyAccount[1],'manual_verification');return json({ok:true});
  }
  if(path==='/api/native/public/requests'&&method==='POST') {
    if(!await verifyTurnstile(body.turnstile_token,request,env))return bad('Verification required',403);
    if(!await limitAttempts(db,request,env,'public_request',5))return bad('Please try again later',429);
    const name=clean(body.name,160),phone=clean(body.phone,60),address=clean(body.location,500),title=clean(body.title,220),scope=clean(body.scope,20000),category=clean(body.category,120),addressEmail=clean(body.email,200);
    if(!name||!phone||!address||!title||!scope||!category||!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addressEmail))return bad('Complete all required request details with a valid email');
    const rid=id(),reference='UP-'+crypto.randomUUID().slice(0,8).toUpperCase(),uploadToken=random();
    const visit=body.site_visit===true;
    const statements=[db.prepare('INSERT INTO public_requests(id,reference,name,phone,email,location,category,title,scope,visit_requested,upload_token_hash,upload_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(rid,reference,name,phone,addressEmail,address,category,title,scope,visit?1:0,await sha(uploadToken),new Date(Date.now()+86400000).toISOString())];
    if(visit)statements.push(db.prepare('INSERT INTO site_visits(id,request_id,payment_status,appointment_at) VALUES(?,?,?,?)').bind(id(),rid,'unpaid',clean(body.preferred_appointment,40)||null));
    await db.batch(statements);await audit(db,null,'public_request',rid,'created',{siteVisit:visit});
    return json({ok:true,id:rid,reference,upload_token:uploadToken,site_visit:visit?{amount_aed:100,payment_status:'unpaid',status:'requested'}:null},201);
  }
  const publicUpload=path.match(/^\/api\/native\/public\/requests\/([^/]+)\/documents$/);
  if(publicUpload&&method==='POST') {
    const token=request.headers.get('X-Upload-Token')||'';
    const owner=token?await db.prepare("SELECT id FROM public_requests WHERE id=? AND upload_token_hash=? AND upload_expires_at>? AND status='under_review'").bind(publicUpload[1],await sha(token),now()).first():null;
    if(!owner)return bad('Upload access denied',403);
    const form=await request.formData(),files=form.getAll('files');if(!files.length||files.length>5)return bad('Upload one to five files');
    const existing=await db.prepare("SELECT count(*) AS count FROM documents WHERE owner_kind='public_request' AND owner_id=?").bind(owner.id).first();if(existing.count+files.length>10)return bad('Maximum ten documents per public request',409);
    const bucket=env.URBAN_PROCURE_RFQ_DOCUMENTS;if(!bucket)return bad('Private storage unavailable',503);
    let checked;try{checked=await Promise.all(files.map(validateUpload))}catch(error){return bad(error.message)}
    const uploaded=[],keys=[],statements=[];
    try{for(const file of checked){
      const docId=id(),key=`private/public_request/${owner.id}/${docId}`;keys.push(key);await bucket.put(key,file.bytes,{httpMetadata:{contentType:file.mime}});
      statements.push(db.prepare('INSERT INTO documents(id,owner_kind,owner_id,storage_key,original_name,mime_type,size_bytes) VALUES(?,?,?,?,?,?,?)').bind(docId,'public_request',owner.id,key,file.name,file.mime,file.bytes.length));uploaded.push(docId);
    }await db.batch(statements)}catch(error){await Promise.all(keys.map(key=>bucket.delete(key)));throw error}
    await audit(db,null,'public_request',owner.id,'documents_uploaded',{count:uploaded.length});return json({ok:true,documents:uploaded},201);
  }
  const visitMatch=path.match(/^\/api\/native\/admin\/site-visits\/([^/]+)$/);
  if(visitMatch&&method==='PATCH') {
    const error=requireRole(user,['admin']);if(error)return error;
    const row=await db.prepare('SELECT * FROM site_visits WHERE id=?').bind(visitMatch[1]).first();if(!row)return bad('Not found',404);
    const next=clean(body.payment_status||row.payment_status,30);
    if(!['unpaid','pending_manual','paid','waived','refunded'].includes(next))return bad('Invalid payment state');
    if(body.status&&!['requested','scheduled','in_progress','completed','cancelled'].includes(body.status))return bad('Invalid visit status');
    if(body.status==='completed'&&!['paid','waived'].includes(next))return bad('Payment must be confirmed before completing the visit',409);
    if(body.appointment_at&&!Number.isFinite(Date.parse(body.appointment_at)))return bad('Valid appointment date required');
    if(next==='paid'&&!clean(body.payment_reference||row.payment_reference,100))return bad('Payment reference required');
    await db.prepare('UPDATE site_visits SET payment_status=?,payment_reference=?,appointment_at=?,inspection_notes=?,measurements=?,status=?,updated_at=? WHERE id=?').bind(next,clean(body.payment_reference||row.payment_reference,100),body.appointment_at||row.appointment_at,clean(body.inspection_notes||row.inspection_notes,20000),clean(body.measurements||row.measurements,20000),clean(body.status||row.status,50),now(),row.id).run();
    await audit(db,user,'site_visit',row.id,'updated',{paymentStatus:next});return json({ok:true});
  }
  if(path==='/api/native/admin/site-visits'&&method==='GET') {
    const error=requireRole(user,['admin']);if(error)return error;
    const visits=await pageList(db,request,'SELECT v.*,p.reference,p.name,p.phone,p.email,p.location,p.title,p.scope FROM site_visits v JOIN public_requests p ON p.id=v.request_id ORDER BY v.updated_at DESC LIMIT 100');return json({ok:true,visits:visits.rows,pagination:visits.pagination});
  }
  if(path==='/api/native/admin/documents'&&method==='GET') {
    const error=requireRole(user,['admin']);if(error)return error;
    const rows=await pageList(db,request,`SELECT d.id,d.owner_kind,d.owner_id,d.original_name,d.mime_type,d.size_bytes,d.review_status,d.created_at,u.email AS uploaded_by_email,
      COALESCE(r.reference,p.reference,q.rfq_id,c.company_name,v.reference) AS owner_reference,
      COALESCE(r.title,p.title,c.company_name,v.title) AS owner_title
      FROM documents d
      LEFT JOIN users u ON u.id=d.uploaded_by
      LEFT JOIN rfqs r ON d.owner_kind='rfq' AND r.id=d.owner_id
      LEFT JOIN public_requests p ON d.owner_kind='public_request' AND p.id=d.owner_id
      LEFT JOIN quotations q ON d.owner_kind='quotation' AND q.id=d.owner_id
      LEFT JOIN companies c ON d.owner_kind='company' AND c.id=d.owner_id
      LEFT JOIN site_visits sv ON d.owner_kind='site_visit' AND sv.id=d.owner_id
      LEFT JOIN public_requests v ON sv.request_id=v.id
      ORDER BY d.created_at DESC LIMIT 200`);
    return json({ok:true,documents:rows.rows,pagination:rows.pagination});
  }
  const reviewDocument=path.match(/^\/api\/native\/admin\/documents\/([^/]+)\/review$/);
  if(reviewDocument&&method==='POST'){
    const error=requireRole(user,['admin']);if(error)return error;
    const doc=await db.prepare('SELECT * FROM documents WHERE id=?').bind(reviewDocument[1]).first();if(!doc)return bad('Not found',404);
    if(!['approved','rejected'].includes(body.status))return bad('Approval or rejection is required');
    let key=null;
    if(body.status==='approved'&&doc.owner_kind!=='company'){
      const reviewed=clean(body.sanitized_text,20000);if(!reviewed)return bad('Reviewed sanitized text is required');
      let rfqId=doc.owner_kind==='rfq'?doc.owner_id:null;
      if(doc.owner_kind==='quotation'){const quote=await db.prepare('SELECT rfq_id FROM quotations WHERE id=?').bind(doc.owner_id).first();rfqId=quote?.rfq_id}
      if(doc.owner_kind==='public_request'){const rfq=await db.prepare('SELECT id FROM rfqs WHERE public_request_id=?').bind(doc.owner_id).first();rfqId=rfq?.id}
      const contacts=await db.prepare('SELECT name,email,phone,location FROM public_requests WHERE id=?').bind(doc.owner_id).first();
      if(scanIdentityLeakage(reviewed,[...(rfqId?await identityTerms(db,rfqId):[]),...Object.values(contacts||{})]).leaked)return bad('Reviewed document contains identifying details',422);
      key=`sanitized/${doc.owner_kind}/${doc.owner_id}/${doc.id}.txt`;
      const bucket=doc.owner_kind==='quotation'?env.URBAN_PROCURE_QUOTE_DOCUMENTS:env.URBAN_PROCURE_RFQ_DOCUMENTS;
      await bucket.put(key,reviewed,{httpMetadata:{contentType:'text/plain; charset=utf-8'}});
    }
    await db.prepare('UPDATE documents SET review_status=?,sanitized_key=? WHERE id=?').bind(body.status,key,doc.id).run();
    await audit(db,user,'document',doc.id,'reviewed',{status:body.status});return json({ok:true});
  }
  if(path==='/api/native/admin/public-requests'&&method==='GET') {
    const error=requireRole(user,['admin']);if(error)return error;
    const rows=await pageList(db,request,'SELECT p.*,v.id AS visit_id,v.status AS visit_status,v.payment_status,v.appointment_at FROM public_requests p LEFT JOIN site_visits v ON v.request_id=p.id ORDER BY p.created_at DESC LIMIT 100');return json({ok:true,requests:rows.rows,pagination:rows.pagination});
  }
  const verifyCompany=path.match(/^\/api\/native\/admin\/companies\/([^/]+)\/verify$/);
  if(verifyCompany&&method==='POST') {
    const error=requireRole(user,['admin']);if(error)return error;
    const next=body.status==='verified'?'verified':body.status==='rejected'?'rejected':null;if(!next)return bad('Invalid verification decision');
    const changed=await db.prepare('UPDATE companies SET verification_status=?,verified_at=? WHERE id=?').bind(next,next==='verified'?now():null,verifyCompany[1]).run();
    if(!changed.meta.changes)return bad('Company not found',404);
    await audit(db,user,'company',verifyCompany[1],'verification',{status:next});return json({ok:true});
  }
  if(path==='/api/native/admin/overview'&&method==='GET') {
    const error=requireRole(user,['admin']);if(error)return error;
    const counts=await db.prepare("SELECT (SELECT count(*) FROM users) users,(SELECT count(*) FROM companies WHERE verification_status='pending') companies_pending,(SELECT count(*) FROM public_requests WHERE status='under_review') requests_pending,(SELECT count(*) FROM site_visits WHERE status!='completed') visits_open,(SELECT count(*) FROM rfqs WHERE status='quoting') rfqs_open,(SELECT count(*) FROM service_charges WHERE status='due') service_charges_due").first();
    return json({ok:true,counts});
  }
  if(path==='/api/native/admin/prospects'&&method==='POST') {
    const error=requireRole(user,['admin']);if(error)return error;
    const name=clean(body.name,180),address=clean(body.email,200).toLowerCase(),type=clean(body.type,20),source=clean(body.source_url,1000);
    if(!name||!['client','vendor'].includes(type)||!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)||!/^https:\/\//.test(source))return bad('A sourced business contact is required');
    const prospectId=id();await db.prepare('INSERT OR IGNORE INTO prospects(id,name,domain,email,type,source_url,relevance) VALUES(?,?,?,?,?,?,?)').bind(prospectId,name,clean(body.domain,200),address,type,source,clean(body.relevance,1000)).run();
    await audit(db,user,'prospect',prospectId,'added',{type});return json({ok:true},201);
  }
  const optout=path.match(/^\/api\/native\/admin\/prospects\/([^/]+)\/opt-out$/);
  if(optout&&method==='POST') {const error=requireRole(user,['admin']);if(error)return error;await db.prepare("UPDATE prospects SET opted_out=1,status='opted_out' WHERE id=?").bind(optout[1]).run();await audit(db,user,'prospect',optout[1],'opted_out');return json({ok:true})}
  if(path==='/api/native/admin/outreach/send-one'&&method==='POST') {
    const error=requireRole(user,['admin']);if(error)return error;
    const limit=Number(env.ZOHO_VERIFIED_DAILY_LIMIT||0);if(!Number.isSafeInteger(limit)||limit<1)return bad('Verified Zoho daily allowance is not configured',503);
    const sent=await db.prepare("SELECT count(*) AS count FROM email_log WHERE kind='invitation' AND status='sent' AND created_at>=date('now')").first();if(sent.count>=limit)return bad('Daily sending limit reached',429);
    const prospect=await db.prepare("SELECT * FROM prospects WHERE id=? AND opted_out=0 AND status='review'").bind(body.prospect_id).first();if(!prospect)return bad('Eligible prospect not found',404);
    const already=await db.prepare('SELECT id FROM companies WHERE lower(contact_email)=?').bind(prospect.email).first();if(already)return bad('Company already registered',409);
    const message=clean(body.message,3000),subject=clean(body.subject,180);if(!message||!subject)return bad('Invitation subject and message required');
    if(!env.ZOHO_CLIENT_ID||!env.ZOHO_CLIENT_SECRET||!env.ZOHO_REFRESH_TOKEN||!env.ZOHO_ACCOUNT_ID)return bad('Zoho delivery is not configured',503);
    const day=now().slice(0,10);
    await db.prepare('INSERT OR IGNORE INTO email_quota(day,reserved) VALUES(?,0)').bind(day).run();
    const reservation=await db.prepare('UPDATE email_quota SET reserved=reserved+1 WHERE day=? AND reserved<?').bind(day,limit).run();
    if(!reservation.meta.changes)return bad('Daily sending limit reached',429);
    const claim=await db.prepare("UPDATE prospects SET status='sending' WHERE id=? AND opted_out=0 AND status='review' AND NOT EXISTS (SELECT 1 FROM prospects other WHERE lower(other.email)=lower(prospects.email) AND other.id!=prospects.id AND other.status IN ('sending','invited','delivery_unconfirmed','opted_out'))").bind(prospect.id).run();
    if(!claim.meta.changes){await db.prepare('UPDATE email_quota SET reserved=reserved-1 WHERE day=? AND reserved>0').bind(day).run();return bad('Invitation is already reserved or this contact is suppressed',409)}
    const eligible=await db.prepare("SELECT id FROM prospects WHERE id=? AND opted_out=0 AND status='sending'").bind(prospect.id).first();
    if(!eligible){await db.prepare('UPDATE email_quota SET reserved=reserved-1 WHERE day=? AND reserved>0').bind(day).run();return bad('Contact is suppressed',409)}
    let result;
    try{result=await email(env,prospect.email,'invitation',subject,message)}catch{result={success:false}}
    // Ambiguous delivery must not cause a duplicate send or free its quota.
    await db.prepare("UPDATE prospects SET status=? WHERE id=? AND status='sending' AND opted_out=0").bind(result.success?'invited':'delivery_unconfirmed',prospect.id).run();
    await audit(db,user,'prospect',prospect.id,result.success?'invited':'delivery_unconfirmed');
    if(!result.success)return bad('Delivery was not confirmed; review provider records before retrying',503);
    return json({ok:true});
  }
  if(path==='/api/native/rfqs'&&method==='POST') {
    const error=requireRole(user,['client','admin']);if(error)return error;
    const company=user.role==='client'?await db.prepare("SELECT * FROM companies WHERE owner_user_id=? AND role='client'").bind(user.id).first():null;
    const publicRequest=body.public_request_id&&user.role==='admin'?await db.prepare('SELECT * FROM public_requests WHERE id=?').bind(body.public_request_id).first():null;
    if(user.role==='client'&&!company)return bad('Company profile required',403);
    if(body.public_request_id&&!publicRequest)return bad('Public request not found',404);
    if(publicRequest&&await db.prepare('SELECT id FROM rfqs WHERE public_request_id=?').bind(publicRequest.id).first())return bad('This public request already has an RFQ',409);
    if(publicRequest){const visit=await db.prepare('SELECT * FROM site_visits WHERE request_id=?').bind(publicRequest.id).first();if(visit&&!['paid','waived'].includes(visit.payment_status))return bad('Site visit payment has not been confirmed',409);if(visit&&visit.status!=='completed')return bad('Inspection must be completed',409)}
    const title=clean(body.title||publicRequest?.title,220),category=clean(body.category||publicRequest?.category,120),original=clean(body.scope||publicRequest?.scope,20000),sanitized=clean(body.sanitized_scope,20000);
    if(!title||!category||!original||!sanitized)return bad('Title, category, original and reviewed sanitized scope required');
    if(scanIdentityLeakage({title,sanitized},[publicRequest?.name,publicRequest?.email,publicRequest?.phone,publicRequest?.location,company?.company_name,company?.contact_name,company?.contact_email,company?.phone,body.location]).leaked)return bad('Public work pack contains identifying details',422);
    const rid=id(),reference='RFQ-'+crypto.randomUUID().slice(0,8).toUpperCase();
    await db.prepare('INSERT INTO rfqs(id,reference,client_company_id,public_request_id,title,category,sanitized_scope,original_scope,location_private,emirate,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(rid,reference,company?.id||null,publicRequest?.id||null,title,category,sanitized,original,clean(body.location||publicRequest?.location,500),clean(body.emirate,80),'under_review').run();
    if(publicRequest)await db.prepare('UPDATE site_visits SET rfq_id=? WHERE request_id=?').bind(rid,publicRequest.id).run();
    await audit(db,user,'rfq',rid,'created');return json({ok:true,id:rid,reference},201);
  }
  const clarificationMatch=path.match(/^\/api\/native\/rfqs\/([^/]+)\/clarifications$/);
  if(clarificationMatch&&['GET','POST'].includes(method)){
    const error=requireRole(user,['client','vendor','admin','public_owner']);if(error)return error;
    const access=await rfqAccess(db,user,clarificationMatch[1]);if(!access)return bad('Access denied',403);
    if(method==='POST'){
      if(access.rfq.status!=='quoting')return bad('Clarifications are closed',409);
      const text=clean(body.message,10000);if(!text)return bad('Clarification message required');
      if(scanIdentityLeakage(text,await identityTerms(db,access.rfq.id)).leaked)return bad('Clarification contains identifying details',422);
      const cid=id();await db.prepare('INSERT INTO clarifications(id,rfq_id,sender_user_id,vendor_company_id,sanitized_message) VALUES(?,?,?,?,?)').bind(cid,access.rfq.id,user.id,access.vendor?.id||null,text).run();
      await audit(db,user,'clarification',cid,'created',{rfqId:access.rfq.id});return json({ok:true,id:cid},201);
    }
    const rows=await db.prepare("SELECT c.id,c.sanitized_message,c.created_at,CASE WHEN c.vendor_company_id IS NOT NULL THEN 'Vendor' WHEN u.role='admin' THEN 'Urban Procures' ELSE 'Client' END AS sender FROM clarifications c JOIN users u ON u.id=c.sender_user_id WHERE c.rfq_id=? AND (?=1 OR c.vendor_company_id IS NULL OR c.vendor_company_id=?) ORDER BY c.created_at,c.id LIMIT 200").bind(access.rfq.id,access.owner||access.admin?1:0,access.vendor?.id||'').all();
    return json({ok:true,clarifications:rows.results});
  }
  const rfqMatch=path.match(/^\/api\/native\/rfqs\/([^/]+)$/);
  if(rfqMatch&&method==='GET') {
    const error=requireRole(user,['client','vendor','admin','public_owner']);if(error)return error;
    const access=await rfqAccess(db,user,rfqMatch[1]);if(!access)return bad('Access denied',403);
    const {rfq,client,vendor}=access,isOwner=access.owner,isAdmin=access.admin;
    const award=await db.prepare('SELECT * FROM awards WHERE rfq_id=?').bind(rfq.id).first();
    const isWinner=award?.vendor_company_id===vendor?.id;
    const safe={id:rfq.id,reference:rfq.reference,title:rfq.title,category:rfq.category,scope:rfq.sanitized_scope,emirate:rfq.emirate,status:rfq.status,closing_at:rfq.closing_at};if(isAdmin)safe.public_owner=!!rfq.public_request_id;
    if(isOwner||isAdmin||isWinner){const publicClient=!client&&rfq.public_request_id?await db.prepare('SELECT name AS contact_name,email AS contact_email,phone FROM public_requests WHERE id=?').bind(rfq.public_request_id).first():null;safe.client=isOwner||isAdmin?client||publicClient:{company_name:client?.company_name,contact_name:client?.contact_name||publicClient?.contact_name,contact_email:client?.contact_email||publicClient?.contact_email,phone:client?.phone||publicClient?.phone};safe.location=rfq.location_private}
    const quotations=isOwner||isAdmin?await db.prepare('SELECT * FROM quotations WHERE rfq_id=? ORDER BY created_at').bind(rfq.id).all():{results:[]};
    safe.quotations=await Promise.all(quotations.results.map(async(q,index)=>{const response={id:q.id,amount_aed:q.amount_fils/100,notes:q.sanitized_notes,vendor_label:'Vendor '+String.fromCharCode(65+index)};if(isAdmin||award?.quotation_id===q.id){response.vendor=await db.prepare('SELECT company_name,contact_name,contact_email,phone FROM companies WHERE id=?').bind(q.vendor_company_id).first()}return response}));
    const docs=await db.prepare("SELECT id,owner_kind,owner_id,review_status,sanitized_key IS NOT NULL AS sanitized FROM documents WHERE (owner_kind='rfq' AND owner_id=?) OR (owner_kind='public_request' AND owner_id=?) OR (owner_kind='quotation' AND owner_id IN (SELECT id FROM quotations WHERE rfq_id=?))").bind(rfq.id,rfq.public_request_id||'',rfq.id).all();
    safe.documents=docs.results.filter(doc=>isAdmin||doc.review_status==='approved'&&doc.sanitized&&(doc.owner_kind!=='quotation'||isOwner)).map(doc=>({id:doc.id,kind:doc.owner_kind,quotation_id:doc.owner_kind==='quotation'?doc.owner_id:undefined,status:doc.review_status,url:'/api/native/documents/'+doc.id+(isAdmin?'?view=1':'?sanitized=1&view=1')}));
    return json({ok:true,rfq:safe});
  }
  const publishMatch=path.match(/^\/api\/native\/admin\/rfqs\/([^/]+)\/publish$/);
  if(publishMatch&&method==='POST') {
    const error=requireRole(user,['admin']);if(error)return error;
    const row=await db.prepare('SELECT * FROM rfqs WHERE id=?').bind(publishMatch[1]).first();if(!row)return bad('Not found',404);
    if(row.status!=='under_review'||!row.sanitized_scope)return bad('RFQ is not ready to publish',409);
    const pending=await db.prepare("SELECT id FROM documents WHERE review_status='pending' AND ((owner_kind='rfq' AND owner_id=?) OR (owner_kind='public_request' AND owner_id=?)) LIMIT 1").bind(row.id,row.public_request_id||'').first();
    if(pending)return bad('Review uploaded RFQ documents before publishing',409);
    if(scanIdentityLeakage({title:row.title,scope:row.sanitized_scope}).leaked)return bad('Work pack contains identifying details',422);
    await db.prepare("UPDATE rfqs SET status='quoting',published_at=? WHERE id=?").bind(now(),row.id).run();await audit(db,user,'rfq',row.id,'published');const delivery=row.public_request_id?await sendOwnerLink(request,env,row):null;return json({ok:true,...(delivery?{owner_email_sent:delivery.success}:{})});
  }
  const ownerLink=path.match(/^\/api\/native\/admin\/rfqs\/([^/]+)\/owner-link$/);
  if(ownerLink&&method==='POST'){
    const error=requireRole(user,['admin']);if(error)return error;
    const rfq=await db.prepare("SELECT * FROM rfqs WHERE id=? AND public_request_id IS NOT NULL AND status IN ('quoting','awarded')").bind(ownerLink[1]).first();
    if(!rfq)return bad('Public RFQ not available',404);
    const delivery=await sendOwnerLink(request,env,rfq);await audit(db,user,'rfq',rfq.id,'owner_link_sent',{emailSent:delivery.success});return json({ok:true,emailSent:delivery.success});
  }
  const inviteMatch=path.match(/^\/api\/native\/admin\/rfqs\/([^/]+)\/invite$/);
  if(inviteMatch&&method==='POST') {
    const error=requireRole(user,['admin']);if(error)return error;
    const vendor=await db.prepare("SELECT * FROM companies WHERE id=? AND role='vendor' AND verification_status='verified'").bind(body.vendor_company_id).first();if(!vendor)return bad('Verified vendor required',409);
    const rfq=await db.prepare("SELECT id FROM rfqs WHERE id=? AND status='quoting'").bind(inviteMatch[1]).first();if(!rfq)return bad('RFQ is not open',409);
    const inserted=await db.prepare('INSERT OR IGNORE INTO rfq_invitations(id,rfq_id,vendor_company_id) VALUES(?,?,?)').bind(id(),rfq.id,vendor.id).run();
    if(inserted.meta.changes){await email(env,vendor.contact_email,'rfq_invitation','A new Urban Procures request is available',`Open your vendor workspace to review an approved work pack: ${new URL(request.url).origin}/vendor/invitations`);await audit(db,user,'rfq',rfq.id,'vendor_invited',{vendorId:vendor.id})}
    return json({ok:true,alreadyInvited:!inserted.meta.changes});
  }
  const quoteMatch=path.match(/^\/api\/native\/rfqs\/([^/]+)\/quotations$/);
  if(quoteMatch&&method==='POST') {
    const error=requireRole(user,['vendor']);if(error)return error;
    const vendor=await db.prepare("SELECT * FROM companies WHERE owner_user_id=? AND role='vendor' AND verification_status='verified'").bind(user.id).first();if(!vendor)return bad('Vendor verification required',403);
    const agreement=await db.prepare("SELECT a.id FROM agreement_acceptances a JOIN agreement_versions v ON v.kind=a.agreement_type AND v.version=a.version AND v.agreement_hash=a.agreement_hash WHERE a.user_id=? AND a.agreement_type='vendor' AND v.active=1").bind(user.id).first();if(!agreement)return bad('Accept the current Vendor Terms before submitting a quotation',409);
    const invitation=await db.prepare('SELECT r.id,r.category FROM rfq_invitations i JOIN rfqs r ON r.id=i.rfq_id WHERE i.rfq_id=? AND i.vendor_company_id=? AND r.status=?').bind(quoteMatch[1],vendor.id,'quoting').first();if(!invitation)return bad('Invitation required',403);
    const amount=Number(body.amount_aed);if(!Number.isFinite(amount)||amount<0||!Number.isSafeInteger(Math.round(amount*100)))return bad('Valid quotation amount required');
    try{calculateVendorServiceCharge({category:invitation.category,awardedValue:amount,labourers:body.labourer_count,hoursPerLabourer:body.hours_per_labourer})}catch{return bad('Valid labourer count and hours per labourer are required')}
    if(scanIdentityLeakage(clean(body.sanitized_notes,10000),[vendor.company_name,vendor.contact_name,vendor.contact_email,vendor.phone,vendor.trade_license_no]).leaked)return bad('Quotation contains identifying details',422);
    if(await db.prepare('SELECT id FROM quotations WHERE rfq_id=? AND vendor_company_id=?').bind(invitation.id,vendor.id).first())return bad('A quotation has already been submitted',409);
    const qid=id();await db.prepare('INSERT INTO quotations(id,rfq_id,vendor_company_id,amount_fils,sanitized_notes,private_notes,labourer_count,hours_per_labourer) VALUES(?,?,?,?,?,?,?,?)').bind(qid,invitation.id,vendor.id,Math.round(amount*100),clean(body.sanitized_notes,10000),clean(body.private_notes,10000),body.labourer_count||null,body.hours_per_labourer||null).run();
    await audit(db,user,'quotation',qid,'submitted');return json({ok:true,id:qid},201);
  }
  const awardMatch=path.match(/^\/api\/native\/rfqs\/([^/]+)\/award$/);
  if(awardMatch&&method==='POST') {
    const error=requireRole(user,['client','public_owner']);if(error)return error;
    const rfq=user.role==='public_owner'?await db.prepare('SELECT * FROM rfqs WHERE id=? AND public_request_id=?').bind(awardMatch[1],user.public_request_id).first():await db.prepare('SELECT r.* FROM rfqs r JOIN companies c ON c.id=r.client_company_id WHERE r.id=? AND c.owner_user_id=?').bind(awardMatch[1],user.id).first();if(!rfq||!['quoting','awarded'].includes(rfq.status))return bad('RFQ is not available for award',403);
    const q=await db.prepare('SELECT * FROM quotations WHERE id=? AND rfq_id=?').bind(body.quotation_id,rfq.id).first();if(!q)return bad('Quotation not found',404);
    const existing=await db.prepare('SELECT a.id,a.quotation_id,s.amount_fils FROM awards a JOIN service_charges s ON s.award_id=a.id WHERE a.rfq_id=?').bind(rfq.id).first();if(existing)return existing.quotation_id===q.id?json({ok:true,award_id:existing.id,service_charge_aed:existing.amount_fils/100,alreadyAwarded:true}):bad('RFQ already awarded to another quotation',409);
    if(await db.prepare("SELECT id FROM documents WHERE owner_kind='quotation' AND owner_id=? AND review_status='pending' LIMIT 1").bind(q.id).first())return bad('Quotation documents require admin review before award',409);
    const fee=calculateVendorServiceCharge({category:rfq.category,awardedValue:q.amount_fils/100,labourers:q.labourer_count,hoursPerLabourer:q.hours_per_labourer});
    const aid=id();try{await db.batch([db.prepare('INSERT INTO awards(id,rfq_id,quotation_id,client_user_id,vendor_company_id,awarded_amount_fils) VALUES(?,?,?,?,?,?)').bind(aid,rfq.id,q.id,user.id,q.vendor_company_id,q.amount_fils),db.prepare('INSERT INTO service_charges(id,award_id,basis,rate,labourer_count,hours_per_labourer,amount_fils) VALUES(?,?,?,?,?,?,?)').bind(id(),aid,fee.calculationBasis,fee.ratePerLabourerHour||fee.percentage,q.labourer_count,q.hours_per_labourer,Math.round(fee.serviceFee*100)),db.prepare("UPDATE rfqs SET status='awarded' WHERE id=?").bind(rfq.id)])}catch(error){const committed=await db.prepare('SELECT a.id,a.quotation_id,s.amount_fils FROM awards a JOIN service_charges s ON s.award_id=a.id WHERE a.rfq_id=?').bind(rfq.id).first();if(committed)return committed.quotation_id===q.id?json({ok:true,award_id:committed.id,service_charge_aed:committed.amount_fils/100,alreadyAwarded:true}):bad('RFQ already awarded to another quotation',409);throw error}
    await audit(db,user,'award',aid,'confirmed',{quotationId:q.id,identityReleasedTo:q.vendor_company_id,serviceChargeAed:fee.serviceFee});return json({ok:true,award_id:aid,service_charge_aed:fee.serviceFee},201);
  }
  return bad('Not found',404);
}
export async function handleNative(request,env) {try{return await handle(request,env)}catch(error){if(error?.name==='InputError')return bad(error.message);if(error?.name==='AuthChangedError')return bad('Credentials changed. Please sign in again',401);if(error?.name==='PasswordCapacityError')return bad('Sign-in is busy. Please try again shortly',503);console.error('Native API failure',error?.name||'Error');return bad('Request could not be completed',500)}}
