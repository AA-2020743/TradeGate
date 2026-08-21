CREATE TABLE IF NOT EXISTS model_alerts (
    id BIGSERIAL PRIMARY KEY,
    model_id TEXT NOT NULL,
    entry_key TEXT NOT NULL,
    text TEXT NOT NULL,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    run_id BIGINT,
    UNIQUE (model_id, entry_key, detected_at)
);

CREATE INDEX IF NOT EXISTS model_alerts_detected_idx
    ON model_alerts (detected_at DESC);
