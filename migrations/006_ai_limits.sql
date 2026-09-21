CREATE TABLE IF NOT EXISTS wv_ai_limits (
  identity_hash TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  used INTEGER NOT NULL,
  PRIMARY KEY(identity_hash,window_start)
);
CREATE TABLE IF NOT EXISTS wv_ai_requests (
  request_key TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
