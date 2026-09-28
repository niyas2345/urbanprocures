import { Router } from "itty-router";
import type { Env } from "../lib/types";
import { authMiddleware, errorHandler, HttpError, isResponse, jsonResponse, requestLogger } from "./middleware";

const router = Router();
const enc = new TextEncoder();

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const verifySignature = async (request: Request, env: Env, body: string): Promise<void> => {
  const signature = request.headers.get("X-Webhook-Signature") ?? "";
  const key = await crypto.subtle.importKey("raw", enc.encode(env.WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = hex(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  if (!signature || digest !== signature) throw new HttpError(401, "Invalid signature");
};

router.post("/api/webhook/events", async (request: Request, env: Env) => {
  const raw = await request.text();
  await verifySignature(request, env, raw);
  const event = JSON.parse(raw) as { event_type?: string; payload?: unknown };
  if (!event.event_type) throw new HttpError(400, "Malformed event");
  const id = crypto.randomUUID();
  await env.KV.put(`webhook:${id}`, JSON.stringify({ id, ...event, timestamp: new Date().toISOString() }));
  return jsonResponse({ received: true });
});

router.get("/api/webhook/logs", async (request: Request, env: Env) => {
  const auth = await authMiddleware(request, env);
  if (isResponse(auth)) return auth;
  const page = await env.KV.list({ prefix: "webhook:", limit: 100 });
  const logs = (await Promise.all(page.keys.map((key) => env.KV.get(key.name, "json")))).filter(Boolean);
  return jsonResponse(logs);
});

router.all("*", () => jsonResponse({ error: "Not found" }, 404));

export default {
  fetch: (request: Request, env: Env): Promise<Response> => {
    requestLogger(request);
    return router.fetch(request, env).catch((error: Error) => errorHandler(error, new URL(request.url).pathname));
  },
};
