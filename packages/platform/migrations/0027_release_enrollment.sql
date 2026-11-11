-- D77: stable npm releases of @worca/app are enrolled automatically (instances/releases.ts), and
-- superadmins can withdraw a release. A withdrawn release stays recorded, so it is never enrolled
-- again, but nothing can be created, upgraded or downgraded to it.
ALTER TABLE worca_releases ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'; -- 'manual' | 'npm'
ALTER TABLE worca_releases ADD COLUMN withdrawn_at INTEGER;
ALTER TABLE worca_releases ADD COLUMN withdrawn_by TEXT;
ALTER TABLE worca_releases ADD COLUMN withdrawn_reason TEXT; -- staff-written, shown to the tenants that run it

-- Versions on npm that aren't enrolled yet, and why: the image isn't on GHCR yet or GHCR couldn't
-- be asked (both retried every tick), or the image reports another version (held for good).
CREATE TABLE release_holds (
  version TEXT PRIMARY KEY,
  reason TEXT NOT NULL, -- 'image_missing' | 'registry_unavailable' | 'label_mismatch'
  detail TEXT,          -- label_mismatch: the version the image reports, or empty when it has none
  first_seen_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
);
