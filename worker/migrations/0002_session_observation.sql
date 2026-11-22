ALTER TABLE sessions ADD COLUMN observed_state TEXT
  CHECK (observed_state IN ('running', 'waiting', 'unknown'));
ALTER TABLE sessions ADD COLUMN observed_at INTEGER
  CHECK ((observed_state IS NULL) = (observed_at IS NULL));
