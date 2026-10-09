ALTER TABLE lectures ADD COLUMN IF NOT EXISTS is_listed BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS lectures_public_created_idx
ON lectures (created_at DESC, run_id DESC) WHERE is_listed;
