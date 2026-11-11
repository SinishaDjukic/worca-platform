-- Platform support (P8): the registration code a user signed up with, and two-person requests.
-- Times are unix milliseconds.

-- Which registration code created the account: registration_codes.code_hash (a SHA-256, D49).
-- Set by the user create hook from now on; NULL for accounts created before this migration.
ALTER TABLE "user" ADD COLUMN "registrationCodeId" text;

-- Two-person support actions. kind 'signin_reset': delete every passkey of a user who lost them
-- all and end their sessions. One staff member requests, a different one approves within 24 h;
-- approving executes. reason is encrypted with the target user's key (field context
-- support_requests.reason, rowId = id, owner user user_id), so erasing the user erases it.
CREATE TABLE support_requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('signin_reset')),
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  executed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'executed'))
);
CREATE INDEX idx_support_requests_status ON support_requests(status, expires_at);
CREATE INDEX idx_support_requests_user ON support_requests(user_id);
