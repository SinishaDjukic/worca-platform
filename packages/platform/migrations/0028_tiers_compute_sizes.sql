-- D78: two more tiers (Team: 5 instances, Business: 10) and compute sizes. A size (instances/sizes.ts)
-- is the worca service's vCPU and memory ceiling plus worca's parallelism; a tier lists the sizes
-- its orgs may pick and which one a new instance gets. tiers.vcpu and tiers.memory_mb stay as the
-- default size's values for older readers; the size decides.
ALTER TABLE tiers ADD COLUMN sizes TEXT NOT NULL DEFAULT '["standard"]'; -- JSON list of size ids
ALTER TABLE tiers ADD COLUMN default_size TEXT NOT NULL DEFAULT 'standard';

INSERT OR IGNORE INTO tiers (id, name, instances_per_org, vcpu, memory_mb, volume_gb, members, sizes, default_size)
  VALUES ('team', 'Team', 5, 2, 4096, 10, 25, '["standard","large"]', 'standard');
INSERT OR IGNORE INTO tiers (id, name, instances_per_org, vcpu, memory_mb, volume_gb, members, sizes, default_size)
  VALUES ('business', 'Business', 10, 2, 4096, 10, 50, '["standard","large","xl"]', 'standard');

-- The instance's size; cpu and memory_mb follow it (the worca service's ceiling). size_pending: a
-- size saved but not yet known to be applied on Railway (applies with a worca restart, like D72/D73).
ALTER TABLE instances ADD COLUMN compute_size TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE instances ADD COLUMN size_pending INTEGER NOT NULL DEFAULT 0;
