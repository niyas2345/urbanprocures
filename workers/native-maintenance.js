export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const health=await fetch(`${env.APP_ORIGIN}/api/native/health`,{signal:AbortSignal.timeout(10000)});
      if(!health.ok||(await health.json()).database!==true)throw new Error('Application database health probe failed');
      const homepage=await fetch(env.APP_ORIGIN,{signal:AbortSignal.timeout(10000)});
      if(!homepage.ok||!(await homepage.text()).includes('Your project.'))throw new Error('Homepage health probe failed');
      const response = await fetch(`${env.APP_ORIGIN}/api/native/internal/email-jobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.NATIVE_JOBS_SECRET}` },
        signal: AbortSignal.timeout(55000)
      });
      if (!response.ok) throw new Error(`Email processor returned ${response.status}`);
      const result = await response.json();
      console.log("Email maintenance", { processed: result.processed, sent: result.sent });
      if(result.emailHealthy===false)throw new Error('Transactional email backlog requires attention');
    })());
  }
};
