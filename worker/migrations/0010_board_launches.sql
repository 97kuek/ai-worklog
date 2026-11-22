-- Only the runner's claim endpoint advertises execution capabilities.
CREATE TABLE board_runners (
  machine_id TEXT PRIMARY KEY REFERENCES machines(id) ON DELETE CASCADE,
  projects TEXT NOT NULL,
  engines TEXT NOT NULL,
  seen_at INTEGER NOT NULL
);

CREATE TABLE board_launches (
  seq INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  title TEXT NOT NULL,
  project TEXT NOT NULL,
  engine TEXT NOT NULL CHECK (engine IN ('codex','claude_code')),
  model TEXT,
  effort TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','claimed','running','completed','failed')),
  error TEXT,
  state_since INTEGER NOT NULL,
  UNIQUE (user_id, attempt_id),
  FOREIGN KEY (user_id, request_id) REFERENCES board_requests(user_id, id) ON DELETE CASCADE
);
-- Only confirmed failure frees the request for a new attempt.
CREATE UNIQUE INDEX board_launch_slot ON board_launches(user_id, request_id) WHERE state <> 'failed';
CREATE INDEX board_launch_latest ON board_launches(user_id, request_id, seq DESC);
CREATE INDEX board_launch_queue ON board_launches(user_id, machine_id, seq) WHERE state = 'pending';
CREATE INDEX board_launch_expiry ON board_launches(user_id, state_since) WHERE state IN ('pending','claimed');
