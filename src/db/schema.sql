CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,            -- e.g. 'Meta'
  status TEXT NOT NULL CHECK (status IN ('active','paused')),
  daily_budget REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_metrics (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  date TEXT NOT NULL,                -- YYYY-MM-DD, UTC
  spend REAL NOT NULL,
  impressions INTEGER NOT NULL,
  clicks INTEGER NOT NULL,
  leads INTEGER NOT NULL,
  revenue REAL NOT NULL,
  PRIMARY KEY (campaign_id, date)
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,               -- UUID
  action TEXT NOT NULL CHECK (action IN ('pause','resume')),
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  reason TEXT,
  requested_by TEXT NOT NULL,        -- Slack user ID
  status TEXT NOT NULL CHECK (status IN ('pending','approved','cancelled','expired')),
  decided_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,          -- created_at + 30 minutes
  decided_at TEXT,
  channel_id TEXT NOT NULL,
  thread_ts TEXT,                    -- thread to reply in (null in DMs)
  message_ts TEXT                    -- the approval message, for updates
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  approval_id TEXT REFERENCES approvals(id),
  action TEXT NOT NULL CHECK (action IN ('pause','resume','cancel','expire')),
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  performed_by TEXT NOT NULL,        -- Slack user ID, or 'system' for expiry
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_events (
  message_key TEXT PRIMARY KEY,      -- channel_id:ts
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  thread_key TEXT PRIMARY KEY,       -- channel_id:thread_ts, or channel_id for DMs
  messages TEXT NOT NULL,            -- JSON array
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,                -- YYYY-MM-DD, UTC
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  est_cost_usd REAL NOT NULL
);
