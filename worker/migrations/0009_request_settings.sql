ALTER TABLE board_requests ADD COLUMN engine TEXT CHECK (engine IN ('claude_code', 'codex'));
ALTER TABLE board_requests ADD COLUMN model TEXT;
ALTER TABLE board_requests ADD COLUMN effort TEXT;
ALTER TABLE board_requests ADD COLUMN project TEXT;
