const AUTH_QUERY_PARAMS = [
  'code',
  'token_hash',
  'type',
  'error',
  'error_code',
  'error_description',
  'sb_flow_id'
]

function callbackError(url) {
  const params = new URLSearchParams(url.hash.slice(1))
  const message = url.searchParams.get('error_description')
    || params.get('error_description')
  const hasError = url.searchParams.has('error') || params.has('error')
  if (!message && !hasError) return null
  if (!message) return { message: 'The password reset link could not be verified.' }
  return { message: message.replace(/\+/g, ' ') }
}

function cleanCallbackUrl(url) {
  const clean = new URL(url)
  for (const key of AUTH_QUERY_PARAMS) clean.searchParams.delete(key)
  clean.hash = ''
  return clean.toString()
}

/**
 * Finish Supabase's password-recovery callback before the reset form is usable.
 * Supabase normally detects these callback formats on initialization; handling
 * them here as well avoids submitting updateUser before that session is ready.
 */
export async function establishPasswordRecoverySession(auth, href) {
  const url = new URL(href)
  const hash = new URLSearchParams(url.hash.slice(1))
  let session = null
  let error = callbackError(url)
  let callbackPresent = false

  try {
    const current = await auth.getSession()
    session = current?.data?.session || null
    error ||= current?.error || null

    if (!session && !error) {
      const tokenHash = url.searchParams.get('token_hash')
      if (tokenHash) {
        callbackPresent = true
        const verified = await auth.verifyOtp({
          token_hash: tokenHash,
          type: url.searchParams.get('type') || 'recovery'
        })
        session = verified?.data?.session || null
        error = verified?.error || null
      }
    }

    if (!session && !error) {
      const accessToken = hash.get('access_token')
      const refreshToken = hash.get('refresh_token')
      if (accessToken && refreshToken) {
        callbackPresent = true
        const restored = await auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken
        })
        session = restored?.data?.session || null
        error = restored?.error || null
      }
    }

    if (!session && !error) {
      const code = url.searchParams.get('code')
      if (code) {
        callbackPresent = true
        const exchanged = await auth.exchangeCodeForSession(code)
        session = exchanged?.data?.session || null
        error = exchanged?.error || null
      }
    }
  } catch (cause) {
    error = cause
  }

  const hasCallback = callbackPresent
    || url.searchParams.has('code')
    || url.searchParams.has('token_hash')
    || hash.has('access_token')
    || url.searchParams.has('error')
    || hash.has('error')

  return {
    session,
    error,
    callbackPresent: hasCallback,
    cleanUrl: hasCallback ? cleanCallbackUrl(href) : null
  }
}
