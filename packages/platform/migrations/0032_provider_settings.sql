-- Provider settings, declared by the compute provider (docs/providers.md "Settings"): what an
-- instance's tenant admins set for it, as {"provider": name, "values": {...}}. Values saved for
-- another provider are ignored. The deployment's own provider settings live in platform_settings
-- (key compute_settings), same shape. Secret fields hold a Worker secret's name, never a value.
ALTER TABLE instances ADD COLUMN provider_settings TEXT;
