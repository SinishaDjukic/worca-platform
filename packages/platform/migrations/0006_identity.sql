-- One-time sign-in codes the control plane hands to the gate's callback (architecture.md
-- "Signing in to an instance", D49: only the SHA-256 of the code is stored).
CREATE TABLE IF NOT EXISTS gate_codes (
  code_hash TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL, -- control-plane session id
  instance_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL, -- unix ms
  used_at INTEGER, -- unix ms; set once, atomically, by exchangeCode
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gate_codes_expires_at ON gate_codes (expires_at);
