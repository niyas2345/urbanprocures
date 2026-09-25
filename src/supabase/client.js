import { createClient } from '@supabase/supabase-js'
import { establishPasswordRecoverySession } from './password-recovery.js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://vdlrwekoyvvspxuyzgrx.supabase.co'
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZkbHJ3ZWtveXZ2c3B4dXl6Z3J4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc1MTIwODcsImV4cCI6MjEwMzA4ODA4N30.xwgrrIesqLpR7GOULjV2g4MKQw2OVxYVmfsE2D0mMM4'
const TOKEN_KEY = 'urban-procure-access-token'
const SESSION_KEY = 'up_session'

export const ADMIN_EMAIL = 'urbanprocures@gmail.com'

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
})

function normEmail(value) {
  return String(value || '').trim().toLowerCase()
}

export function isAdminEmail(email) {
  return normEmail(email) === ADMIN_EMAIL
}

function persistToken(session) {
  try {
    if (session?.access_token) {
      localStorage.setItem(TOKEN_KEY, session.access_token)
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        access_token: session.access_token,
        refresh_token: session.refresh_token || '',
        expires_at: session.expires_at
          ? new Date(session.expires_at * (session.expires_at < 1e12 ? 1000 : 1)).toISOString()
          : new Date(Date.now() + 3600 * 1000).toISOString(),
        user: session.user || null
      }))
    } else {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(SESSION_KEY)
    }
  } catch {}
}

supabase.auth.onAuthStateChange((_event, session) => {
  persistToken(session)
})

export const signIn = async (email, password) => {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: normEmail(email),
    password
  })
  if (!error) persistToken(data.session)
  return { data, error }
}

export const signUp = async (email, password, metadata = {}) => {
  const cleanEmail = normEmail(email)
  if (isAdminEmail(cleanEmail)) {
    return { data: null, error: { message: 'This email is reserved for the Urban Procures desk. Use Sign In.' } }
  }
  const role = metadata.user_type === 'vendor' ? 'vendor' : 'client'
  let response
  try {
    response = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: cleanEmail, password, role })
    })
  } catch {
    return { data: null, error: { message: 'Could not reach the Urban Procures desk. Try again.' } }
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload.ok) {
    return { data: null, error: { message: payload.error || 'Registration failed.' } }
  }
  if (payload.session?.access_token && payload.session?.refresh_token) {
    const { error } = await supabase.auth.setSession({
      access_token: payload.session.access_token,
      refresh_token: payload.session.refresh_token
    })
    if (error) return { data: null, error }
    persistToken(payload.session)
  }
  return {
    data: {
      user: payload.user,
      session: payload.session
    },
    error: null
  }
}

export const signOut = async () => {
  const { error } = await supabase.auth.signOut()
  persistToken(null)
  return { error }
}

export async function resetPassword(email) {
  const redirectTo = `${window.location.origin}/reset-password`
  return supabase.auth.resetPasswordForEmail(normEmail(email), { redirectTo })
}

export async function updatePassword(password) {
  return supabase.auth.updateUser({ password })
}

export async function completePasswordRecovery() {
  const result = await establishPasswordRecoverySession(supabase.auth, window.location.href)
  if (result.cleanUrl && result.cleanUrl !== window.location.href) {
    window.history.replaceState(window.history.state, '', result.cleanUrl)
  }
  return result
}

export const getUser = async () => {
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export const getSession = async () => {
  const { data: { session } } = await supabase.auth.getSession()
  persistToken(session)
  return session
}

export async function accessToken() {
  const session = await getSession()
  return session?.access_token || ''
}

export async function apiRequest(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {}
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json'
  if (auth) {
    const token = await accessToken()
    if (token) headers.Authorization = `Bearer ${token}`
  }
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : (body instanceof FormData ? body : JSON.stringify(body))
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data?.ok === false) {
    const error = new Error(data?.error || `Request failed (${response.status})`)
    error.status = response.status
    error.payload = data
    throw error
  }
  return data
}

async function provisionRole() {
  try {
    const data = await apiRequest('/api/auth/provision-role', { method: 'POST', body: {} })
    if (data?.role) await supabase.auth.refreshSession()
    return data
  } catch {
    return null
  }
}

export async function getDesk() {
  await getSession()
  const user = await getUser()
  if (!user) return { user: null, role: null, profile: null }

  try {
    const response = await apiRequest('/api/auth/role')
    return { user, role: response.role, profile: null }
  } catch (error) {
    if (error.status === 403 && !user.app_metadata?.role) {
      const provisioned = await provisionRole()
      if (provisioned?.role) return { user, role: provisioned.role, profile: null }
    }
    return { user, role: null, profile: null, error: error.message }
  }
}

export function goDesk(role) {
  const next = new URLSearchParams(window.location.search).get('next')
  const allowed = {
    client: new Set(['dashboard', 'rfqs', 'quotations', 'projects', 'messages', 'settings']),
    vendor: new Set(['dashboard', 'invitations', 'quotations', 'awards', 'messages', 'settings']),
    admin: new Set(['dashboard', 'rfqs', 'vendors', 'users', 'awards', 'settings'])
  }
  if (next && allowed[role]?.has(next.slice(role.length + 2)) && next.startsWith(`/${role}/`)) {
    window.location.href = next
    return
  }
  if (role === 'vendor') window.location.href = '/vendor/dashboard'
  else if (role === 'admin') window.location.href = '/admin/dashboard'
  else if (role === 'client') window.location.href = '/client/dashboard'
  else window.location.href = '/signin?error=role'
}

export function friendlyAuthError(error, email) {
  const raw = String(error?.message || error || '')
  const lower = raw.toLowerCase()
  if (isAdminEmail(email) && /invalid login|invalid credentials/.test(lower)) {
    return 'Admin sign-in is locked to urbanprocures@gmail.com. That password was not recognised — use Forgot password to reset it.'
  }
  if (/invalid login|invalid credentials/.test(lower)) {
    return 'That email or password was not recognised. Create an account, or use Forgot password if you already registered.'
  }
  if (/email not confirmed|confirm/.test(lower)) {
    return 'This email is not confirmed yet. Use Forgot password to receive a fresh sign-in link.'
  }
  if (/already registered|already been registered|user already/.test(lower)) {
    return 'An account already exists for this email. Sign in, or reset the password.'
  }
  if (/password/.test(lower) && /6|8|characters/.test(lower)) {
    return 'Password must be at least 8 characters.'
  }
  return raw || 'Something went wrong. Try again.'
}
