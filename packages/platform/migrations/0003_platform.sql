-- Platform tables (tenancy): settings, tiers, registration codes, platform roles, org settings,
-- confirmations and the two audit logs. Shared shapes: docs/internal-apis.md "Shared tables".
-- Times are unix milliseconds.

CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- D25: registration launches as invite-code only.
INSERT INTO platform_settings (key, value, updated_at) VALUES
  ('registration_mode', 'invite_code', 0),
  ('default_tier', 'free', 0);

-- Codes are stored only as SHA-256 hex (D49).
CREATE TABLE registration_codes (
  code_hash TEXT PRIMARY KEY,
  created_by TEXT,
  tier TEXT NOT NULL,
  uses_left INTEGER NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

-- D13, D14: scoped bindings on one account; no platform role grants instance access (D15).
CREATE TABLE platform_roles (
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('superadmin', 'admin', 'support')),
  granted_by TEXT,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE tiers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  instances_per_org INTEGER NOT NULL,
  vcpu REAL NOT NULL,
  memory_mb INTEGER NOT NULL,
  volume_gb INTEGER NOT NULL,
  members INTEGER NOT NULL
);
-- D33: free tier.
INSERT INTO tiers (id, name, instances_per_org, vcpu, memory_mb, volume_gb, members)
  VALUES ('free', 'Free', 1, 2, 4096, 10, 10);

CREATE TABLE org_settings (
  org_id TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

-- D30: emailed second confirmation. payload is encrypted with the org key when org_id is set,
-- else with the user key; the token is stored only as a hash (D49).
CREATE TABLE confirmations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  org_id TEXT,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  payload TEXT,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_confirmations_user ON confirmations(user_id);
CREATE INDEX idx_confirmations_org ON confirmations(org_id);

-- D40: platform log. details hold ids and numbers only, never tenant data (not encrypted).
CREATE TABLE audit_platform (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT
);
CREATE INDEX idx_audit_platform_at ON audit_platform(at);
CREATE INDEX idx_audit_platform_actor ON audit_platform(actor_id);

-- D40, D41: org log, details encrypted with the org key.
CREATE TABLE audit_org (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor_id TEXT,
  actor_scope TEXT NOT NULL CHECK (actor_scope IN ('tenant', 'platform', 'system')),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT
);
CREATE INDEX idx_audit_org_org_at ON audit_org(org_id, at);
CREATE INDEX idx_audit_org_actor ON audit_org(actor_id);

-- Append-only, except for the 30-day retention (D57) and, for the org log,
-- deletion together with its org (security.md "Audit trail"): org_settings goes first.
CREATE TRIGGER audit_platform_no_update BEFORE UPDATE ON audit_platform
BEGIN
  SELECT RAISE(ABORT, 'audit_platform is append-only');
END;

CREATE TRIGGER audit_platform_retention BEFORE DELETE ON audit_platform
WHEN OLD.at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 2592000000
BEGIN
  SELECT RAISE(ABORT, 'audit_platform keeps entries for 30 days');
END;

CREATE TRIGGER audit_org_no_update BEFORE UPDATE ON audit_org
BEGIN
  SELECT RAISE(ABORT, 'audit_org is append-only');
END;

CREATE TRIGGER audit_org_retention BEFORE DELETE ON audit_org
WHEN OLD.at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 2592000000
  AND EXISTS (SELECT 1 FROM org_settings WHERE org_id = OLD.org_id)
BEGIN
  SELECT RAISE(ABORT, 'audit_org keeps entries for 30 days');
END;
