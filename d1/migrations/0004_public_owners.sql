CREATE TABLE IF NOT EXISTS public_owners (
  request_id TEXT PRIMARY KEY REFERENCES public_requests(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL
);
