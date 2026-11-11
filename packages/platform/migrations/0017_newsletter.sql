-- Newsletter (D70): subscribers with double opt-in and preferences, and the issues sent to them.
-- src/control/newsletter/. The address is encrypted with the subscriber's own data key
-- ({ type: 'user', id: <subscriber id> }; ids start with `nl_`, so they never collide with a user
-- id), so deleting a subscriber and their key erases the address everywhere.

-- releases: the threshold of release mail. 'major' = major releases only, 'minor' = major and
-- minor, 'micro' = every stable release, 'rc' = everything including release candidates,
-- 'none' = no release mail. product: 1 = product news.
-- token_version: part of the signed manage/unsubscribe token; "unsubscribe from everything"
-- bumps it, so every earlier link stops working.
-- confirm_token_hash / confirm_expires_at: the pending double opt-in link (SHA-256 of the token).
-- source: where the consent was given ('website', 'account', ...); confirmed_at: when.
-- shred_after: set when the subscriber unsubscribes or is suppressed. Until then the address can
-- still be used (an unsubscribe undone from the manage page); after it the daily cron shreds it:
-- the subscriber's data key is deleted and email set to NULL. email_index and status stay, so the
-- address is still recognised (suppression list); signing up again writes a fresh address under
-- a new subscriber id and key.
CREATE TABLE newsletter_subscribers (
  id TEXT PRIMARY KEY,
  email TEXT,
  email_index TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('unconfirmed', 'active', 'unsubscribed', 'suppressed')),
  releases TEXT NOT NULL CHECK (releases IN ('none', 'major', 'minor', 'micro', 'rc')),
  product INTEGER NOT NULL DEFAULT 1 CHECK (product IN (0, 1)),
  token_version INTEGER NOT NULL DEFAULT 1,
  confirm_token_hash TEXT,
  confirm_expires_at INTEGER,
  source TEXT,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  unsubscribed_at INTEGER,
  updated_at INTEGER NOT NULL,
  shred_after INTEGER
);
CREATE INDEX newsletter_subscribers_status ON newsletter_subscribers (status, releases, id);
CREATE INDEX newsletter_subscribers_confirm ON newsletter_subscribers (confirm_token_hash);
CREATE INDEX newsletter_subscribers_unconfirmed ON newsletter_subscribers (status, created_at);
CREATE INDEX newsletter_subscribers_shred ON newsletter_subscribers (shred_after);

-- One row per send. release_level: what the release hook classified the version as. recipients
-- is counted when the issue starts; sent_count grows batch by batch (NewsletterSendWorkflow).
CREATE TABLE newsletter_issues (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('release', 'product')),
  version TEXT,
  release_level TEXT CHECK (release_level IS NULL OR release_level IN ('major', 'minor', 'micro', 'rc')),
  subject TEXT NOT NULL,
  url TEXT,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  recipients INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
-- One release issue per version: the release hook is idempotent. (NULL versions don't collide.)
CREATE UNIQUE INDEX newsletter_issues_version ON newsletter_issues (kind, version);
CREATE INDEX newsletter_issues_created ON newsletter_issues (created_at);
