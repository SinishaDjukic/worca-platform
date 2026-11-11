-- Outbound network policy (D73, reworks D34; docs/instance-lifecycle.md "Outbound network policy").
-- What Worca's agents may reach on the internet: an org-wide policy, and per instance an optional
-- override that replaces it as a whole. Effective policy = the instance's override, else the org's.
-- Sent to the worca service as WORCA_EGRESS_MODE / WORCA_EGRESS_ALLOW / WORCA_EGRESS_DENY; takes
-- effect when worca restarts (and once Worca enforces it).
--   mode   'open': nothing restricted; 'block': everything except the blocklist; 'allow': only the
--          allowlist (plus the platform's own hosts), minus the blocklist. Block always wins.
--   hosts  JSON {"allow": [...], "deny": [...]} of hostnames (`example.com`, `*.example.com`),
--          encrypted with the org key (field context <table>.<column>, row id org_id / instance id).
--          Lists a mode doesn't use are stored empty.

-- The org's policy. No row: open, empty lists, version 0 (existing orgs keep what they had: nothing
-- was enforced). Deleted with the org (tenancy/lifecycle.ts).
--   version  bumped on every change; a change must name the version it was based on (409 egress_changed)
CREATE TABLE org_egress_policies (
  org_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'open' CHECK (mode IN ('open', 'block', 'allow')),
  hosts TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Per instance:
--   egress_mode     NULL: no override, the instance follows the org's policy; else the override's mode
--   egress_hosts    the override's lists (as `hosts` above), NULL without an override
--   egress_version  bumped whenever the instance's effective policy may have changed: its override
--                   was set or removed, or the org policy it follows changed. A change of the
--                   override names the version it was based on (409 egress_changed); the operations
--                   clear egress_pending only if it hasn't moved since they read the policy
--   egress_pending  1: the effective policy is not yet known to be applied on the worca service
--                   (saved while suspended, stopped or busy, or the reconfigure failed); the next
--                   reconfigure, wake, lift or upgrade applies it and clears it
ALTER TABLE instances ADD COLUMN egress_mode TEXT CHECK (egress_mode IS NULL OR egress_mode IN ('open', 'block', 'allow'));
ALTER TABLE instances ADD COLUMN egress_hosts TEXT;
ALTER TABLE instances ADD COLUMN egress_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE instances ADD COLUMN egress_pending INTEGER NOT NULL DEFAULT 0 CHECK (egress_pending IN (0, 1));
