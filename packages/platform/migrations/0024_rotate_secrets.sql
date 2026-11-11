-- Renewing an instance's credentials (D74; docs/instance-lifecycle.md "Rotate"). The rotate operation
-- gives an instance a new tunnel secret, broker secret and heartbeat credential.
--   heartbeat_cred_hash_prev  the credential a running instance used before the rotation, accepted
--                             while its services restart: until its first beat with the new one
--                             clears it, and never after heartbeat_cred_prev_until. NULL otherwise.
--   heartbeat_cred_prev_until when the previous credential stops being accepted (ms), so a rotation
--                             that fails can't leave a possibly leaked credential working
--   secrets_rotated_at        when the last rotation finished (ms), NULL if never
ALTER TABLE instances ADD COLUMN heartbeat_cred_hash_prev TEXT;
ALTER TABLE instances ADD COLUMN heartbeat_cred_prev_until INTEGER;
ALTER TABLE instances ADD COLUMN secrets_rotated_at INTEGER;
CREATE UNIQUE INDEX instances_heartbeat_cred_prev ON instances (heartbeat_cred_hash_prev);
