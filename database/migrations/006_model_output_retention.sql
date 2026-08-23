-- Model outputs accumulate forever. Every ingestion run writes one row per
-- model, the backfill writes a hundred or more per model on its first run, and
-- nothing has ever deleted any of them. The narrative reads two rows, the
-- overlap matrix reads a hundred and twenty, and nothing reads further back.
-- model_outputs has no id column; its key is (model_id, version, calculated_at).
CREATE INDEX IF NOT EXISTS model_outputs_model_effective_idx
    ON model_outputs (model_id, effective_at DESC, calculated_at DESC);

CREATE INDEX IF NOT EXISTS model_alerts_model_key_idx
    ON model_alerts (model_id, entry_key, detected_at DESC);
