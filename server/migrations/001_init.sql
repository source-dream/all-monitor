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

CREATE TABLE IF NOT EXISTS subscription_snapshots (
  id BIGSERIAL PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES monitor_targets(id) ON DELETE CASCADE,
  reachable BOOLEAN NOT NULL DEFAULT FALSE,
  http_status INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error_msg TEXT,
  node_total INTEGER NOT NULL DEFAULT 0,
  protocol_stats_json TEXT NOT NULL DEFAULT '{}',
  upload_bytes BIGINT NOT NULL DEFAULT 0,
  download_bytes BIGINT NOT NULL DEFAULT 0,
  total_bytes BIGINT NOT NULL DEFAULT 0,
  remaining_bytes BIGINT NOT NULL DEFAULT 0,
  expire_at TIMESTAMPTZ,
  content_hash VARCHAR(64),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscription_nodes (
  id BIGSERIAL PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES monitor_targets(id) ON DELETE CASCADE,
  node_uid VARCHAR(80) NOT NULL,
  name VARCHAR(255),
  protocol VARCHAR(32),
  server VARCHAR(255),
  port INTEGER NOT NULL DEFAULT 0,
  source_order INTEGER NOT NULL DEFAULT 0,
  last_latency_ms INTEGER,
  last_score_ms INTEGER NOT NULL DEFAULT 0,
  last_tcp_ms INTEGER NOT NULL DEFAULT 0,
  last_tls_ms INTEGER NOT NULL DEFAULT 0,
  last_e2e_domestic_ms INTEGER NOT NULL DEFAULT 0,
  last_e2e_overseas_ms INTEGER NOT NULL DEFAULT 0,
  last_jitter_ms INTEGER NOT NULL DEFAULT 0,
  last_probe_mode VARCHAR(32) NOT NULL DEFAULT 'mixed',
  last_fail_stage VARCHAR(64),
  last_fail_reason TEXT,
  last_error_msg TEXT,
  last_latency_checked_at TIMESTAMPTZ,
  raw_json TEXT NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscription_snapshot_target ON subscription_snapshots(target_id);
CREATE INDEX IF NOT EXISTS idx_subscription_snapshot_checked ON subscription_snapshots(checked_at);
CREATE INDEX IF NOT EXISTS idx_subscription_node_target ON subscription_nodes(target_id);
CREATE INDEX IF NOT EXISTS idx_subscription_node_uid ON subscription_nodes(node_uid);
CREATE INDEX IF NOT EXISTS idx_subscription_node_protocol ON subscription_nodes(protocol);

CREATE TABLE IF NOT EXISTS subscription_node_checks (
  id BIGSERIAL PRIMARY KEY,
  target_id BIGINT NOT NULL REFERENCES monitor_targets(id) ON DELETE CASCADE,
  node_uid VARCHAR(80) NOT NULL,
  success BOOLEAN NOT NULL DEFAULT FALSE,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  score_ms INTEGER NOT NULL DEFAULT 0,
  tcp_ms INTEGER NOT NULL DEFAULT 0,
  tls_ms INTEGER NOT NULL DEFAULT 0,
  e2e_domestic_ms INTEGER NOT NULL DEFAULT 0,
  e2e_overseas_ms INTEGER NOT NULL DEFAULT 0,
  jitter_ms INTEGER NOT NULL DEFAULT 0,
  probe_mode VARCHAR(32) NOT NULL DEFAULT 'mixed',
  fail_stage VARCHAR(64),
  fail_reason TEXT,
  error_msg TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscription_node_check_target ON subscription_node_checks(target_id);
CREATE INDEX IF NOT EXISTS idx_subscription_node_check_uid ON subscription_node_checks(node_uid);
CREATE INDEX IF NOT EXISTS idx_subscription_node_check_checked ON subscription_node_checks(checked_at);
