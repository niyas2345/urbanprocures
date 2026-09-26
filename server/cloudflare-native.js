import { calculateVendorServiceCharge } from './commercial/service-fee.js';
import { ZohoEmailProvider } from './ai/outreach-provider.js';

const json = (data, status=200) => new Response(JSON.stringify(data), {status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const bad = (message,status=400) => json({ok:false,error:message},status);
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const clean = (value,max=1000) => String(value??'').trim().slice(0,max);
const sha = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join('');
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const random = () => b64(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');

async function passwordHash(password,salt) {
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  const result=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',iterations:310000,salt:new TextEncoder().encode(salt)},key,256);
  return b64(new Uint8Array(result));
}
async function actor(request,env) {
  const cookie=request.headers.get('Cookie')?.match(/(?:^|;\s*)up_session=([^;]+)/)?.[1];
  const bearer=request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
  const token=cookie||bearer;
  if(!token)return null;
  const row=await env.URBAN_PROCURE_DB.prepare('SELECT u.id,u.email,u.role,u.verified_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').bind(await sha(token),now()).first();
  return row||null;
}
function requireRole(user,roles) {if(!user)return bad('Authentication required',401);if(!roles.includes(user.role))return bad('Access denied',403);return null;}
async function audit(db,user,kind,entity,event,detail={}) {await db.prepare('INSERT INTO audit_log(id,actor_user_id,entity_kind,entity_id,event,detail) VALUES(?,?,?,?,?,?)').bind(id(),user?.id||null,kind,entity,event,JSON.stringify(detail)).run();}
async function email(env,to,kind,subject,body) {
  // An outbound provider must be explicitly configured; no simulated delivery.
  const provider=new ZohoEmailProvider({env:{ZOHO_CLIENT_ID:env.ZOHO_CLIENT_ID,ZOHO_CLIENT_SECRET:env.ZOHO_CLIENT_SECRET,ZOHO_REFRESH_TOKEN:env.ZOHO_REFRESH_TOKEN,ZOHO_ACCOUNT_ID:env.ZOHO_ACCOUNT_ID,ZOHO_DC:env.ZOHO_DC,ZOHO_FROM_EMAIL:env.ZOHO_FROM_EMAIL}}); const event=id();
  let result={success:false,reason:'Zoho is not configured'};
  if(await provider.ready())result=await provider.sendEmail({to,subject,body});
  await env.URBAN_PROCURE_DB.prepare('INSERT INTO email_log(id,recipient,kind,status,provider_id,error_code) VALUES(?,?,?,?,?,?)').bind(event,to,kind,result.success?'sent':'pending_provider',result.messageId||null,result.success?null:clean(result.reason,100)).run();
  return result;
}
async function issueSession(db,user) {
  const token=random();const expires=new Date(Date.now()+7*86400000).toISOString();
  await db.prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)').bind(id(),user.id,await sha(token),expires).run();
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
  return r.ok && (await r.json()).success===true;
}
async function handle(request,env) {
  const db=env.URBAN_PROCURE_DB;if(!db)return bad('Database unavailable',503);
  const path=new URL(request.url).pathname,method=request.method;
  const user=await actor(request,env);
  if(path==='/api/native/documents'&&method==='POST') {
    const error=requireRole(user,['client','vendor','admin']);if(error)return error;
    const form=await request.formData();const file=form.get('file'),kind=clean(form.get('kind'),30),ownerId=clean(form.get('owner_id'),100);
    if(!(file instanceof File)||file.size<1||file.size>10_000_000||!['application/pdf','image/jpeg','image/png'].includes(file.type))return bad('PDF, JPEG or PNG under 10 MB required');
    if(!['rfq','quotation','site_visit'].includes(kind))return bad('Invalid document type');
    const owner=kind==='rfq'?await db.prepare('SELECT c.owner_user_id FROM rfqs r JOIN companies c ON c.id=r.client_company_id WHERE r.id=?').bind(ownerId).first():kind==='quotation'?await db.prepare('SELECT c.owner_user_id FROM quotations q JOIN companies c ON c.id=q.vendor_company_id WHERE q.id=?').bind(ownerId).first():null;
    if(user.role!=='admin'&&owner?.owner_user_id!==user.id)return bad('Document owner required',403);
    const bucket=kind==='quotation'?env.URBAN_PROCURE_QUOTE_DOCUMENTS:env.URBAN_PROCURE_RFQ_DOCUMENTS;
    if(!bucket)return bad('Private storage unavailable',503);
    const docId=id(),key=`private/${kind}/${ownerId}/${docId}`;
    await bucket.put(key,file.stream(),{httpMetadata:{contentType:file.type}});
    await db.prepare('INSERT INTO documents(id,owner_kind,owner_id,uploaded_by,storage_key,original_name,mime_type,size_bytes) VALUES(?,?,?,?,?,?,?,?)').bind(docId,kind,ownerId,user.id,key,clean(file.name,180),file.type,file.size).run();
    await audit(db,user,'document',docId,'uploaded',{kind});return json({ok:true,id:docId,review_status:'pending'},201);
  }
  const documentMatch=path.match(/^\/api\/native\/documents\/([^/]+)$/);
  if(documentMatch&&method==='GET') {
    const error=requireRole(user,['client','vendor','admin']);if(error)return error;
    const doc=await db.prepare('SELECT * FROM documents WHERE id=?').bind(documentMatch[1]).first();if(!doc)return bad('Not found',404);
    if(user.role!=='admin'&&doc.uploaded_by!==user.id)return bad('Access denied',403);
    const bucket=doc.owner_kind==='quotation'?env.URBAN_PROCURE_QUOTE_DOCUMENTS:env.URBAN_PROCURE_RFQ_DOCUMENTS;
    const object=await bucket?.get(doc.storage_key);if(!object)return bad('Not found',404);
    return new Response(object.body,{headers:{'Content-Type':doc.mime_type,'Content-Disposition':'attachment; filename="document"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
  }
  if(path==='/api/native/health'&&method==='GET')return json({ok:true,database:true,emailConfigured:!!(env.ZOHO_CLIENT_ID&&env.ZOHO_CLIENT_SECRET&&env.ZOHO_REFRESH_TOKEN&&env.ZOHO_ACCOUNT_ID),turnstileConfigured:!!env.TURNSTILE_SECRET});
  const body=method==='POST'||method==='PATCH'?await request.json().catch(()=>({})):{};
  if(path==='/api/native/auth/register'&&method==='POST') {
    const address=clean(body.email,200).toLowerCase(),role=clean(body.role,20);
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)||!['client','vendor'].includes(role)||String(body.password||'').length<12)return bad('Valid email, role and password of at least 12 characters required');
    if(role==='vendor' && body.accept_vendor_terms!==true)return bad('Vendor Terms acceptance is required');
    const salt=random(),uid=id(),companyId=id();
    const agreement=role==='vendor'?await db.prepare("SELECT version,agreement_hash FROM agreement_versions WHERE kind='vendor' AND active=1").first():null;
    if(role==='vendor'&&!agreement)return bad('Vendor Terms are not published',503);
    const company=clean(body.company_name,180),contact=clean(body.contact_name,180);
    if(!company||!contact)return bad('Company and contact person are required');
    const statements=[db.prepare('INSERT INTO users(id,email,password_hash,password_salt,role) VALUES(?,?,?,?,?)').bind(uid,address,await passwordHash(body.password,salt),salt,role),db.prepare('INSERT INTO companies(id,owner_user_id,role,company_name,contact_name,contact_email,phone,trade_license_no,license_expiry,categories,emirate) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(companyId,uid,role,company,contact,address,clean(body.phone,60),clean(body.trade_license_no,120),body.license_expiry||null,JSON.stringify(body.categories||[]),clean(body.emirate,80))];
    if(agreement)statements.push(db.prepare('INSERT INTO agreement_acceptances(id,user_id,company_id,agreement_type,version,agreement_hash,accepted_at,ip_address,user_agent,service_charge_terms) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id(),uid,companyId,'vendor',agreement.version,agreement.agreement_hash,now(),request.headers.get('CF-Connecting-IP'),request.headers.get('User-Agent'),JSON.stringify({general:{rate:.025,minimum_aed:500},manpower:{aed_per_labourer_hour:1}})));
    await db.batch(statements);
    const verification=random();await db.prepare('INSERT INTO auth_tokens(id,user_id,token_hash,purpose,expires_at) VALUES(?,?,?,?,?)').bind(id(),uid,await sha(verification),'verify',new Date(Date.now()+86400000).toISOString()).run();
    await email(env,address,'verification','Verify your Urban Procures account',`${new URL(request.url).origin}/verify-email?token=${encodeURIComponent(verification)}`);
    await audit(db,{id:uid},'user',uid,'registration',{role});return json({ok:true,verificationRequired:true},201);
  }
  if(path==='/api/native/auth/verify'&&method==='POST') {
    const token=await db.prepare("SELECT * FROM auth_tokens WHERE token_hash=? AND purpose='verify' AND consumed_at IS NULL AND expires_at>?").bind(await sha(clean(body.token,200)),now()).first();if(!token)return bad('Invalid or expired token');
    await db.batch([db.prepare('UPDATE auth_tokens SET consumed_at=? WHERE id=?').bind(now(),token.id),db.prepare('UPDATE users SET verified_at=? WHERE id=?').bind(now(),token.user_id)]);return json({ok:true});
  }
  if(path==='/api/native/auth/login'&&method==='POST') {
    const row=await db.prepare('SELECT * FROM users WHERE email=?').bind(clean(body.email,200).toLowerCase()).first();
    if(!row||await passwordHash(String(body.password||''),row.password_salt)!==row.password_hash)return bad('Invalid credentials',401);
    if(!row.verified_at)return bad('Email verification required',403);
    return sessionResponse(row,await issueSession(db,row));
  }
  if(path==='/api/native/auth/logout'&&method==='POST') {
    const token=request.headers.get('Cookie')?.match(/up_session=([^;]+)/)?.[1];if(token)await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha(token)).run();
    const out=json({ok:true});out.headers.set('Set-Cookie','up_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');return out;
  }
  if(path==='/api/native/auth/reset/request'&&method==='POST') {
    const address=clean(body.email,200).toLowerCase();const found=await db.prepare('SELECT id FROM users WHERE email=?').bind(address).first();
    if(found){const token=random();await db.prepare('INSERT INTO auth_tokens(id,user_id,token_hash,purpose,expires_at) VALUES(?,?,?,?,?)').bind(id(),found.id,await sha(token),'reset',new Date(Date.now()+3600000).toISOString()).run();await email(env,address,'password_reset','Reset your Urban Procures password',`${new URL(request.url).origin}/reset-password?token=${encodeURIComponent(token)}`)}
    return json({ok:true});
  }
  if(path==='/api/native/auth/reset/confirm'&&method==='POST') {
    const token=await db.prepare("SELECT * FROM auth_tokens WHERE token_hash=? AND purpose='reset' AND consumed_at IS NULL AND expires_at>?").bind(await sha(clean(body.token,200)),now()).first();
    if(!token||String(body.password||'').length<12)return bad('Invalid reset token or password');
    const salt=random();await db.batch([db.prepare('UPDATE users SET password_hash=?,password_salt=? WHERE id=?').bind(await passwordHash(body.password,salt),salt,token.user_id),db.prepare('UPDATE auth_tokens SET consumed_at=? WHERE id=?').bind(now(),token.id),db.prepare('DELETE FROM sessions WHERE user_id=?').bind(token.user_id)]);
    await audit(db,{id:token.user_id},'user',token.user_id,'password_reset');return json({ok:true});
  }
  if(path==='/api/native/auth/me'&&method==='GET')return user?json({ok:true,user}):bad('Authentication required',401);
  if(path==='/api/native/public/requests'&&method==='POST') {
    if(!await verifyTurnstile(body.turnstile_token,request,env))return bad('Verification required',403);
    const clientHash=await sha((request.headers.get('CF-Connecting-IP')||'unknown')+':'+(env.RATE_LIMIT_SALT||'urbanprocures'));
    const hour=now().slice(0,13);await db.prepare('INSERT OR IGNORE INTO public_rate_limits(client_hash,hour,attempts) VALUES(?,?,0)').bind(clientHash,hour).run();
    const attempt=await db.prepare('UPDATE public_rate_limits SET attempts=attempts+1 WHERE client_hash=? AND hour=? AND attempts<5').bind(clientHash,hour).run();
    if(!attempt.meta.changes)return bad('Please try again later',429);
    const name=clean(body.name,160),phone=clean(body.phone,60),address=clean(body.location,500),title=clean(body.title,220),scope=clean(body.scope,20000),category=clean(body.category,120),addressEmail=clean(body.email,200);
    if(!name||!phone||!address||!title||!scope||!category||!addressEmail)return bad('Complete all required request details');
    const rid=id(),reference='UP-'+crypto.randomUUID().slice(0,8).toUpperCase();
    const visit=body.site_visit===true;
    const statements=[db.prepare('INSERT INTO public_requests(id,reference,name,phone,email,location,category,title,scope,visit_requested) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(rid,reference,name,phone,addressEmail,address,category,title,scope,visit?1:0)];
    if(visit)statements.push(db.prepare('INSERT INTO site_visits(id,request_id,payment_status,appointment_at) VALUES(?,?,?,?)').bind(id(),rid,'unpaid',clean(body.preferred_appointment,40)||null));
    await db.batch(statements);await audit(db,null,'public_request',rid,'created',{siteVisit:visit});
    return json({ok:true,reference,site_visit:visit?{amount_aed:100,payment_status:'unpaid',status:'requested'}:null},201);
  }
  const visitMatch=path.match(/^\/api\/native\/admin\/site-visits\/([^/]+)$/);
  if(visitMatch&&method==='PATCH') {
    const error=requireRole(user,['admin']);if(error)return error;
    const row=await db.prepare('SELECT * FROM site_visits WHERE id=?').bind(visitMatch[1]).first();if(!row)return bad('Not found',404);
    const next=clean(body.payment_status||row.payment_status,30);
    if(!['unpaid','pending_manual','paid','waived','refunded'].includes(next))return bad('Invalid payment state');
    if(next==='paid'&&!clean(body.payment_reference||row.payment_reference,100))return bad('Payment reference required');
    await db.prepare('UPDATE site_visits SET payment_status=?,payment_reference=?,appointment_at=?,inspection_notes=?,measurements=?,status=?,updated_at=? WHERE id=?').bind(next,clean(body.payment_reference||row.payment_reference,100),body.appointment_at||row.appointment_at,clean(body.inspection_notes||row.inspection_notes,20000),clean(body.measurements||row.measurements,20000),clean(body.status||row.status,50),now(),row.id).run();
    await audit(db,user,'site_visit',row.id,'updated',{paymentStatus:next});return json({ok:true});
  }
  if(path==='/api/native/admin/site-visits'&&method==='GET') {
    const error=requireRole(user,['admin']);if(error)return error;
    const visits=await db.prepare('SELECT v.*,p.reference,p.name,p.phone,p.email,p.location,p.title,p.scope FROM site_visits v JOIN public_requests p ON p.id=v.request_id ORDER BY v.updated_at DESC LIMIT 100').all();return json({ok:true,visits:visits.results});
  }
  const verifyCompany=path.match(/^\/api\/native\/admin\/companies\/([^/]+)\/verify$/);
  if(verifyCompany&&method==='POST') {
    const error=requireRole(user,['admin']);if(error)return error;
    const next=body.status==='verified'?'verified':body.status==='rejected'?'rejected':null;if(!next)return bad('Invalid verification decision');
    await db.prepare('UPDATE companies SET verification_status=?,verified_at=? WHERE id=?').bind(next,next==='verified'?now():null,verifyCompany[1]).run();
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
    let result;
    try{result=await email(env,prospect.email,'invitation',subject,message)}catch{result={success:false}}
    if(!result.success){await db.prepare('UPDATE email_quota SET reserved=reserved-1 WHERE day=? AND reserved>0').bind(day).run();return bad('Delivery was not confirmed',503)}
    await db.prepare("UPDATE prospects SET status='invited' WHERE id=?").bind(prospect.id).run();await audit(db,user,'prospect',prospect.id,'invited');return json({ok:true});
  }
  if(path==='/api/native/rfqs'&&method==='POST') {
    const error=requireRole(user,['client','admin']);if(error)return error;
    const company=user.role==='client'?await db.prepare("SELECT id FROM companies WHERE owner_user_id=? AND role='client'").bind(user.id).first():null;
    const publicRequest=body.public_request_id&&user.role==='admin'?await db.prepare('SELECT * FROM public_requests WHERE id=?').bind(body.public_request_id).first():null;
    if(user.role==='client'&&!company)return bad('Company profile required',403);
    if(body.public_request_id&&!publicRequest)return bad('Public request not found',404);
    if(publicRequest){const visit=await db.prepare('SELECT * FROM site_visits WHERE request_id=?').bind(publicRequest.id).first();if(visit&&!['paid','waived'].includes(visit.payment_status))return bad('Site visit payment has not been confirmed',409);if(visit&&visit.status!=='completed')return bad('Inspection must be completed',409)}
    const title=clean(body.title||publicRequest?.title,220),category=clean(body.category||publicRequest?.category,120),original=clean(body.scope||publicRequest?.scope,20000),sanitized=clean(body.sanitized_scope,20000);
    if(!title||!category||!original||!sanitized)return bad('Title, category, original and reviewed sanitized scope required');
    const rid=id(),reference='RFQ-'+crypto.randomUUID().slice(0,8).toUpperCase();
    await db.prepare('INSERT INTO rfqs(id,reference,client_company_id,public_request_id,title,category,sanitized_scope,original_scope,location_private,emirate,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(rid,reference,company?.id||null,publicRequest?.id||null,title,category,sanitized,original,clean(body.location||publicRequest?.location,500),clean(body.emirate,80),'under_review').run();
    if(publicRequest)await db.prepare('UPDATE site_visits SET rfq_id=? WHERE request_id=?').bind(rid,publicRequest.id).run();
    await audit(db,user,'rfq',rid,'created');return json({ok:true,id:rid,reference},201);
  }
  const rfqMatch=path.match(/^\/api\/native\/rfqs\/([^/]+)$/);
  if(rfqMatch&&method==='GET') {
    const error=requireRole(user,['client','vendor','admin']);if(error)return error;
    const rfq=await db.prepare('SELECT * FROM rfqs WHERE id=?').bind(rfqMatch[1]).first();if(!rfq)return bad('Not found',404);
    const client=rfq.client_company_id?await db.prepare('SELECT * FROM companies WHERE id=?').bind(rfq.client_company_id).first():null;
    const isOwner=client?.owner_user_id===user.id, isAdmin=user.role==='admin';
    const vendor=user.role==='vendor'?await db.prepare('SELECT id FROM companies WHERE owner_user_id=?').bind(user.id).first():null;
    const invited=vendor?await db.prepare('SELECT id FROM rfq_invitations WHERE rfq_id=? AND vendor_company_id=?').bind(rfq.id,vendor.id).first():null;
    if(!isOwner&&!isAdmin&&!invited)return bad('Access denied',403);
    const award=await db.prepare('SELECT * FROM awards WHERE rfq_id=?').bind(rfq.id).first();
    const isWinner=award?.vendor_company_id===vendor?.id;
    const safe={id:rfq.id,reference:rfq.reference,title:rfq.title,category:rfq.category,scope:rfq.sanitized_scope,emirate:rfq.emirate,status:rfq.status,closing_at:rfq.closing_at};
    if(isOwner||isAdmin||isWinner){safe.client=isOwner||isAdmin?client:{company_name:client?.company_name,contact_name:client?.contact_name,contact_email:client?.contact_email,phone:client?.phone};safe.location=rfq.location_private}
    const quotations=isOwner||isAdmin?await db.prepare('SELECT * FROM quotations WHERE rfq_id=? ORDER BY created_at').bind(rfq.id).all():{results:[]};
    safe.quotations=await Promise.all(quotations.results.map(async(q,index)=>{const response={id:q.id,amount_aed:q.amount_fils/100,notes:q.sanitized_notes,vendor_label:'Vendor '+String.fromCharCode(65+index)};if(isAdmin||award?.quotation_id===q.id){response.vendor=await db.prepare('SELECT company_name,contact_name,contact_email,phone FROM companies WHERE id=?').bind(q.vendor_company_id).first()}return response}));
    return json({ok:true,rfq:safe});
  }
  const publishMatch=path.match(/^\/api\/native\/admin\/rfqs\/([^/]+)\/publish$/);
  if(publishMatch&&method==='POST') {
    const error=requireRole(user,['admin']);if(error)return error;
    const row=await db.prepare('SELECT * FROM rfqs WHERE id=?').bind(publishMatch[1]).first();if(!row)return bad('Not found',404);
    if(row.status!=='under_review'||!row.sanitized_scope)return bad('RFQ is not ready to publish',409);
    await db.prepare("UPDATE rfqs SET status='quoting',published_at=? WHERE id=?").bind(now(),row.id).run();await audit(db,user,'rfq',row.id,'published');return json({ok:true});
  }
  const inviteMatch=path.match(/^\/api\/native\/admin\/rfqs\/([^/]+)\/invite$/);
  if(inviteMatch&&method==='POST') {
    const error=requireRole(user,['admin']);if(error)return error;
    const vendor=await db.prepare("SELECT * FROM companies WHERE id=? AND role='vendor' AND verification_status='verified'").bind(body.vendor_company_id).first();if(!vendor)return bad('Verified vendor required',409);
    const rfq=await db.prepare("SELECT id FROM rfqs WHERE id=? AND status='quoting'").bind(inviteMatch[1]).first();if(!rfq)return bad('RFQ is not open',409);
    await db.prepare('INSERT OR IGNORE INTO rfq_invitations(id,rfq_id,vendor_company_id) VALUES(?,?,?)').bind(id(),rfq.id,vendor.id).run();await audit(db,user,'rfq',rfq.id,'vendor_invited',{vendorId:vendor.id});return json({ok:true});
  }
  const quoteMatch=path.match(/^\/api\/native\/rfqs\/([^/]+)\/quotations$/);
  if(quoteMatch&&method==='POST') {
    const error=requireRole(user,['vendor']);if(error)return error;
    const vendor=await db.prepare("SELECT * FROM companies WHERE owner_user_id=? AND role='vendor' AND verification_status='verified'").bind(user.id).first();if(!vendor)return bad('Vendor verification required',403);
    const invitation=await db.prepare('SELECT r.id,r.category FROM rfq_invitations i JOIN rfqs r ON r.id=i.rfq_id WHERE i.rfq_id=? AND i.vendor_company_id=? AND r.status=?').bind(quoteMatch[1],vendor.id,'quoting').first();if(!invitation)return bad('Invitation required',403);
    const amount=Number(body.amount_aed);if(!Number.isFinite(amount)||amount<0)return bad('Valid quotation amount required');
    const qid=id();await db.prepare('INSERT INTO quotations(id,rfq_id,vendor_company_id,amount_fils,sanitized_notes,private_notes,labourer_count,hours_per_labourer) VALUES(?,?,?,?,?,?,?,?)').bind(qid,invitation.id,vendor.id,Math.round(amount*100),clean(body.sanitized_notes,10000),clean(body.private_notes,10000),body.labourer_count||null,body.hours_per_labourer||null).run();
    await audit(db,user,'quotation',qid,'submitted');return json({ok:true,id:qid},201);
  }
  const awardMatch=path.match(/^\/api\/native\/rfqs\/([^/]+)\/award$/);
  if(awardMatch&&method==='POST') {
    const error=requireRole(user,['client']);if(error)return error;
    const rfq=await db.prepare('SELECT r.* FROM rfqs r JOIN companies c ON c.id=r.client_company_id WHERE r.id=? AND c.owner_user_id=?').bind(awardMatch[1],user.id).first();if(!rfq||rfq.status!=='quoting')return bad('RFQ is not available for award',403);
    const q=await db.prepare('SELECT * FROM quotations WHERE id=? AND rfq_id=?').bind(body.quotation_id,rfq.id).first();if(!q)return bad('Quotation not found',404);
    const existing=await db.prepare('SELECT id FROM awards WHERE rfq_id=?').bind(rfq.id).first();if(existing)return bad('RFQ already awarded',409);
    const fee=calculateVendorServiceCharge({category:rfq.category,awardedValue:q.amount_fils/100,labourers:q.labourer_count,hoursPerLabourer:q.hours_per_labourer});
    const aid=id();await db.batch([db.prepare('INSERT INTO awards(id,rfq_id,quotation_id,client_user_id,vendor_company_id,awarded_amount_fils) VALUES(?,?,?,?,?,?)').bind(aid,rfq.id,q.id,user.id,q.vendor_company_id,q.amount_fils),db.prepare('INSERT INTO service_charges(id,award_id,basis,rate,labourer_count,hours_per_labourer,amount_fils) VALUES(?,?,?,?,?,?,?)').bind(id(),aid,fee.calculationBasis,fee.ratePerLabourerHour||fee.percentage,q.labourer_count,q.hours_per_labourer,Math.round(fee.serviceFee*100)),db.prepare("UPDATE rfqs SET status='awarded' WHERE id=?").bind(rfq.id)]);
    await audit(db,user,'award',aid,'confirmed',{quotationId:q.id,identityReleasedTo:q.vendor_company_id,serviceChargeAed:fee.serviceFee});return json({ok:true,award_id:aid,service_charge_aed:fee.serviceFee},201);
  }
  return bad('Not found',404);
}
export async function handleNative(request,env) {try{return await handle(request,env)}catch(error){console.error('Native API failure',error?.name);return bad('Request could not be completed',500)}}
