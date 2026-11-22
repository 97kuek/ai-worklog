-- Preserve the order previously shown on the board for existing queued cards.
ALTER TABLE board_requests ADD COLUMN queue_position INTEGER;
ALTER TABLE board_requests ADD COLUMN queue_after_launch INTEGER NOT NULL DEFAULT 0;
WITH ordered AS (
  SELECT user_id, id, row_number() OVER (PARTITION BY user_id ORDER BY updated_at, id) AS position
  FROM board_requests WHERE stage='queued'
)
UPDATE board_requests SET queue_position=(
  SELECT position FROM ordered WHERE ordered.user_id=board_requests.user_id AND ordered.id=board_requests.id
) WHERE stage='queued';
CREATE INDEX board_launch_busy ON board_launches(machine_id) WHERE state IN ('claimed','running');
CREATE UNIQUE INDEX board_request_queue ON board_requests(user_id, queue_position) WHERE stage='queued';

-- Moving a failed card out and back in is the owner's explicit retry. An edit
-- within Queued preserves both its position and any failed attempt.
CREATE TRIGGER board_request_move AFTER UPDATE OF stage ON board_requests
WHEN OLD.stage <> NEW.stage
BEGIN
  UPDATE board_requests SET
    queue_position=CASE WHEN NEW.stage='queued' THEN (
      SELECT coalesce(max(queue_position),0)+1 FROM board_requests WHERE user_id=NEW.user_id AND stage='queued'
    ) END,
    queue_after_launch=CASE WHEN NEW.stage='queued' THEN (
      SELECT coalesce(max(seq),0) FROM board_launches WHERE user_id=NEW.user_id AND request_id=NEW.id
    ) ELSE OLD.queue_after_launch END
  WHERE user_id=NEW.user_id AND id=NEW.id;
END;
