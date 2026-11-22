ALTER TABLE machines ADD COLUMN test_requested_at INTEGER;
ALTER TABLE machines ADD COLUMN test_acknowledged_at INTEGER;

CREATE TABLE runner_project_settings (
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  PRIMARY KEY (machine_id, project)
) WITHOUT ROWID;

-- Every scheduling path sees the same intersection of the latest local
-- advertisement and the owner's persistent per-machine choices.
CREATE VIEW runner_projects AS
SELECT b.machine_id, p.value AS project, b.engines, b.seen_at, coalesce(s.enabled,1) AS enabled
FROM board_runners b CROSS JOIN json_each(b.projects) p
LEFT JOIN runner_project_settings s ON s.machine_id=b.machine_id AND s.project=p.value;
