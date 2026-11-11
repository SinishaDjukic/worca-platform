# Fly.io

Evaluated on 2026-10-06 as the replacement for Railway, whose terms rule out this platform
Not decided yet. Sources are numbered at the end.

## Verdict

Viable, on one condition: Fly confirms in writing that a platform like ours is allowed. Its Terms
of Service list "for the benefit of a third party" among the restrictions, a stronger position
than Railway's registration wording; Fly staff have said in public that platforms are allowed and
the wording is being changed. Everything else fits the design, with the changes listed below.

Since Railway's terms turned out to be a moderate risk rather than a blocker (see
[Railway](railway.md#terms-of-service)), Fly.io is the fallback if Railway says no.

## VMs, not containers

Fly runs ordinary Docker/OCI images, but not in a container engine: each image is unpacked into
the disk of its own small VM (a Firecracker microVM, a *Machine*) and its entrypoint runs there
[8]. There is no Docker daemon.

- Our images run unchanged. Every tenant's agents get their own kernel, which isolates them
  better than containers sharing one.
- The root disk is reset on every restart; anything that must last goes on a volume [8].
- Several processes in one Machine work. Several containers in one Machine (`containers` in the
  Machine config) exist but are "currently restricted to only specific organizations" [9][10].
  Docker inside a Machine is possible but only community-documented [28], so worca's Docker
  Compose egress setup becomes separate Machines instead.

## Terms

- Terms of Service (2026-04-29): use "solely for Customer's internal use"; the service may not be
  used "for the benefit of a third party" [1].
- Fly support, 2026-09-23: "Yes, we allow customers to build and run their own platforms on top
  of us", and the terms are being reworded [3]. A forum post is not a contract.
- Fly's own docs recommend one app per customer and cover running untrusted user code [4][5].
- Acceptable Use Policy: no cryptomining, no penetration testing; Fly may suspend "with or
  without notice, in its sole discretion" [2]. Suspension applies to the whole Fly organization,
  so one abusive tenant could take every instance down. Our egress allowlist (D34) matters more
  here.
- Fly is a US company; a data processing agreement is available (forum report, unverified) [31].

## How an instance would map

| worca-run | Fly |
|---|---|
| Instance | One Fly app, created on its own private network `inst-<id>` [6][7]. The network can't be changed later. Apps on different networks can't reach each other; by default every app in an organization shares one network [4]. |
| worca | Machine, 4 GB, with a 10 GB volume |
| Credential broker | Machine with a 1 GB volume |
| cloudflared and the egress proxy | One small Machine |
| Public ingress | None. Apps created through the API have no IP addresses until some are allocated [24]; cloudflared only connects outward. |
| Variables | App secrets API [10] |
| Provisioner credential | Organization token with an expiry; created once with `flyctl` [19] |
| Region | `fra` or `ams` (EU regions now: ams, arn, cdg, fra) [17] |

Separate Fly organizations per tenant aren't possible: the API can't create organizations [10].

## Machines API

Plain HTTPS at `api.machines.dev` with a bearer token, so a Workflow can drive it [11]. It covers
apps, Machines (create, update, start, stop, suspend, wait, destroy), volumes, snapshots, app
secrets and network policies [10]. App creation takes an idempotency key, which suits retried
Workflow steps. Rate limits: 1 request per second per action per Machine or app (bursts of 3),
5 reads per second, 100 app deletions a minute [11].

## Volumes and deletion

- One volume per Machine, on one server, not replicated; encrypted at rest; $0.15/GB-month
  [15][16].
- Daily snapshots are **on by default** (kept 5 days) [13]. Volumes must be created with
  `auto_backup_enabled: false` (D32); the API can't delete a snapshot once taken [10].
- A destroyed volume stays recoverable for 24 hours, and when Fly moves a volume between servers
  the old copy is kept for a week [14]. Hard delete (D29) therefore needs our own encryption
  inside the instance with a per-instance key the control plane destroys on deletion.

## Stop, suspend and wake

- A stopped Machine costs only its disk image and volumes, about $2.50 a month per instance [16].
- Suspend (memory kept, resume in a few hundred milliseconds) only works up to 2 GB of memory,
  so worca at 4 GB uses stop and start, which takes about 2 seconds or more [12].
- Fly's autostart only reacts to traffic through Fly's own proxy [23]; ours comes through
  cloudflared, so the gate object starts the Machines through the API, as with Railway (D48).

## Limits and cost

- Shared CPUs get a baseline of 6.25% of a core per vCPU, with bursts [20]. Long agent builds
  will be throttled; performance CPUs cost more.
- No spending caps or billing alerts [21]. The number of Machines per organization has a cap
  that support raises on request [22]; no cap on apps or networks [7].
- Always-on cost per instance, before outbound traffic [16]:

| Item | fra | ams |
|---|---|---|
| worca, shared-cpu-2x, 4 GB | $29.31 | $26.38 |
| Broker, shared-cpu-1x, 256 MB | $2.53 | $2.28 |
| cloudflared and egress proxy, shared-cpu-1x, 512 MB | $4.26 | $3.84 |
| Volumes, 10 GB + 1 GB | $1.65 | $1.65 |
| **Total** | **about $37.75** | **about $34.15** |

worca on a performance-1x CPU with 4 GB comes to about $52 in fra. No IP address fees, since we
allocate none.

## Egress

Fly's network policies allow traffic by port and protocol, not by domain, and changes need a
Machine restart [18]. So worca's egress proxy stays: it runs in its own Machine, and a network
policy lets worca out only to the proxy's port. Whether policies apply to traffic inside the
app's private network is part of the spike test.

## Spike test before deciding

1. A Worker creates the app, network, volumes, Machines and secrets end to end.
2. Network policies are enforced inside the app's private network.
3. Apps on different custom networks can't reach each other.
4. Cold start time with our images.
5. Throttling of shared-cpu-2x during agent builds.
6. `auto_backup_enabled: false` leaves no snapshots.
7. cloudflared works with no IP addresses allocated.
8. Whether Fly enables multi-container Machines for our organization.
9. A written answer from Fly (legal@fly.io) that the platform is allowed.

## What would change in the design

| Area | Change if we move to Fly |
|---|---|
| D4 | One Fly app per instance on its own private network, three Machines (worca, broker, cloudflared with the egress proxy), instead of one Railway project |
| D29, D32 | Volumes created with snapshots off. Because Fly keeps a deleted volume for 24 hours and old copies for a week after moving it, the instance encrypts its data with a per-instance key that the control plane destroys on deletion |
| D33 | Shared CPUs have a 6.25% baseline per vCPU; agent builds may need performance CPUs (about $52 instead of $38 a month per instance) |
| D34 | More important: Fly suspends the whole organization for abuse, so one tenant could take every instance down |
| D48 | Stop and start Machines through the Machines API; suspend can't be used for worca at 4 GB |
| Cost control | Fly has no spending caps or alerts; the control plane has to watch usage itself |

## Next steps, if we go this way

1. Write to legal@fly.io for written confirmation that a multi-tenant platform running
   customers' AI agents is allowed (from the account owner).
2. Run the spike test above.

## Other providers, briefly

| | Reselling or third-party clause | Volumes | EU | API |
|---|---|---|---|---|
| Northflank | None found; forbids using it "to compete with us" (terms from 2021) [29] | Yes (unverified) | Unverified | Yes; can run in our own cloud account [33] |
| Scaleway Instances | None found in the 2026-04-07 terms; cryptomining banned [30] | Block storage (unverified) | Native | Yes (unverified) |
| Koyeb | Terms page unreachable; unverified | Unverified | fra, par (unverified) | Yes |

## Sources

[1] https://fly.io/legal/terms-of-service
[2] https://fly.io/legal/acceptable-use-policy
[3] https://community.fly.io/t/terms-of-service-question/28681
[4] https://docs.fly.io/machines/guides-examples/one-app-per-user-why
[5] https://docs.fly.io/blueprints/per-user-dev-environments
[6] https://docs.fly.io/networking/custom-private-networks
[7] https://community.fly.io/t/recommended-tenant-isolation-for-a-multi-tenant-platform-on-machines/28435
[8] https://docs.fly.io/blueprints/working-with-docker
[9] https://docs.fly.io/machines/guides-examples/multi-container-machines
[10] https://docs.fly.io/api/machines/openapi.json
[11] https://docs.fly.io/machines/api/working-with-machines-api
[12] https://docs.fly.io/reference/suspend-resume
[13] https://docs.fly.io/volumes/snapshots
[14] https://docs.fly.io/volumes/volume-states
[15] https://docs.fly.io/volumes/overview
[16] https://docs.fly.io/about/pricing
[17] https://docs.fly.io/reference/regions
[18] https://docs.fly.io/machines/guides-examples/network-policies
[19] https://docs.fly.io/security/tokens
[20] https://docs.fly.io/machines/cpu-performance
[21] https://docs.fly.io/about/cost-management
[22] https://community.fly.io/t/machines-limit-per-org-increasing-amount/27076
[23] https://docs.fly.io/launch/autostop-autostart
[24] https://docs.fly.io/networking/services
[28] https://community.fly.io/t/run-docker-containers-inside-of-app/17192
[29] https://northflank.com/legal/terms
[30] https://www-uploads.scaleway.com/Conditions_Generales_de_Services_General_Terms_of_Services_07042026_f7d4a2f613.pdf
[31] https://community.fly.io/t/request-for-gdpr-data-processing-agreement-dpa/25461
[33] https://northflank.com/product/customer-vpc-deployments
