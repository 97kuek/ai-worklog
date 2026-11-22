-- Only an authenticated user sets this value. Machine uploads own the observation fields.
ALTER TABLE sessions ADD COLUMN completed_at INTEGER;
