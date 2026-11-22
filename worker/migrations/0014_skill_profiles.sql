CREATE TABLE machine_skills_profiled (
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  tool TEXT NOT NULL CHECK (tool IN ('claude_code', 'codex')),
  account TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  PRIMARY KEY (machine_id, tool, account, name, description)
) WITHOUT ROWID;

-- Existing collectors did not report an account.
INSERT INTO machine_skills_profiled (machine_id, tool, name, description)
SELECT machine_id, tool, name, description FROM machine_skills;

DROP TABLE machine_skills;
ALTER TABLE machine_skills_profiled RENAME TO machine_skills;
