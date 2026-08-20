CREATE TABLE IF NOT EXISTS data_series (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_series_id TEXT NOT NULL,
    name TEXT NOT NULL,
    asset_class TEXT NOT NULL,
    frequency TEXT,
    unit TEXT,
    currency TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS observations (
    series_id TEXT NOT NULL REFERENCES data_series(id) ON DELETE CASCADE,
    observed_at TIMESTAMPTZ NOT NULL,
    value DOUBLE PRECISION NOT NULL,
    provider_as_of TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (series_id, observed_at)
);

CREATE INDEX IF NOT EXISTS observations_observed_at_idx
    ON observations (observed_at DESC);

CREATE TABLE IF NOT EXISTS observation_revisions (
    id BIGSERIAL PRIMARY KEY,
    series_id TEXT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    previous_value DOUBLE PRECISION NOT NULL,
    previous_provider_as_of TIMESTAMPTZ,
    previous_metadata JSONB NOT NULL,
    replaced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS observation_revisions_series_idx
    ON observation_revisions (series_id, observed_at DESC);

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
            previous_metadata
        ) VALUES (
            OLD.series_id,
            OLD.observed_at,
            OLD.value,
            OLD.provider_as_of,
            OLD.metadata
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS observations_preserve_revision ON observations;
CREATE TRIGGER observations_preserve_revision
BEFORE UPDATE ON observations
FOR EACH ROW EXECUTE FUNCTION preserve_observation_revision();

CREATE TABLE IF NOT EXISTS ingestion_runs (
    id BIGSERIAL PRIMARY KEY,
    job_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    observations_written INTEGER NOT NULL DEFAULT 0,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS ingestion_runs_job_idx
    ON ingestion_runs (job_name, started_at DESC);

CREATE TABLE IF NOT EXISTS model_outputs (
    model_id TEXT NOT NULL,
    version TEXT NOT NULL,
    calculated_at TIMESTAMPTZ NOT NULL,
    effective_at TIMESTAMPTZ,
    output JSONB NOT NULL,
    input_lineage JSONB NOT NULL DEFAULT '[]'::jsonb,
    PRIMARY KEY (model_id, version, calculated_at)
);
