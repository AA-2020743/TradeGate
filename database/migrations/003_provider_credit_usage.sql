CREATE TABLE IF NOT EXISTS provider_credit_usage (
    provider TEXT NOT NULL,
    usage_date DATE NOT NULL,
    total_credits INTEGER NOT NULL DEFAULT 0 CHECK (total_credits >= 0),
    interactive_credits INTEGER NOT NULL DEFAULT 0 CHECK (interactive_credits >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (provider, usage_date)
);
