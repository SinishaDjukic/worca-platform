-- Key rotation (D37 master key, D38 org data keys). Owner: src/control/keys.ts, keys-jobs.ts.
--
-- data_keys.master_id: which master key wrapped this row, as a fingerprint of that key
--   ('k' + 16 hex of HMAC-SHA256(K_id, "worca-run master key id v1"), K_id = HKDF-SHA256(master,
--   info "worca-run master-id v1"); keys.ts also accepts the earlier HMAC-under-the-raw-master
--   fingerprint, which only local dev databases hold). NULL on rows written
--   before 0011: unwrap then tries MASTER_KEY, then MASTER_KEY_PREVIOUS. A master rotation
--   re-wraps every live row whose master_id isn't the current master's.
-- data_keys.rotated_at / rotated_by: set on the version an org key rotation created (unix ms,
--   user id; rotated_by NULL for system rotations).
ALTER TABLE data_keys ADD COLUMN master_id TEXT;
ALTER TABLE data_keys ADD COLUMN rotated_at INTEGER;
ALTER TABLE data_keys ADD COLUMN rotated_by TEXT;
CREATE INDEX data_keys_master_id ON data_keys (master_id);

-- One re-encryption job per org (D38): moves every ciphertext the org owns to target_version,
-- in bounded batches driven by the KeyRotationWorkflow, then destroys the older versions once a
-- verification pass finds none left. A newer rotation replaces the row (new target, step 0).
--   status     running -> verifying -> done | incomplete (old versions kept; see last_error)
--   step       index into the org column registry (keys-jobs.ts ORG_COLUMNS); cursor = last row
--              id done in that column
--   done/total rows re-encrypted (or found already current) / rows needing it when the job began
--   failed     rows that could not be decrypted (left untouched; their versions are kept)
--   passes     re-encryption passes so far (verification restarts one if stragglers appear)
CREATE TABLE key_rotation_jobs (
  org_id TEXT PRIMARY KEY,
  target_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'verifying', 'done', 'incomplete')),
  step INTEGER NOT NULL DEFAULT 0,
  cursor TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  passes INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);

-- audit_org stays append-only, with one exception: the re-encryption job may replace an entry's
-- encrypted details with a ciphertext under a newer key version (same plaintext, same AAD).
-- Every other column must be unchanged, old and new details must both be ciphertexts
-- ('e1.<version>.<iv>.<ct>', version all digits), and the new version must be strictly greater
-- than the old, so an entry can't be swapped back to an older ciphertext or replayed at the same
-- version. COALESCE: a NULL anywhere (details set to NULL) counts as not allowed.
DROP TRIGGER audit_org_no_update;
CREATE TRIGGER audit_org_no_update BEFORE UPDATE ON audit_org
WHEN NOT COALESCE((
  NEW.id IS OLD.id AND NEW.org_id IS OLD.org_id AND NEW.at IS OLD.at AND NEW.actor_id IS OLD.actor_id
  AND NEW.actor_scope IS OLD.actor_scope AND NEW.action IS OLD.action
  AND NEW.target_type IS OLD.target_type AND NEW.target_id IS OLD.target_id
  AND OLD.details GLOB 'e1.[0-9]*.?*.?*' AND NEW.details GLOB 'e1.[0-9]*.?*.?*'
  AND substr(OLD.details, 4, instr(substr(OLD.details, 4), '.') - 1) NOT GLOB '*[^0-9]*'
  AND substr(NEW.details, 4, instr(substr(NEW.details, 4), '.') - 1) NOT GLOB '*[^0-9]*'
  AND CAST(substr(NEW.details, 4, instr(substr(NEW.details, 4), '.') - 1) AS INTEGER)
    > CAST(substr(OLD.details, 4, instr(substr(OLD.details, 4), '.') - 1) AS INTEGER)
), 0)
BEGIN
  SELECT RAISE(ABORT, 'audit_org is append-only');
END;
