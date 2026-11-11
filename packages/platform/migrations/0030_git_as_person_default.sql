-- D79: members' own GitHub tokens by default. Every instance whose git settings nobody saved yet
-- (git_version 0) gets WORCA_GH_AS_PERSON=prefer with its other settings (instances/egress-api.ts
-- worcaSettingsFor). Instances that exist already are marked pending, so their next wake, lift,
-- upgrade or reconfigure sets it; the consoles don't show this as "not applied yet" (git_version 0).
UPDATE instances SET git_pending = 1 WHERE git_version = 0 AND status <> 'deleting';
