CREATE TABLE claude_session_usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account TEXT NOT NULL CHECK(account IN ('p-claude','w-claude')),
  session_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  input_at INTEGER NOT NULL,
  output_at INTEGER NOT NULL,
  cost_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, account, session_id)
) WITHOUT ROWID;

CREATE TABLE claude_rate_windows (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account TEXT NOT NULL CHECK(account IN ('p-claude','w-claude')),
  window TEXT NOT NULL CHECK(window IN ('five_hour','seven_day')),
  observed_at INTEGER NOT NULL,
  used_percentage REAL NOT NULL,
  resets_at INTEGER,
  PRIMARY KEY(user_id, account, window)
) WITHOUT ROWID;
