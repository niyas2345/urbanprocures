import {ZohoEmailProvider} from './ai/outreach-provider.js';
export async function inspectOperations(env){
  const db=env.URBAN_PROCURE_DB,at=new Date().toISOString();
  const jobs=await db.prepare("SELECT count(*) AS overdue FROM jobs WHERE kind='transactional_email' AND status IN ('queued','sending') AND datetime(created_at)<datetime('now','-15 minutes')").first();
  const failures=await db.prepare("SELECT count(*) AS failed FROM jobs WHERE kind='transactional_email' AND status='failed' AND datetime(created_at)>datetime('now','-30 minutes')").first();
  const unhealthy=jobs.overdue>0||failures.failed>=3;
  const previous=await db.prepare("SELECT * FROM operations_alerts WHERE id='email-delivery'").first();
  await db.prepare("INSERT INTO operations_alerts(id,kind,state,last_seen_at,detail) VALUES('email-delivery','email',?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,last_seen_at=excluded.last_seen_at,detail=excluded.detail").bind(unhealthy?'open':'resolved',at,JSON.stringify({overdue:jobs.overdue,failed:failures.failed})).run();
  await db.prepare("INSERT INTO operations_alerts(id,kind,state,last_seen_at) VALUES('maintenance-heartbeat','scheduled_job','resolved',?) ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at").bind(at).run();
  if(unhealthy&&env.APP_ENV!=='preview'&&(!previous?.notified_at||Date.now()-Date.parse(previous.notified_at)>3600000)){
    const admin=await db.prepare("SELECT email FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").first();
    if(admin){const provider=new ZohoEmailProvider({env:{ZOHO_CLIENT_ID:env.ZOHO_CLIENT_ID,ZOHO_CLIENT_SECRET:env.ZOHO_CLIENT_SECRET,ZOHO_REFRESH_TOKEN:env.ZOHO_REFRESH_TOKEN,ZOHO_ACCOUNT_ID:env.ZOHO_ACCOUNT_ID,ZOHO_DC:env.ZOHO_DC,ZOHO_FROM_EMAIL:env.ZOHO_FROM_EMAIL}});
      const sent=await provider.sendEmail({to:admin.email,subject:'Urban Procures operational alert: email delivery',body:`Transactional email delivery needs attention. Overdue jobs: ${jobs.overdue}. Recent failures: ${failures.failed}. Open the operations dashboard to investigate. No credentials or customer details are included in this notification.`});
      if(sent.success)await db.prepare("UPDATE operations_alerts SET notified_at=? WHERE id='email-delivery'").bind(at).run();
    }
  }
  return {emailHealthy:!unhealthy,overdue:jobs.overdue,failed:failures.failed};
}
