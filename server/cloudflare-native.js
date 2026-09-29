import { calculateVendorServiceCharge } from './commercial/service-fee.js';
import { ZohoEmailProvider } from './ai/outreach-provider.js';
import { scanIdentityLeakage } from './ai/identity-scan.js';

const json = (data, status=200) => new Response(JSON.stringify(data), {status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const bad = (message,status=400) => json({ok:false,error:message},status);
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const clean = (value,max=1000) => String(value??'').trim().slice(0,max);
const sha = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join('');
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const random = () => b64(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');

async function passwordHash(password,salt) {
  const input=`urban-procures-native-v1:${salt}:${password}`;
  return sha(input);
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
function mailFrom(env,kind) {
  const growth=env.ZOHO_FROM_GROWTH||'vendors@urbanprocures.com';
  const rfq=env.ZOHO_FROM_RFQ||'rfq@urbanprocures.com';
  const system=env.ZOHO_FROM_SYSTEM||'no-reply@urbanprocures.com';
  const award=env.ZOHO_FROM_AWARD||'awards@urbanprocures.com';
  if(kind==='invitation')return growth;
  if(kind==='rfq_invite'||kind==='quote_reminder')return rfq;
  if(kind==='award')return award;
  if(kind==='verification'||kind==='password_reset'||kind==='summary')return system;
  return system;
}
function mailMap(env) {
  return {
    invitation: mailFrom(env,'invitation'),
    rfq_invite: mailFrom(env,'rfq_invite'),
    verification: mailFrom(env,'verification'),
    password_reset: mailFrom(env,'password_reset'),
    award: mailFrom(env,'award'),
    summary_to: env.ZOHO_SUMMARY_TO||'admin@urbanprocures.com',
    desk_inbox: 'desk@urbanprocures.com'
  };
}
async function email(env,to,kind,subject,body) {
  const fromAddress=mailFrom(env,kind);
  const provider=new ZohoEmailProvider({env:{ZOHO_CLIENT_ID:env.ZOHO_CLIENT_ID,ZOHO_CLIENT_SECRET:env.ZOHO_CLIENT_SECRET,ZOHO_REFRESH_TOKEN:env.ZOHO_REFRESH_TOKEN,ZOHO_ACCOUNT_ID:env.ZOHO_ACCOUNT_ID,ZOHO_DC:env.ZOHO_DC,ZOHO_FROM_EMAIL:fromAddress}}); const event=id();
  let result={success:false,reason:'Zoho is not configured'};
  if(await provider.ready())result=await provider.sendEmail({to,subject,body});
  await env.URBAN_PROCURE_DB.prepare('INSERT INTO email_log(id,recipient,kind,status,provider_id,error_code) VALUES(?,?,?,?,?,?)').bind(event,to,kind,result.success?'sent':'pending_provider',result.messageId||null,result.success?null:clean(result.reason,100)).run();
  return result;
}
