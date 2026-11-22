CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT,
  access_client_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  machine_id TEXT NOT NULL REFERENCES machines(id),
  tool TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  title TEXT,
  project TEXT,
  cwd TEXT,
  git_branch TEXT,
  models TEXT NOT NULL,            -- JSONの配列
  invoked_by TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  active_minutes REAL NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, tool, native_session_id)
);
CREATE INDEX sessions_user_updated ON sessions (user_id, updated_at);
CREATE TABLE blocks (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE INDEX blocks_user_started ON blocks (user_id, started_at);
