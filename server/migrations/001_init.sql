CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_settings (
  id BIGSERIAL PRIMARY KEY,
  key VARCHAR(64) NOT NULL UNIQUE,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS monitor_targets (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(32) NOT NULL,
  endpoint TEXT NOT NULL,
  interval_sec INTEGER NOT NULL DEFAULT 60,
  timeout_ms INTEGER NOT NULL DEFAULT 5000,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS check_results (
  id BIGSERIAL PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES monitor_targets(id) ON DELETE CASCADE,
  success BOOLEAN NOT NULL,
  latency_ms INTEGER NOT NULL,
  error_msg TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS relay_finance_snapshots (
  id BIGSERIAL PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES monitor_targets(id) ON DELETE CASCADE,
  currency VARCHAR(16) NOT NULL DEFAULT 'USD',
  limit_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  used_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  balance DOUBLE PRECISION NOT NULL DEFAULT 0,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tracking_events (
  id BIGSERIAL PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES monitor_targets(id) ON DELETE CASCADE,
  event_name VARCHAR(64) NOT NULL,
  page VARCHAR(255),
  count INTEGER NOT NULL DEFAULT 1,
  client_id VARCHAR(128),
  user_id VARCHAR(128),
  uv_key VARCHAR(128),
  client_ip VARCHAR(64),
  user_agent VARCHAR(512),
  referer VARCHAR(1024),
  geo_text VARCHAR(255),
  meta_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monitor_targets_type ON monitor_targets(type);
CREATE INDEX IF NOT EXISTS idx_check_results_target_id ON check_results(target_id);
CREATE INDEX IF NOT EXISTS idx_check_results_checked_at ON check_results(checked_at);
CREATE INDEX IF NOT EXISTS idx_finance_target_id ON relay_finance_snapshots(target_id);
CREATE INDEX IF NOT EXISTS idx_finance_checked_at ON relay_finance_snapshots(checked_at);
CREATE INDEX IF NOT EXISTS idx_tracking_target_id ON tracking_events(target_id);
CREATE INDEX IF NOT EXISTS idx_tracking_occurred_at ON tracking_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_tracking_uv_key ON tracking_events(uv_key);
