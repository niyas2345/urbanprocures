export function supabaseSecret(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY
    || env.SUPABASE_SECRET_KEY
    || env.Supabase_Secret_Key
    || env.Service_Api_key
    || "";
}

export function supabaseReady(env) {
  return Boolean(env.SUPABASE_URL && supabaseSecret(env));
}
