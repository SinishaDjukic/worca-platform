-- Operation progress (ui-feasibility.md T8, P2, P6) and health transitions (T5).
-- Owner: instances (src/control/instances). Times are unix milliseconds.

-- One row per instance operation (InstanceOpsWorkflow run). Written when the operation starts
-- and from inside every Workflow step (instances/progress.ts), so the consoles can show the
-- current phase without asking the Workflows API. Kept 30 days after it finishes; the row
-- outlives a deleted instance, which is why org_id is copied here.
--   kind          create, upgrade, delete, wake, suspend, stop, lift
--   workflow_id   the InstanceOpsWorkflow instance id (restart() targets it)
--   phase         user-facing phase (progress.ts OP_PHASES), not the step name
--   step          the Workflow step under way or last finished; step_running = 1 while it runs
--   attempts      attempts of the current step: a retry re-enters a step that never finished
--   status        running, done, failed
--   outcome       what runOp returned (running, upgraded, no_heartbeat, aborted, …)
--   last_error    the current step's last error; cleared when the step succeeds
CREATE TABLE instance_ops (
  op_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  workflow_id TEXT,
  phase TEXT NOT NULL,
  phase_started_at INTEGER NOT NULL,
  step TEXT,
  step_running INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  outcome TEXT,
  last_error TEXT
);
CREATE INDEX instance_ops_instance ON instance_ops (instance_id, started_at);
CREATE INDEX instance_ops_workflow ON instance_ops (workflow_id);
CREATE INDEX instance_ops_status ON instance_ops (status, phase_started_at);

-- When `health` last changed (heartbeat or the stale cron); NULL until the first change.
ALTER TABLE instances ADD COLUMN health_since INTEGER;
