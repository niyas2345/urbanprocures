import type { Env } from "../lib/types";

const COOKIE = "up_session";
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });

const parseJson = async (request: Request) => {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const b64url = (input: string | ArrayBuffer) => {
  const raw = typeof input === "string" ? input : String.fromCharCode(...new Uint8Array(input));
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const fromB64url = (input: string) => {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  return atob(padded);
};

const secretFor = (env: Env) => env.JWT_SECRET || "urban-procures-session";

const sign = async (value: string, env: Env) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretFor(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
};

const makeToken = async (payload: Record<string, unknown>, env: Env) => {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${await sign(body, env)}`;
};

const readSession = async (request: Request, env: Env) => {
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
    const session = JSON.parse(fromB64url(body)) as { sub: string; email: string; role: "admin" | "client" | "vendor"; exp: number };
    if (!session.exp || session.exp < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
};

const cookieHeader = (token: string) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
const clearCookieHeader = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

const roleForEmail = (email: string) => {
  if (email.toLowerCase() === "urbanprocures@gmail.com") return "admin";
  if (/(vendor|supplier|subcontractor)/i.test(email)) return "vendor";
  return "client";
};

const userFor = (session: { sub: string; email: string; role: string }) => ({
  id: session.sub,
  email: session.email,
  role: session.role,
});

const workspace = (session: { sub: string; email: string; role: "admin" | "client" | "vendor" }) => ({
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

const requireSession = async (request: Request, env: Env) => {
  const session = await readSession(request, env);
  if (!session) return [null, json({ error: "Authentication required" }, 401)] as const;
  return [session, null] as const;
};

async function handleAuth(path: string, request: Request, env: Env) {
  if (path === "auth/register" && request.method === "POST") {
    const body = await parseJson(request);
    const email = String(body.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Enter a valid email address." }, 400);
    return json({ ok: true, emailSent: false, role: String(body.role || roleForEmail(email)) });
  }

  if (path === "auth/login" && request.method === "POST") {
    const body = await parseJson(request);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Enter a valid email address." }, 400);
    if (!password) return json({ error: "Enter your password." }, 400);
    const role = roleForEmail(email);
    const session = { sub: crypto.randomUUID(), email, role, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 };
    return json({ ok: true, role, user: userFor(session) }, 200, { "set-cookie": cookieHeader(await makeToken(session, env)) });
  }

  if (path === "auth/logout" && request.method === "POST") return json({ ok: true }, 200, { "set-cookie": clearCookieHeader() });
  if (path === "auth/reset/request" && request.method === "POST") return json({ ok: true });
  if (path === "auth/reset/confirm" && request.method === "POST") return json({ ok: true });
  if (path === "auth/verify" && request.method === "POST") return json({ ok: true });
  return null;
}

async function handleAdmin(path: string, session: { role: string }) {
  if (session.role !== "admin") return json({ error: "Admin access required" }, 403);
  if (path === "admin/overview") return json({ counts: { requests_pending: 0, visits_open: 0, companies_pending: 0 } });
  if (path === "admin/accounts") return json({ accounts: [] });
  if (path === "admin/public-requests") return json({ requests: [] });
  if (path === "admin/site-visits") return json({ visits: [] });
  if (path === "admin/documents") return json({ documents: [] });
  if (path === "admin/outreach/daily") return json({ date: new Date().toISOString().slice(0, 10), count: 0, invites: [] });
  if (/^admin\/(rfqs|companies|accounts|prospects)\//.test(path)) return json({ ok: true });
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/native\/?/, "");
    if (request.method === "OPTIONS") return json({ ok: true });
    const authResponse = await handleAuth(path, request, env);
    if (authResponse) return authResponse;
    if (path === "public/requests" && request.method === "POST") {
      return json({ ok: true, id: crypto.randomUUID(), reference: `UP-${Date.now().toString().slice(-6)}`, upload_token: crypto.randomUUID(), site_visit: false });
    }
    if (/^public\/requests\/[^/]+\/documents$/.test(path) && request.method === "POST") return json({ ok: true });

    const [session, authError] = await requireSession(request, env);
    if (authError) return authError;
    if (path === "workspace") return json(workspace(session));
    const adminResponse = await handleAdmin(path, session);
    if (adminResponse) return adminResponse;
    if (/^rfqs(\/|$)/.test(path)) {
      if (request.method === "GET") return json({ rfq: { title: "Request", scope: "", quotations: [] } });
      return json({ ok: true, id: crypto.randomUUID() });
    }
    if (path === "documents" && request.method === "POST") return json({ ok: true, id: crypto.randomUUID() });
    return json({ error: "API route not found", path }, 404);
  },
};
