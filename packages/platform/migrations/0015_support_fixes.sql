-- Platform support (P8) fixes. Who disabled an account, so re-enabling it needs at least the
-- same platform rank (src/control/tenancy/support-routes.ts). Set by POST
-- /api/platform/users/:id/disable, cleared on enable; NULL for accounts disabled before this
-- migration (then only the ordinary rank rule applies). disabledByRole is the disabler's
-- strongest platform role at that moment ('support' | 'admin' | 'superadmin'), kept so a later
-- demotion of the disabler doesn't lower the bar. Better Auth doesn't know these columns.
alter table "user" add column "disabledBy" text;
alter table "user" add column "disabledByRole" text;
