export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const response = await fetch(`${env.APP_ORIGIN}/api/native/internal/email-jobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.NATIVE_JOBS_SECRET}` },
        signal: AbortSignal.timeout(55000)
      });
      if (!response.ok) throw new Error(`Email processor returned ${response.status}`);
      const result = await response.json();
      console.log("Email maintenance", { processed: result.processed, sent: result.sent });
    })());
  }
};
