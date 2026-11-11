# Architecture

## Components

| Component | Runs on | Job |
|---|---|---|
| **Control plane** | Cloudflare Worker at `app.worca.dev` | Sign-in (Better Auth), orgs, teams, members, instances, login policies, invites, limits, audit log, platform console, tenant console |
| **Database** | D1, EU jurisdiction | Everything the control plane stores; tenant data encrypted (see [Security](security.md#application-level-encryption)) |
| **Provisioner** | Cloudflare Workflows, started by the control plane | Creates, upgrades, suspends, wakes and deletes instances through the Railway and Cloudflare APIs |
| **Gate** | Cloudflare Worker on the route `*.worca.run/*` | Checks access before any request reaches an instance, enforces browser isolation, attaches the identity token |
| **Gate object** | One Durable Object per instance, EU jurisdiction | The instance's status, its live gate sessions, its last visit, waking it, and the idle alarm that suspends it (D43) |
| **Gate lookup** | KV, EU jurisdiction | Hostname → instance id, read by the gate when a request has no valid pass |
| **Email** | Resend, sending from `worca.dev` | Sign-in codes, invites, destructive-action confirmations, upgrade and abuse notices |
| **Instance** | One Railway project per instance, EU region | worca (`:4317`), credential broker (key page `:8081`, private `:8080`), cloudflared, data volume |

## Picture

```
                         app.worca.dev  (control plane Worker, D1, Workflows)
                          ▲    ▲   │
        sign-in redirect  │    │   └── provisioner ──► Railway API (project per instance)
                          │    │                   └─► Cloudflare API (tunnel, DNS, KV)
                          │    └── heartbeat ◄───────────────────────────────────┐
                          │         token renewal (service binding)              │
                          │              ▲                                       │
                          │              │                                       │
browser ──► gate Worker (*.worca.run) ───┴──► gate object (one per instance)     │
                 │                                                               │
                 └──► proxied DNS record for this host                           │
                      ──► this instance's tunnel                                 │
                          ──► cloudflared ──► worca :4317 ───────────────────────┘
                                          └─► broker key page :8081
                                 worca ──► broker private :8080
```

## Hosts

| Host | What |
|---|---|
| `app.worca.dev` | Control plane: tenant console, platform console, sign-in, API, heartbeat endpoint |
| `{slug}.worca.run` | One worca instance |
| `{key-slug}.worca.run` | That instance's broker key page |
| `worca.run`, `www.worca.run` | 301 to `https://worca.dev/hosted/`, answered by the gate Worker on its two custom domains before anything else (D67, see [Development](development.md#worcarun-apex-redirect)) |

## Signing in to an instance

1. The browser asks for `k7m2qz9xwp.worca.run`. The gate looks the host up in KV.
2. No valid gate cookie: the gate stores a random `state` in a `__Host-` cookie and redirects to
   `app.worca.dev/authorize?host=…&state=…&return=…`.
3. The control plane signs the person in if needed, checks the org's login policy, the instance's
   narrower policy, and that one of the person's teams grants this instance.
4. It redirects back to the gate's callback with a one-time code, bound to this host, valid for
   about a minute.
5. The gate checks `state` and exchanges the code server to server for an identity token. The
   gate object records a new gate session (session id, user id, control-plane session id) and
   checks the instance's status.
6. The gate sets its `__Host-` cookie for this host only. The cookie is encrypted and signed with
   the gate's key and holds the session id, a pass valid for 60 seconds, and the identity token.
7. The gate forwards each request with the identity token in a header, never with its own cookies.
   worca verifies the token against the control plane's published keys.

## Each request after that

The gate object is asked only when it matters (D44):

| Request | Gate object asked? |
|---|---|
| GET or HEAD with a valid pass | No. The gate decrypts the cookie and forwards. |
| GET or HEAD that returns secrets (`/api/models/:id/env-value`) | Yes, every time |
| GET or HEAD with an expired pass | Yes, once; then a new pass for 60 seconds |
| Any method that changes state | Yes, every time |
| WebSocket upgrade | Yes, every time |

When asked, the gate object checks that the session still exists and the instance is `running`,
and records the visit. If the identity token in the cookie has less than two minutes left, the
gate asks the control plane for a new one over a service binding (D45). The control plane checks
again that the control-plane session is valid, the person still has a team that grants this
instance, and the login policy is still met.

If the session is gone, a page navigation is redirected to sign in again; any other request gets
a 401, and worca reloads the page (W6), which leads to the same redirect.

An active user therefore costs about one gate object call a minute, plus one for each request
that changes state.

## Revoking access

The control plane drops the affected gate sessions in each gate object concerned when someone is
removed from a team or the org, a team is unassigned from an instance, a user is disabled, or a
person signs out (D46). From then on:

| What | Refused |
|---|---|
| Requests that change state, WebSocket upgrades | At once |
| Reads | Within 60 seconds, when the pass runs out |
| Open WebSockets | Within the identity token's lifetime (a few minutes), when worca closes them (W7) |

## Creating an instance

The API call reserves two slugs (instance, key page) and writes the instance row with status
`creating`. A Workflow then runs these steps, each retried on failure and resumable; their progress
is shown to the tenant as phases (see [Instance lifecycle](instance-lifecycle.md)):

1. Create the Railway project (worca, broker, cloudflared, volume) in the EU region, with
   per-service CPU and memory limits from the org's tier.
2. Create the Cloudflare Tunnel and its ingress for both hosts.
3. Add the two proxied DNS records pointing at the tunnel.
4. Register both hosts at the gate (KV entries, gate object with status `creating`).
5. Set the variables: tunnel token, `WORCA_ALLOWED_HOSTS` with the exact host, identity issuer and
   audience, broker settings, heartbeat credential, outbound network policy (D73).
6. Deploy the image (`ghcr.io/sinishadjukic/worca`; the broker is the same image, D64).
7. Wait for the first heartbeat, set status `running`, notify the tenant admin.

Deletion, suspension, waking and upgrades are in [Instance lifecycle](instance-lifecycle.md).

## Cloudflare limits that bound the number of instances

| Limit | Value | Per instance | Instances |
|---|---|---|---|
| DNS records, Free zone created after 2024-09 | 200 | 2 | about 97, then the zone moves to Pro (3,500 records, D55) |
| Cloudflare Tunnels per account | 1,000 | 1 | 1,000 |
| Durable Objects | unlimited | 1 | — |

## Stack

- **Hono** for routing in both Workers.
- **Better Auth** with its organization, email OTP, passkey and SSO plugins, on D1 through an
  adapter wrapper that encrypts and hashes fields (see [Security](security.md#the-better-auth-adapter)).
- **D1** for storage, **Durable Objects** for each instance's gate object, **KV** for the gate's
  hostname lookups, **Workflows** for provisioning, a **service binding** from the gate to the
  control plane, **Cron Triggers** for stale heartbeats.
- **Resend** for email.
- WebCrypto (AES-256-GCM, HMAC-SHA256, SHA-256) for encryption and hashing, no extra libraries.
