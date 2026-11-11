-- What an instance really runs on, as Railway last reported it (src/control/instances/compute-facts.ts):
-- the region of the worca service's latest deployment, and each service's CPU and memory ceilings
-- and volume size. Not the tier's intended size (cpu, memory_mb, volume_gb). Refreshed after a
-- create and an upgrade, and by the 5-minute cron for instances not checked for 6 hours; a failed
-- read keeps the previous facts.
--   compute_facts     JSON ComputeFacts (providers/types.ts); NULL until first checked
--   compute_facts_at  unix ms of the last successful read
ALTER TABLE instances ADD COLUMN compute_facts TEXT;
ALTER TABLE instances ADD COLUMN compute_facts_at INTEGER;
