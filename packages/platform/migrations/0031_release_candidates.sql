-- D80: release candidates. A superadmin turns them on per org; its tenant admins then pin
-- instances to a candidate by hand. Candidates are recorded in worca_releases like releases (the
-- version tells them apart: x.y.z-rc.N) and never become the latest.
ALTER TABLE org_settings ADD COLUMN rc_access INTEGER NOT NULL DEFAULT 0;
