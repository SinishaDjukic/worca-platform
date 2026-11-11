-- Retention (src/control/system/retention.ts): the daily cron deletes expired sessions and
-- verifications and old mail records in batches. These indexes keep each batch from scanning
-- the whole table. (invitation and support_requests are small, or indexed already.)
CREATE INDEX IF NOT EXISTS "session_expiresAt_idx" ON "session" ("expiresAt");
CREATE INDEX IF NOT EXISTS "verification_expiresAt_idx" ON "verification" ("expiresAt");
CREATE INDEX IF NOT EXISTS mail_messages_sent_at ON mail_messages (sent_at);
