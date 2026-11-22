-- Machine uploads maintain title; the owner can set a separate display name.
ALTER TABLE sessions ADD COLUMN manual_title TEXT;
