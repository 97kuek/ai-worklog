CREATE TABLE machine_log_receipts (
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (machine_id, tool)
) WITHOUT ROWID;
