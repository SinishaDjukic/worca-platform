-- Remote access in worca (D72; docs/instance-lifecycle.md "Remote access in worca"). On hosted
-- instances worca runs in remote mode, which turns its terminal and its actions off; the org's
-- tenant admins can turn either back on per instance. Both are set on the worca service as
-- WORCA_TERMINAL_REMOTE and WORCA_ACTIONS_REMOTE ('1' on, '0' off) and take effect when worca restarts.
--   terminal_remote  1: the terminal is on (WORCA_TERMINAL_REMOTE=1)
--   actions_remote   1: actions are on: run/stop actions and stacks, open editor/terminal/files (WORCA_ACTIONS_REMOTE=1)
--   remote_pending   1: the two values above are not yet known to be applied on the worca service
--                    (saved while suspended or stopped, or the reconfigure operation failed);
--                    the next reconfigure, wake, lift or upgrade applies them and clears it
ALTER TABLE instances ADD COLUMN terminal_remote INTEGER NOT NULL DEFAULT 0 CHECK (terminal_remote IN (0, 1));
ALTER TABLE instances ADD COLUMN actions_remote INTEGER NOT NULL DEFAULT 0 CHECK (actions_remote IN (0, 1));
ALTER TABLE instances ADD COLUMN remote_pending INTEGER NOT NULL DEFAULT 0 CHECK (remote_pending IN (0, 1));
