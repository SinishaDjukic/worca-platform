# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately, by email to
**[security@worca.dev](mailto:security@worca.dev)**.

Do not open a public issue, pull request or discussion for a vulnerability,
and do not mention it in one. A public report shows the problem to everyone
before a fix is available.

A useful report includes:

- the platform version (`npm ls @worca/platform` in the deployment), and the
  Worca version of the instances involved
- the compute provider (Railway, fake, or a custom provider) and the edge
  provider (Cloudflare or fake)
- which optional modules are on (newsletter, access requests, tiers) and which
  sign-in methods (email code, passkey, Google, Microsoft, SSO)
- what an attacker can do, and what they need first (an account, a role in an
  org, an instance of their own, a crafted request)
- steps to reproduce, or a proof of concept
- any logs or screenshots, with your own secrets removed

## What to expect

| Step | Target |
| --- | --- |
| Acknowledgement of your report | within 3 business days |
| First assessment: confirmed or not, and how severe | within 10 business days |
| Fix released for a confirmed critical or high issue | within 30 days |
| Fix released for a confirmed medium or low issue | in a following release |

We keep you updated while we work on it, and we may ask you for more
details. If we decide the report is not a vulnerability, we say why.

## Disclosure

We follow coordinated disclosure:

1. We confirm the issue and prepare a fix in private.
2. We release the fixed version to npm.
3. We publish a GitHub security advisory that describes the issue, the
   affected and fixed versions, and what users should do. We request a CVE
   when the issue warrants one.

Please keep the details private until the advisory is published, or for
90 days after your report, whichever comes first. If you need a different
timeline, tell us and we will agree on one. With your permission, we credit
you in the advisory.

## Supported versions

Security fixes go into the latest release of `@worca/platform` on npm (the
`latest` tag). We do not backport fixes to older versions, so upgrade to get
them (in a deployment: `npm run upgrade`).

| Version | Supported |
| --- | --- |
| Latest stable release | Yes |
| Release candidates (`rc` tag) | Fixed in the next release candidate |
| Older releases | No |

## Scope

In scope: problems in the code of this repository, for example:

- the console or the API reachable, or usable, without the sign-in, role or
  org membership it requires ([Identity and access](docs/identity-and-access.md))
- one tenant reaching another tenant's org, instances, data or keys
- an instance reached through the gate without a valid pass, or a pass for one
  instance accepted by another ([Security](docs/security.md))
- secrets leaving where the platform keeps them: the master key and its
  derived keys, org keys, instance credentials, identity signing keys
- identity tokens the platform issues being forged, replayed or accepted by the
  wrong instance
- cross-site scripting, request forgery or open redirects in the console, the
  sign-in pages or the gate pages
- a problem in a dependency that the platform uses in an exploitable way

Out of scope:

- vulnerabilities in Worca itself (the instance image); report those as
  [worca-cc's security policy](https://github.com/SinishaDjukic/worca-cc/security/policy)
  describes, to the same address
- vulnerabilities in Cloudflare, Railway, Resend or other third-party services
  themselves; report those to their maintainers
- behaviour the documentation describes as expected, such as isolation between
  instances relying on the gate until the instance domain is on the Public
  Suffix List ([Deploying](docs/deploy.md))
- attacks that need an attacker who already controls the deployment's
  Cloudflare account, its secrets, or a superadmin account
- reports from automated scanners with no demonstrated impact
- denial of service through sheer request volume

If you are not sure whether something is in scope, report it anyway.

## Safe harbor

We will not take legal action against anyone who researches and reports a
vulnerability in good faith under this policy. Good faith means: test only
against installations you own or are allowed to test, do not access or
change other people's data, do not degrade service for others, and give us
reasonable time to fix the issue before you disclose it.
