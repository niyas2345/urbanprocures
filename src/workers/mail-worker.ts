import { Router } from "itty-router";
import { sendMailgun } from "../lib/mailgun";
import { queueMail, updateMailStatus } from "../lib/kv";
import { sendZohoMail } from "../lib/zoho-mail";
import type { Env, MailQueue } from "../lib/types";
import { authMiddleware, errorHandler, HttpError, isResponse, jsonResponse, readJson, requestLogger } from "./middleware";
import { validateEmail } from "../lib/auth";

const router = Router();

const requireAuth = async (request: Request, env: Env) => {
  const auth = await authMiddleware(request, env);
  if (isResponse(auth)) throw new HttpError(401, "Unauthorized");
  return auth;
};

router.post("/api/mail/queue", async (request: Request, env: Env) => {
  await requireAuth(request, env);
  const body = await readJson<{ recipient: string; subject: string; body: string; project_id?: string }>(request);
  if (!validateEmail(body.recipient)) throw new HttpError(400, "Invalid recipient email");
  if (!body.subject || !body.body) throw new HttpError(400, "Missing subject or body");
  const mail: MailQueue = {
    id: crypto.randomUUID(),
    recipient: body.recipient,
    subject: body.subject,
    body: body.body,
    project_id: body.project_id,
    status: "pending",
    attempts: 0,
    created_at: new Date().toISOString(),
    sent_at: null,
    error_msg: null,
  };
  await queueMail(env, mail);
  return jsonResponse({ mail_id: mail.id, status: mail.status }, 201);
});

router.get("/api/mail/queue/:mailId", async (request: Request, env: Env, ctx: { params: { mailId: string } }) => {
  await requireAuth(request, env);
  const mail = await env.KV.get(`mail:${ctx.params.mailId}`, "json");
  if (!mail) throw new HttpError(404, "Mail not found");
  return jsonResponse({ mail });
});

router.get("/api/mail/status", async (request: Request, env: Env) => {
  await requireAuth(request, env);
  const status = new URL(request.url).searchParams.get("status");
  const page = await env.KV.list({ prefix: "mail:" });
  const mails = (await Promise.all(page.keys.map((key) => env.KV.get<MailQueue>(key.name, "json")))).filter(
    (mail): mail is MailQueue => mail !== null && (!status || mail.status === status),
  );
  return jsonResponse(mails);
});

router.post("/api/notification/send", async (request: Request, env: Env) => {
  const { mail_id } = await readJson<{ mail_id: string }>(request);
  const mail = await env.KV.get<MailQueue>(`mail:${mail_id}`, "json");
  if (!mail) throw new HttpError(404, "Mail not found");
  try {
    const result = env.ZOHO_CLIENT_ID
      ? await sendZohoMail(env, mail.recipient, mail.subject, mail.body)
      : await sendMailgun(env, mail.recipient, mail.subject, mail.body);
    await updateMailStatus(env, mail.id, "sent");
    return jsonResponse({ sent: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown mail error";
    await env.KV.put(`mail:${mail.id}`, JSON.stringify({ ...mail, status: "failed", attempts: mail.attempts + 1, error_msg: message }));
    throw new HttpError(500, message);
  }
});

router.all("*", () => jsonResponse({ error: "Not found" }, 404));

export default {
  fetch: (request: Request, env: Env): Promise<Response> => {
    requestLogger(request);
    return router.fetch(request, env).catch((error: Error) => errorHandler(error, new URL(request.url).pathname));
  },
};
