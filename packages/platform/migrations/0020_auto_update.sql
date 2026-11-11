-- Automatic micro updates (D26 as amended; docs/instance-lifecycle.md "Automatic micro updates").
--   auto_update                 'micro': the 5-minute cron installs a newer micro release of the
--                               running major.minor (1.9.1 -> 1.9.2) while the instance is idle;
--                               'off': only tenant admins start upgrades. New instances get
--                               'micro' (the column default); instances that existed before this
--                               migration are set to 'off' below, so their admins opt in.
--   auto_update_failed_version  the version an automatic update last rolled back from; skipped by
--                               the cron until a newer micro is published. NULL when none failed.
ALTER TABLE instances ADD COLUMN auto_update TEXT NOT NULL DEFAULT 'micro' CHECK (auto_update IN ('micro', 'off'));
ALTER TABLE instances ADD COLUMN auto_update_failed_version TEXT;
UPDATE instances SET auto_update = 'off';
