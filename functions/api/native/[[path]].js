const COOKIE = "up_session";
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const json = (body, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });

const parseJson = async (request) => {
  try {
    return await request.json();
  } catch {
    return {};
  }
};

const b64url = (input) =>
  btoa(typeof input === "string" ? input : String.fromCharCode(...new Uint8Array(input)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const fromB64url = (input) => {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  return atob(padded);
};

const secretFor = (env) =>
  env.SESSION_SECRET || env.SCHEDULED_JOBS_SECRET || env.SUPABASE_SECRET_KEY || "urban-procures-session";

const sign = async (value, env) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretFor(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
};

const makeToken = async (payload, env) => {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${await sign(body, env)}`;
};

const readSession = async (request, env) => {
  const cookie = request.headers.get("cookie") || "";
  const token = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!token || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  if ((await sign(body, env)) !== mac) return null;
  try {
    const session = JSON.parse(fromB64url(body));
    if (!session.exp || session.exp < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
};

const cookieHeader = (token) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;

const clearCookieHeader = () =>
  `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

const roleForEmail = (email, env) => {
  const adminEmail = (env.ADMIN_EMAIL || "urbanprocures@gmail.com").toLowerCase();
  if (email.toLowerCase() === adminEmail) return "admin";
  if (/(vendor|supplier|subcontractor)/i.test(email)) return "vendor";
  return "client";
};

const slug = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const prospectNames = [
  "Atlas Contracting",
  "Buildline Technical Services",
  "Emirates Project Works",
  "Gulf Prime Contractors",
  "Nexus Construction Services",
  "Palm City Contracting",
  "Skyline Works",
  "Vertex Building Solutions",
  "Al Noor Contracting",
  "Blue Ridge Technical",
  "Crescent Civil Works",
  "Desertline Projects",
  "Falcon Build Services",
  "Harbor Edge Contracting",
  "Metroline Construction",
  "Oasis Project Services",
  "Prime Axis Contracting",
  "Royal Gate Works",
  "Summit Gulf Technical",
  "Union Square Projects",
];

const makeProspects = ({ category, emirate, target }) => {
  const count = Math.min(Math.max(Number(target) || 0, 0), 100);
  const categorySlug = slug(category || "contractor");
  const emirateSlug = slug(emirate || "uae");
  return Array.from({ length: count }, (_, index) => {
    const name = `${prospectNames[index % prospectNames.length]} ${index >= prospectNames.length ? index + 1 : ""}`.trim();
    const domain = `${slug(name)}-${emirateSlug}.example.com`;
    return {
      id: crypto.randomUUID(),
      name,
      email: `vendor-${index + 1}@${domain}`,
      type: category || "Contractor",
      domain,
      emirate: emirate || "UAE",
      status: "ready",
      source: "campaign-generator",
      category_slug: categorySlug,
    };
  });
};

const inviteSubject = "Invitation to join Urban Procures";

const inviteBody = (prospect, env) => `Hello ${prospect.name},

Urban Procures is onboarding verified UAE vendors for ${prospect.type} opportunities in ${prospect.emirate}.

You can register here:
https://urbanprocures.com/signup

Regards,
Urban Procures
${env.ZOHO_SENDER_EMAIL || env.ZOHO_FROM_EMAIL || env.MAILGUN_SENDER_EMAIL || "desk@urbanprocures.com"}`;

const sendMailgunInvite = async (env, prospect) => {
  if (!env.MAILGUN_API_KEY || !env.MAILGUN_DOMAIN || !env.MAILGUN_SENDER_EMAIL) {
    return { sent: false, status: "queued", reason: "MAILGUN credentials not configured" };
  }
  const form = new FormData();
  form.set("from", env.MAILGUN_SENDER_EMAIL);
  form.set("to", prospect.email);
  form.set("subject", inviteSubject);
  form.set("text", inviteBody(prospect, env));
  const response = await fetch(`https://api.mailgun.net/v3/${env.MAILGUN_DOMAIN}/messages`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`api:${env.MAILGUN_API_KEY}`)}` },
    body: form,
  });
  if (!response.ok) {
    return { sent: false, status: "failed", reason: `MAILGUN ${response.status}` };
  }
  return { sent: true, status: "sent", reason: "MAILGUN" };
};

const sendZohoInvite = async (env, prospect) => {
  const fromAddress = env.ZOHO_SENDER_EMAIL || env.ZOHO_FROM_EMAIL;
  if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET || !env.ZOHO_REFRESH_TOKEN || !env.ZOHO_ACCOUNT_ID || !fromAddress) {
    return { sent: false, status: "queued", reason: "ZOHO credentials not configured" };
  }
  const tokenResponse = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: env.ZOHO_CLIENT_ID,
      client_secret: env.ZOHO_CLIENT_SECRET,
      refresh_token: env.ZOHO_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!tokenResponse.ok) return { sent: false, status: "failed", reason: `ZOHO token ${tokenResponse.status}` };
  const tokenData = await tokenResponse.json();
  const response = await fetch(`https://mail.zoho.com/api/accounts/${env.ZOHO_ACCOUNT_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenData.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fromAddress,
      toAddress: [prospect.email],
      subject: inviteSubject,
      content: inviteBody(prospect, env).replace(/\n/g, "<br>"),
      isHtml: true,
    }),
  });
  if (!response.ok) return { sent: false, status: "failed", reason: `ZOHO mail ${response.status}` };
  return { sent: true, status: "sent", reason: "ZOHO" };
};

const sendInvite = async (env, prospect) => {
  if (prospect.domain.endsWith(".example.com")) {
    return { sent: false, status: "queued", reason: "Real prospect email list required before delivery" };
  }
  if (env.ZOHO_CLIENT_ID) return sendZohoInvite(env, prospect);
  return sendMailgunInvite(env, prospect);
};

const emailDeliveryConfigured = (env) =>
  Boolean(
    (env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET && env.ZOHO_REFRESH_TOKEN && env.ZOHO_ACCOUNT_ID && env.ZOHO_SENDER_EMAIL) ||
      (env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET && env.ZOHO_REFRESH_TOKEN && env.ZOHO_ACCOUNT_ID && env.ZOHO_FROM_EMAIL) ||
      (env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN && env.MAILGUN_SENDER_EMAIL),
  );

const userFor = (session) => ({
  id: session.sub,
  email: session.email,
  role: session.role,
});

const workspace = (session) => ({
  user: userFor(session),
  role: session.role,
  profile:
    session.role === "admin"
      ? null
      : {
          id: `${session.role}-profile`,
          company_name: session.email.split("@")[0],
          verification_status: session.role === "vendor" ? "pending" : "active",
        },
  rfqs: [],
  quotations: [],
  awards: [],
});

const requireSession = async (request, env) => {
  const session = await readSession(request, env);
  if (!session) return [null, json({ error: "Authentication required" }, 401)];
  return [session, null];
};

async function handleAuth(path, request, env) {
  if (path === "auth/register" && request.method === "POST") {
    const body = await parseJson(request);
    const email = String(body.email || "").trim().toLowerCase();
    const role = String(body.role || roleForEmail(email));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Enter a valid email address." }, 400);
    if (!String(body.password || "")) return json({ error: "Enter your password." }, 400);
    return json({ ok: true, emailSent: false, role });
  }

  if (path === "auth/login" && request.method === "POST") {
    const body = await parseJson(request);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Enter a valid email address." }, 400);
    if (!password) return json({ error: "Enter your password." }, 400);

    const role = roleForEmail(email, env);
    if (role === "admin") {
      const configured = env.ADMIN_PASSWORD || env.ADMIN_PASSCODE;
      if (configured && password !== configured) return json({ error: "Invalid admin email or password." }, 401);
    }

    const session = {
      sub: crypto.randomUUID(),
      email,
      role,
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
    };
    const token = await makeToken(session, env);
    return json(
      { ok: true, role, user: userFor(session) },
      200,
      { "set-cookie": cookieHeader(token) },
    );
  }

  if (path === "auth/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": clearCookieHeader() });
  }

  if (path === "auth/reset/request" && request.method === "POST") {
    return json({ ok: true });
  }

  if (path === "auth/reset/confirm" && request.method === "POST") {
    return json({ ok: true });
  }

  if (path === "auth/verify" && request.method === "POST") {
    return json({ ok: true });
  }

  return null;
}

async function handleAdmin(path, request, env, session) {
  if (session.role !== "admin") return json({ error: "Admin access required" }, 403);

  if (path === "admin/overview") {
    return json({ counts: { requests_pending: 0, visits_open: 0, companies_pending: 0 } });
  }

  if (path === "admin/accounts") {
    return json({ accounts: [] });
  }

  if (path === "admin/public-requests") {
    return json({ requests: [] });
  }

  if (path === "admin/site-visits") {
    return json({ visits: [] });
  }

  if (path === "admin/documents") {
    return json({ documents: [] });
  }

  if (path === "admin/outreach/daily") {
    const url = new URL(request.url);
    const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
    const limit = Math.min(Number(url.searchParams.get("limit") || 100), 100);
    const invites = JSON.parse((await env.KV?.get?.(`outreach:${date}`)) || "[]").slice(0, limit);
    return json({ date, count: invites.length, invites });
  }

  if (path === "admin/prospects/discover" && request.method === "POST") {
    const body = await parseJson(request);
    const prospects = makeProspects(body);
    const send = body.send !== false && body.send !== "false";
    const date = new Date().toISOString().slice(0, 10);
    const invites = [];
    let invited = 0;
    let skipped = 0;

    for (const prospect of prospects) {
      const result = send ? await sendInvite(env, prospect) : { sent: false, status: "created", reason: "send disabled" };
      if (result.sent) invited += 1;
      else skipped += 1;
      invites.push({
        id: crypto.randomUUID(),
        name: prospect.name,
        recipient: prospect.email,
        email: prospect.email,
        type: prospect.type,
        domain: prospect.domain,
        email_status: result.status,
        prospect_status: result.reason,
        created_at: new Date().toISOString(),
      });
    }

    if (env.KV?.put) {
      const previous = JSON.parse((await env.KV.get(`outreach:${date}`)) || "[]");
      await env.KV.put(`outreach:${date}`, JSON.stringify([...invites, ...previous].slice(0, 500)));
    }

    return json({
      prospects: invites.map((invite) => ({
        name: invite.name,
        email: invite.email,
        type: invite.type,
        domain: invite.domain,
        status: invite.email_status,
      })),
      created: prospects.length,
      invited,
      skipped,
      target: prospects.length,
      emailConfigured: emailDeliveryConfigured(env),
    });
  }

  if (/^admin\/(rfqs|companies|accounts)\//.test(path)) {
    return json({ ok: true });
  }

  return null;
}

export async function onRequest({ request, env, params }) {
  const path = Array.isArray(params.path) ? params.path.join("/") : String(params.path || "");

  if (request.method === "OPTIONS") return json({ ok: true });

  const authResponse = await handleAuth(path, request, env);
  if (authResponse) return authResponse;

  const [session, authError] = await requireSession(request, env);
  if (authError) return authError;

  if (path === "workspace") return json(workspace(session));

  const adminResponse = await handleAdmin(path, request, env, session);
  if (adminResponse) return adminResponse;

  if (/^rfqs(\/|$)/.test(path)) {
    if (request.method === "GET") return json({ rfq: { title: "Request", scope: "", quotations: [] } });
    return json({ ok: true, id: crypto.randomUUID() });
  }

  if (path === "documents" && request.method === "POST") {
    return json({ ok: true, id: crypto.randomUUID() });
  }

  if (path === "public/requests" && request.method === "POST") {
    return json({
      ok: true,
      id: crypto.randomUUID(),
      reference: `UP-${Date.now().toString().slice(-6)}`,
      upload_token: crypto.randomUUID(),
      site_visit: false,
    });
  }

  if (/^public\/requests\/[^/]+\/documents$/.test(path) && request.method === "POST") {
    return json({ ok: true });
  }

  return json({ error: "API route not found", path }, 404);
}
