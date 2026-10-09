CREATE TABLE IF NOT EXISTS lectures (
    run_id UUID PRIMARY KEY,
    body_hash CHAR(64) NOT NULL,
    share_token TEXT NOT NULL UNIQUE,
    client_key CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    document JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS lectures_client_created_idx ON lectures (client_key, created_at);
CREATE INDEX IF NOT EXISTS lectures_created_idx ON lectures (created_at);
CREATE INDEX IF NOT EXISTS lectures_expires_idx ON lectures (expires_at);
