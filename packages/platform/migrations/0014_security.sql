-- Org sign-in security (ui-feasibility.md T11).
-- When an SSO provider was registered, in epoch milliseconds: set by POST /api/orgs/:orgId/sso
-- right after the SSO plugin creates the row (src/control/tenancy/domains.ts) and listed by
-- GET /api/orgs/:orgId/sso. NULL for providers registered before this migration. Better Auth
-- doesn't know this column, so it never reads or writes it.
alter table "ssoProvider" add column "createdAt" integer;
