import { backupAgent } from "./agents/backup-agent";
import { notificationAgent } from "./agents/notification-agent";
import authWorker from "./workers/auth-worker";
import mailWorker from "./workers/mail-worker";
import nativeWorker from "./workers/native-worker";
import projectsWorker from "./workers/projects-worker";
import webhookWorker from "./workers/webhook-worker";
import type { Env } from "./lib/types";

const notFound = (): Response =>
  new Response(JSON.stringify({ success: false, error: "Not found", timestamp: new Date().toISOString() }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/native/")) return nativeWorker.fetch(request, env);
    if (path.startsWith("/api/auth/")) return authWorker.fetch(request, env);
    if (path.startsWith("/api/projects")) return projectsWorker.fetch(request, env);
    if (path.startsWith("/api/mail/") || path.startsWith("/api/notification/")) return mailWorker.fetch(request, env);
    if (path.startsWith("/api/webhook/")) return webhookWorker.fetch(request, env);
    return env.ASSETS.fetch(request).catch(() => notFound());
  },
  scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): void {
    if (event.cron === "0 2 * * *") ctx.waitUntil(backupAgent(env));
    else ctx.waitUntil(notificationAgent(env));
  },
};
