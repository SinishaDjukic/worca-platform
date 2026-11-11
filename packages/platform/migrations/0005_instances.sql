-- Instances, their team grants, the latest heartbeat per instance, and cron dedupe.
-- Owner: instances (src/control/instances). Shared columns: docs/internal-apis.md "Shared tables".

-- display_name is encrypted with the org's key (internal-apis.md field contexts). Columns after
-- updated_at are the instances module's own bookkeeping:
--   pending_op      an operation under way that a heartbeat completes: 'wake', 'lift', 'suspend'
--   target_version  the worca version an upgrade waits for (D26)
--   last_error      why the last operation failed, e.g. 'no_heartbeat' after creation timed out
CREATE TABLE instances (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  key_slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  worca_version TEXT,
  available_version TEXT,
  compute_ref TEXT,
  edge_ref TEXT,
  cpu REAL,
  memory_mb INTEGER,
  volume_gb INTEGER,
  stopped_reason TEXT,
  stopped_by TEXT,
  heartbeat_cred_hash TEXT UNIQUE,
  health TEXT,
  last_heartbeat_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  pending_op TEXT,
  target_version TEXT,
  last_error TEXT
);
CREATE INDEX instances_org ON instances (org_id);
CREATE INDEX instances_status_beat ON instances (status, last_heartbeat_at);

-- D19, D20: access only through teams; role empty in v1.
CREATE TABLE instance_teams (
  instance_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  role TEXT,
  PRIMARY KEY (instance_id, team_id)
);
CREATE INDEX instance_teams_team ON instance_teams (team_id);

-- Latest heartbeat only (D28, D56). Counts by status, never pipeline ids or titles.
CREATE TABLE heartbeats (
  instance_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  health TEXT NOT NULL,
  worca_version TEXT NOT NULL,
  pipelines TEXT NOT NULL, -- JSON object: status -> count
  next_scheduled_at INTEGER, -- unix seconds
  suspendable INTEGER NOT NULL -- 0 / 1
);

-- Cron dedupe: Cloudflare may deliver a scheduled event twice; the first INSERT OR IGNORE of
-- (cron, slot) wins. Pruned daily after 40 days.
CREATE TABLE cron_runs (
  cron TEXT NOT NULL,
  slot TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (cron, slot)
);
