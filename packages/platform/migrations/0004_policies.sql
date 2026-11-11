-- Login policies (D23) and org domains for SSO (D22). Methods are SessionInfo['method'] values.

-- allowed_methods: JSON array; empty means every method. required_domain is encrypted with the
-- org key; required_domain_index is its blind index.
CREATE TABLE org_login_policies (
  org_id TEXT PRIMARY KEY,
  allowed_methods TEXT NOT NULL DEFAULT '[]',
  required_domain TEXT,
  required_domain_index TEXT,
  updated_at INTEGER NOT NULL
);

-- An instance can only narrow its org's policy (D23). required_methods: JSON array.
CREATE TABLE instance_login_policies (
  instance_id TEXT PRIMARY KEY,
  required_methods TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

-- domain is encrypted with the org key; lookups go through domain_index.
CREATE TABLE org_domains (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  domain_index TEXT NOT NULL,
  verification_token TEXT NOT NULL,
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, domain_index)
);
CREATE INDEX idx_org_domains_index ON org_domains(domain_index);
