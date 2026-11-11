-- Automatic minor updates (D75; docs/instance-lifecycle.md "Automatic updates"). auto_update keeps
-- 'micro' or 'off' (its CHECK can't change without rebuilding the table); this column says whether
-- an instance with automatic updates on also takes minor releases (x.Y.0) of its major.
--   auto_update_minor  1: the 5-minute cron also installs a newer minor release while the instance
--                      is idle. Only meaningful with auto_update = 'micro'; turning automatic
--                      updates off clears it. The API shows the pair as one mode: 'off', 'micro' or
--                      'minor' (instances/api.ts AUTO_UPDATE_MODE_SQL). Off for every instance.
ALTER TABLE instances ADD COLUMN auto_update_minor INTEGER NOT NULL DEFAULT 0 CHECK (auto_update_minor IN (0, 1));
