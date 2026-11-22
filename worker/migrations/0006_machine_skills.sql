CREATE TABLE machine_skills (
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  tool TEXT NOT NULL CHECK (tool IN ('claude_code', 'codex')),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  PRIMARY KEY (machine_id, tool, name, description)
) WITHOUT ROWID;
