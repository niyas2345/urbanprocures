import { checkMailgunQuota, sendMailgun } from "../lib/mailgun";
import { sendZohoMail } from "../lib/zoho-mail";
import type { Env, MailQueue } from "../lib/types";

export const notificationAgent = async (env: Env): Promise<void> => {
  console.info("Notification agent started");
  const page = await env.KV.list({ prefix: "mail:" });
  let sent = 0;
  let failed = 0;
  let retrying = 0;

  for (const key of page.keys.slice(0, 10)) {
    const mail = await env.KV.get<MailQueue>(key.name, "json");
    if (!mail || mail.status !== "pending") continue;
    const attempts = mail.attempts + 1;
    try {
      const result = env.ZOHO_CLIENT_ID
        ? await sendZohoMail(env, mail.recipient, mail.subject, mail.body)
        : await sendMailgun(env, mail.recipient, mail.subject, mail.body);
      await env.KV.put(key.name, JSON.stringify({ ...mail, attempts, status: "sent", sent_at: new Date().toISOString(), provider_result: result }));
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown mail send error";
      const status = attempts >= 3 ? "failed" : "pending";
      await env.KV.put(key.name, JSON.stringify({ ...mail, attempts, status, error_msg: message }));
      if (status === "failed") failed += 1;
      else retrying += 1;
      if (status === "failed") {
        await env.KV.put(`webhook:${crypto.randomUUID()}`, JSON.stringify({ event_type: "mail.failed", payload: { mail_id: mail.id, error: message }, timestamp: new Date().toISOString() }));
      }
    }
  }

  if (env.MAILGUN_API_KEY) {
    const quota = await checkMailgunQuota(env);
    if (quota.remaining < 10) console.warn(`Mailgun quota low: ${quota.remaining} emails remaining`);
  }
  console.info(`Sent ${sent}, Failed ${failed}, Retrying ${retrying}`);
};

export const handleScheduled = async (event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> => {
  ctx.waitUntil(notificationAgent(env));
};
