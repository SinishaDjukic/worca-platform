-- Mail counting (P12, P13) and delivery status from Resend webhooks (S2).
-- No recipient addresses are stored here.

-- Sends we made, per UTC day (YYYY-MM-DD) and kind:
-- sign_in_code, invitation, confirmation, notification, passkey_notice.
CREATE TABLE mail_daily (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);

-- One row per sent mail that the caller tagged with a reference (e.g. invitation:<id>).
-- email_id is Resend's id from the send response; last_event comes from the webhooks.
CREATE TABLE mail_messages (
  email_id TEXT PRIMARY KEY,
  ref TEXT NOT NULL,
  kind TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  last_event TEXT, -- sent, delivered, delivery_delayed, bounced, complained, failed, send_failed
  last_event_at INTEGER
);
CREATE INDEX mail_messages_ref ON mail_messages (ref, sent_at);
