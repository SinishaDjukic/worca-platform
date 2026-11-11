-- Git credentials per instance (D79; docs/instance-lifecycle.md "Git credentials"). Tenant admins set,
-- per instance, the credential Worca uses for each git host (GitHub: the org's own App or a token;
-- Azure DevOps: a PAT; Bitbucket: an access token or an Atlassian API token with its email), the commit
-- identity, an optional clone allowlist, and who pushes go out as (D79). Sent to the worca service
-- (and, for the App's client ID and secret, the broker) as Worca's own variables; takes effect when
-- Worca restarts.
--   git_settings  the whole configuration as JSON (instances/git.ts GitSettings), secrets included,
--                 encrypted with the org key (field context instances.git_settings, row id = instance
--                 id). NULL: nothing set. Never sent back to a browser.
--   git_version   0: never set from the console, and the instance's git variables are left alone.
--                 Bumped on every change; a change names the version it was based on (409
--                 git_changed); the operations clear git_pending only if it hasn't moved since they
--                 read the settings
--   git_pending   1: the settings are not yet known to be applied on Railway (saved while suspended
--                 or stopped, or the reconfigure failed); the next reconfigure, wake, lift or upgrade
--                 applies them and clears it
--   git_broker_applied  SHA-256 (hex) of the broker's git variables its running deployment was
--                 started with (instances/git-api.ts brokerGitHash); NULL: none were ever set. The
--                 operations restart the broker when the wanted ones hash differently.
ALTER TABLE instances ADD COLUMN git_settings TEXT;
ALTER TABLE instances ADD COLUMN git_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE instances ADD COLUMN git_pending INTEGER NOT NULL DEFAULT 0 CHECK (git_pending IN (0, 1));
ALTER TABLE instances ADD COLUMN git_broker_applied TEXT;
