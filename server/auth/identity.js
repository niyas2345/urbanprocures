/** Resolve the authenticated Supabase user. Browser-supplied user IDs are never authoritative. */
import { supabaseSecret } from "../supabase-env.js";

export const ADMIN_EMAIL = 'urbanprocures@gmail.com';

export function resolvedRole(user) {
  return user?.app_metadata?.role;
}

export function provisionedSignupRole(email, requestedRole) {
  if (String(email || '').trim().toLowerCase() === ADMIN_EMAIL || requestedRole === 'admin') return null;
  return ['client', 'vendor'].includes(requestedRole) ? requestedRole : null;
}

export function inferredRole(user) {
  const locked = resolvedRole(user);
  if (locked) return locked;
  const meta = user?.user_metadata?.user_type || user?.user_metadata?.role;
  if (meta === 'vendor' || meta === 'client') return meta;
  return 'client';
}

/** Admin membership is a database grant, not a browser claim or an email convention. */
export async function isRegisteredAdmin(env, user) {
  if (!user?.id || !env.SUPABASE_URL || !supabaseSecret(env)) return false;
  const key = supabaseSecret(env);
  const url = new URL('/rest/v1/app_admins', env.SUPABASE_URL);
  url.searchParams.set('user_id', `eq.${user.id}`);
  url.searchParams.set('select', 'user_id');
  url.searchParams.set('limit', '1');
  const result = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  return result.ok && (await result.json()).length === 1;
}

export async function ensureAdminAppMetadata(env, user) {
  if (!user?.id) return;
  if (resolvedRole(user) !== 'admin') return;
  if (user?.app_metadata?.role === 'admin') return;
  const key = supabaseSecret(env);
  if (!env.SUPABASE_URL || !key) return;
  await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
    method: 'PUT',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_metadata: { ...(user.app_metadata || {}), role: 'admin' } })
  }).catch(() => null);
}

export async function readSessionUser(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return { ok: false, status: 401, error: 'Authentication required' };

  if (env.PROCUREMENT_TEST_AUTH === '1' && token.startsWith('test:')) {
    const [, role, userId] = token.split(':');
    if (!role || !userId) return { ok: false, status: 401, error: 'Invalid test token' };
    const email = role === 'admin' ? ADMIN_EMAIL : `${role}@test.invalid`;
    return { ok: true, role, userId, test: true, user: { id: userId, email, app_metadata: { role }, user_metadata: { user_type: role } } };
  }

  const apiKey = env.SUPABASE_ANON_KEY || supabaseSecret(env);
  if (!env.SUPABASE_URL || !apiKey) {
    return { ok: false, status: 503, error: 'Supabase auth is not configured' };
  }
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: apiKey, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) return { ok: false, status: 401, error: 'Invalid session' };
  const user = await response.json();
  if (!user?.id) return { ok: false, status: 401, error: 'Invalid session' };
  return { ok: true, user, userId: user.id, role: resolvedRole(user) || null };
}

export async function writeAppMetadataRole(env, user, role) {
  const key = supabaseSecret(env);
  if (!env.SUPABASE_URL || !key || !user?.id) return { ok: false };
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
    method: 'PUT',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_metadata: { ...(user.app_metadata || {}), role } })
  });
  if (!response.ok) return { ok: false };
  return { ok: true, role };
}

export async function requireIdentity(request, env, { roles = null } = {}) {
  const session = await readSessionUser(request, env);
  if (!session.ok) return session;
  const role = session.role || resolvedRole(session.user) || (!session.test && await isRegisteredAdmin(env, session.user) ? 'admin' : null);
  if (!session.user?.id || !['client', 'vendor', 'admin'].includes(role)) {
    return { ok: false, status: 403, error: 'Account role is not configured' };
  }
  if (role === 'admin' && !session.test && !(await isRegisteredAdmin(env, session.user))) {
    return { ok: false, status: 403, error: 'Admin access is not granted' };
  }
  if (roles && !roles.includes(role)) return { ok: false, status: 403, error: 'Insufficient role' };
  return { ok: true, role, userId: session.user.id, user: session.user, test: session.test };
}
