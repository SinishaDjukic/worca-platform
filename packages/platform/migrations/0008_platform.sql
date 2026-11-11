-- Platform console additions (ui-feasibility.md P7, P10).

-- P7: a staff note per registration code and the number of uses it was created with. The note is
-- encrypted with the creating staff member's user key (field context registration_codes.note,
-- row id code_hash, owner { type: 'user', id: created_by }): staff may write who a code is for.
ALTER TABLE registration_codes ADD COLUMN note TEXT;
ALTER TABLE registration_codes ADD COLUMN uses_total INTEGER;
-- Existing codes never recorded their total; what is left is the best lower bound.
UPDATE registration_codes SET uses_total = uses_left WHERE uses_total IS NULL;

-- P10: published worca releases, replacing the platform_settings JSON list
-- `worca_released_versions`. platform_settings `worca_version` stays the latest release.
-- published_at is NULL for releases published before this table existed (date unknown).
CREATE TABLE worca_releases (
  version TEXT PRIMARY KEY,
  published_at INTEGER,
  published_by TEXT
);

-- The current latest: its settings row was written when it was published.
INSERT OR IGNORE INTO worca_releases (version, published_at, published_by)
  SELECT value, NULLIF(updated_at, 0), NULL FROM platform_settings WHERE key = 'worca_version';

INSERT OR IGNORE INTO worca_releases (version, published_at, published_by)
  SELECT j.value, NULL, NULL
  FROM platform_settings s,
       json_each(CASE WHEN json_valid(s.value) THEN s.value ELSE '[]' END) j
  WHERE s.key = 'worca_released_versions' AND j.type = 'text';

DELETE FROM platform_settings WHERE key = 'worca_released_versions';
