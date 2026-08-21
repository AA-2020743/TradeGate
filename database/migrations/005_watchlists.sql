CREATE TABLE IF NOT EXISTS watchlists (
    id BIGSERIAL PRIMARY KEY,
    owner_key TEXT NOT NULL DEFAULT 'local',
    name TEXT NOT NULL,
    symbols JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (owner_key, name)
);
