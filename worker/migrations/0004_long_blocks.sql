-- Long-running tasks can start well before a report. Keep their overlap lookup
-- independent of the number of ordinary historical blocks.
CREATE INDEX blocks_long_by_end ON blocks (user_id, ended_at)
WHERE ended_at - started_at > 172800000;
