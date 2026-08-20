ALTER TABLE ingestion_runs
    DROP CONSTRAINT IF EXISTS ingestion_runs_status_check;

ALTER TABLE ingestion_runs
    ADD CONSTRAINT ingestion_runs_status_check
    CHECK (status IN ('running', 'completed', 'partial', 'failed', 'skipped'));

ALTER TABLE observations
    ADD COLUMN IF NOT EXISTS ingestion_run_id BIGINT REFERENCES ingestion_runs(id) ON DELETE SET NULL;

ALTER TABLE observation_revisions
    ADD COLUMN IF NOT EXISTS previous_ingested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS previous_ingestion_run_id BIGINT REFERENCES ingestion_runs(id) ON DELETE SET NULL;

ALTER TABLE model_outputs
    ADD COLUMN IF NOT EXISTS ingestion_run_id BIGINT REFERENCES ingestion_runs(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION preserve_observation_revision()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.value IS DISTINCT FROM NEW.value
       OR OLD.provider_as_of IS DISTINCT FROM NEW.provider_as_of
       OR OLD.metadata IS DISTINCT FROM NEW.metadata THEN
        INSERT INTO observation_revisions (
            series_id,
            observed_at,
            previous_value,
            previous_provider_as_of,
            previous_metadata,
            previous_ingested_at,
            previous_ingestion_run_id
        ) VALUES (
            OLD.series_id,
            OLD.observed_at,
            OLD.value,
            OLD.provider_as_of,
            OLD.metadata,
            OLD.ingested_at,
            OLD.ingestion_run_id
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
