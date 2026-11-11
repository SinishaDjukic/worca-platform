-- Component refresh (D76; docs/instance-lifecycle.md "Component refresh"). What each instance was
-- last deployed with, so a newer pin of a service image (cloudflared, after a security release) can
-- be found and rolled out without a new worca version.
--   deployed_images  JSON {"worca": image, "broker": image, "cloudflared": image}: written by create,
--                    upgrade and roll back with the images they deployed, and by a refresh or a wake
--                    once the new cloudflared reported its version to Cloudflare. NULL for instances
--                    deployed before this column: their cloudflared counts as out of date.
ALTER TABLE instances ADD COLUMN deployed_images TEXT;
