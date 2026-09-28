import type { Env, MailQueue } from "../lib/types";

const backupFileName = (): string => `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

export const backupAgent = async (env: Env): Promise<void> => {
  try {
    console.info(`Backup agent started at ${new Date().toISOString()}`);
    const allKeys = await env.KV.list({ limit: 10000 });
    const backup: Record<string, unknown> = {};
    for (const key of allKeys.keys) backup[key.name] = await env.KV.get(key.name, "json");

    const backupJson = JSON.stringify(backup, null, 2);
    const fileName = backupFileName();
    await env.R2.put(fileName, backupJson, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        backup_date: new Date().toISOString(),
        key_count: String(allKeys.keys.length),
        size_bytes: String(backupJson.length),
      },
    });

    const listed = await env.R2.list({ prefix: "backup-" });
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let deleted = 0;
    for (const object of listed.objects) {
      if (object.uploaded && object.uploaded.getTime() < cutoff) {
        await env.R2.delete(object.key);
        deleted += 1;
      }
    }

    await env.KV.put("backup:latest", JSON.stringify({ fileName, timestamp: new Date().toISOString(), key_count: allKeys.keys.length, size_bytes: backupJson.length }));
    console.info(`Backup completed: ${fileName}, ${allKeys.keys.length} keys, ${backupJson.length} bytes; deleted ${deleted} old backups`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown backup error";
    console.error(`Backup failed: ${message}`);
    const alert: MailQueue = {
      id: crypto.randomUUID(),
      recipient: "admin@urbanprocures.com",
      subject: "Urban Procures backup failed",
      body: `Backup failed: ${message}`,
      status: "pending",
      attempts: 0,
      created_at: new Date().toISOString(),
      sent_at: null,
      error_msg: null,
    };
    await env.KV.put(`mail:${alert.id}`, JSON.stringify(alert));
    await env.KV.put("backup:last_error", JSON.stringify({ message, timestamp: new Date().toISOString() }));
  }
};

export const handleScheduled = async (event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> => {
  ctx.waitUntil(backupAgent(env));
};
