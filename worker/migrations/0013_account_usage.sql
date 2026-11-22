CREATE TABLE account_session_usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  session_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  input_at INTEGER NOT NULL,
  output_at INTEGER NOT NULL,
  cost_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, provider, account, session_id)
) WITHOUT ROWID;

CREATE TABLE account_rate_windows (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  window_seconds INTEGER NOT NULL CHECK(window_seconds > 0),
  observed_at INTEGER NOT NULL,
  used_percentage REAL NOT NULL,
  resets_at INTEGER,
  PRIMARY KEY(user_id, provider, account, window_seconds)
) WITHOUT ROWID;
