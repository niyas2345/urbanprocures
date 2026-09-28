import type { Env } from "./types";

export const validateMailgunConfig = (env: Env): boolean =>
  Boolean(env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN && env.MAILGUN_SENDER_EMAIL);

export const checkMailgunQuota = async (env: Env): Promise<{ sent_today: number; limit: number; remaining: number }> => {
  const date = new Date().toISOString().slice(0, 10);
  const sent = Number((await env.KV.get(`mailgun:sent:${date}`)) ?? 0);
  return { sent_today: sent, limit: 100, remaining: Math.max(100 - sent, 0) };
};

export const sendMailgun = async (
  env: Env,
  recipient: string,
  subject: string,
  body: string,
): Promise<{ messageId: string; status: string }> => {
  if (!validateMailgunConfig(env)) throw new Error("Mailgun configuration missing");
  const quota = await checkMailgunQuota(env);
  if (quota.remaining <= 0) throw new Error("Mailgun daily quota exceeded");

  const form = new FormData();
  form.set("from", env.MAILGUN_SENDER_EMAIL);
  form.set("to", recipient);
  form.set("subject", subject);
  form.set("html", body);

  const response = await fetch(`https://api.mailgun.net/v3/${env.MAILGUN_DOMAIN}/messages`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`api:${env.MAILGUN_API_KEY}`)}` },
    body: form,
  });
  if (!response.ok) throw new Error(`Mailgun send failed: ${response.status}`);
  const data = (await response.json()) as { id?: string; message?: string };
  const date = new Date().toISOString().slice(0, 10);
  await env.KV.put(`mailgun:sent:${date}`, String(quota.sent_today + 1), { expirationTtl: 48 * 60 * 60 });
  return { messageId: data.id ?? crypto.randomUUID(), status: data.message ?? "success" };
};
