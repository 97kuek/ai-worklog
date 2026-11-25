ALTER TABLE sessions ADD COLUMN import_corrected INTEGER NOT NULL DEFAULT 0 CHECK (import_corrected IN (0, 1));
