CREATE TABLE board_requests (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('backlog', 'queued')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
) WITHOUT ROWID;
