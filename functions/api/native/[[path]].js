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
    return json({ date: new Date().toISOString().slice(0, 10), count: 0, invites: [] });
  }

  if (path === "admin/prospects/discover" && request.method === "POST") {
    return json({ prospects: [], created: 0, invited: 0, skipped: 0, target: 0 });
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
