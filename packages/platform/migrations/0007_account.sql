-- The person's own account (ui-feasibility.md T14).
-- When a passkey last signed someone in: set by the auth after-hook on a successful
-- /passkey/verify-authentication (src/control/auth/index.ts). ISO 8601 text like the other
-- Better Auth date columns; NULL until the passkey is first used to sign in. Better Auth doesn't
-- know this column, so it never reads or writes it.
alter table "passkey" add column "lastUsedAt" date;
