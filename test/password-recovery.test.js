import test from 'node:test'
import assert from 'node:assert/strict'
import { establishPasswordRecoverySession } from '../src/supabase/password-recovery.js'

test('restores a recovery session from an implicit-flow callback before password update', async () => {
  const session = { access_token: 'access', refresh_token: 'refresh', user: { id: 'user-1' } }
  let restored
  const auth = {
    getSession: async () => ({ data: { session: null } }),
    setSession: async (tokens) => {
      restored = tokens
      return { data: { session }, error: null }
    }
  }
  const result = await establishPasswordRecoverySession(
    auth,
    'https://urbanprocures.com/reset-password#access_token=access&refresh_token=refresh&type=recovery'
  )
  assert.deepEqual(restored, { access_token: 'access', refresh_token: 'refresh' })
  assert.equal(result.session, session)
  assert.equal(result.callbackPresent, true)
  assert.equal(result.cleanUrl, 'https://urbanprocures.com/reset-password')
})

test('exchanges a PKCE recovery code when automatic URL detection did not establish a session', async () => {
  const session = { access_token: 'access', user: { id: 'user-2' } }
  let exchanged
  const auth = {
    getSession: async () => ({ data: { session: null } }),
    exchangeCodeForSession: async (code) => {
      exchanged = code
      return { data: { session }, error: null }
    }
  }
  const result = await establishPasswordRecoverySession(
    auth,
    'https://urbanprocures.com/reset-password?code=one-time-code&next=%2Fsignin'
  )
  assert.equal(exchanged, 'one-time-code')
  assert.equal(result.session, session)
  assert.equal(result.cleanUrl, 'https://urbanprocures.com/reset-password?next=%2Fsignin')
})

test('does not claim recovery is ready when no callback or session exists', async () => {
  const auth = { getSession: async () => ({ data: { session: null } }) }
  const result = await establishPasswordRecoverySession(auth, 'https://urbanprocures.com/reset-password')
  assert.equal(result.session, null)
  assert.equal(result.error, null)
  assert.equal(result.callbackPresent, false)
  assert.equal(result.cleanUrl, null)
})

test('reports an expired callback and removes its sensitive parameters', async () => {
  const auth = { getSession: async () => ({ data: { session: null } }) }
  const result = await establishPasswordRecoverySession(
    auth,
    'https://urbanprocures.com/reset-password?error=access_denied&error_code=otp_expired&error_description=Link+expired'
  )
  assert.equal(result.session, null)
  assert.match(result.error.message, /Link expired/)
  assert.equal(result.cleanUrl, 'https://urbanprocures.com/reset-password')
})
