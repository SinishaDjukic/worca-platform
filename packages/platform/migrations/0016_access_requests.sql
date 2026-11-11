-- Access requests for hosted worca (D69): the website's "request access" form
-- (POST /api/public/access-requests). A request is 'unconfirmed' until the requester opens the
-- emailed link, then 'pending' for superadmins, then 'granted' (a single-use registration code
-- tied to the address was mailed) or 'declined'; 'joined' once an account signed up with that code.
-- email, use_case, company and decision_note are encrypted with the request's own data key
-- (field context access_requests.<column>, rowId = id, owner { type: 'user', id }; ids start with
-- `ar_`, so they never collide with a user id or a newsletter subscriber's `nl_`).
-- Retention (daily cron, public/access-requests.ts): an unconfirmed request is deleted, with its
-- key, 7 days after its link expired. 180 days after the decision (granted, declined) or the
-- sign-up (joined), the key is deleted and the personal columns emptied (shredded_at set); the
-- anonymous row stays for the funnel counts.
CREATE TABLE access_requests (
  id TEXT PRIMARY KEY,
  email TEXT, -- NULL once shredded
  email_index TEXT, -- blind index of the trimmed, lowercased address (KeyRing.emailIndex); NULL once shredded
  use_case TEXT, -- NULL once shredded
  company TEXT,
  source TEXT, -- where the form was, e.g. 'hosted'; plain
  status TEXT NOT NULL CHECK (status IN ('unconfirmed', 'pending', 'granted', 'declined', 'joined')),
  confirm_token_hash TEXT, -- SHA-256 of the emailed token (D49)
  confirm_expires_at INTEGER,
  confirm_sent_at INTEGER, -- last confirmation mail; a resend waits an hour
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  decided_at INTEGER,
  decided_by TEXT,
  decision_note TEXT, -- the staff member's message to the requester, if any
  registration_code_id TEXT, -- registration_codes.code_hash of the granted code
  joined_at INTEGER,
  notified_at INTEGER, -- when superadmins were told about it (first notice or the hourly digest)
  shredded_at INTEGER -- when the key and the personal columns were deleted (retention)
);
-- At most one open request per address: a second submission resends or does nothing.
CREATE UNIQUE INDEX access_requests_open_email ON access_requests (email_index) WHERE status IN ('unconfirmed', 'pending');
CREATE INDEX access_requests_status ON access_requests (status, created_at);
CREATE INDEX access_requests_token ON access_requests (confirm_token_hash);
CREATE INDEX access_requests_code ON access_requests (registration_code_id);

-- A code made for one address: sign-up with it is refused for any other address
-- (auth/registration.ts claimCode). NULL for ordinary codes, which anyone may use.
ALTER TABLE registration_codes ADD COLUMN email_index TEXT;
