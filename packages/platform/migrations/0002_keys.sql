-- Key hierarchy (D36-D38): one data key per org and per user, wrapped under the master key.
-- `wrapped` is wiped (NULL) and `destroyed_at` set when the key is destroyed (crypto-erasure).
CREATE TABLE data_keys (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('org', 'user')),
  owner_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  wrapped TEXT,
  created_at INTEGER NOT NULL,
  destroyed_at INTEGER,
  UNIQUE (owner_type, owner_id, version)
);
