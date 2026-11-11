# Web UI (the console on the app origin)

The org workspace and the platform console, in one app. Plain ES modules and one stylesheet, no
framework and no build step, like worca's own UI (`worca-cc/ui/public`). The control Worker serves
it (`src/control/ui.ts`): `/assets/*` are the files in `ui/assets/`, and every other GET that isn't
an API or server-rendered page gets `ui/index.html`, but only when signed in (otherwise
`/sign-in?next=…`). The concept and the decisions are in [docs/ui.md](../docs/ui.md); the API in
[docs/internal-apis.md](../docs/internal-apis.md) and the route files under `src/control`.

## Files

| File | What |
|---|---|
| `index.html` | The shell page: loads `app.css` and `js/main.mjs` |
| `assets/app.css` | worca's "Refined" design system (tokens, shell, cards, rows, pills, forms, modals) |
| `assets/pages.css` | Extra rules for the server-rendered pages (`/sign-in`, `/invite`, `/confirm`, messages; `src/control/auth/pages.ts`) |
| `assets/js/core.mjs` | Runtime: `html` templates, icons, `api`, router, modals, toasts, passkeys, `protectedAction` |
| `assets/js/shell.mjs` | Sidebar, context switcher, the navigation of each area |
| `assets/js/main.mjs` | Loads `/api/me`, registers the views, guards org and platform areas |
| `assets/js/views/*.mjs` | The views, one module per part of the app (below) |

## Routes

| Module | Routes |
|---|---|
| `personal.mjs` | `/` Home (every instance across orgs), `/welcome` (no org yet: create one, pending invitations), `/pending` (waitlist) |
| `account.mjs` | `/account` (profile, sign-in methods: passkeys and linked Google/Microsoft), `/account/sessions`, `/account/data` (export, delete account) |
| `org-overview.mjs` | `/o/:orgId`: admin overview (summary), or the instances a tenant user can open |
| `instances.mjs` | `/o/:orgId/instances`, `/o/:orgId/instances/new`, `/o/:orgId/instances/:id` |
| `people.mjs` | `/o/:orgId/members` (directory; admins: invitations and management), `/o/:orgId/teams`, `/o/:orgId/teams/:teamId` |
| `org-admin.mjs` | `/o/:orgId/security` (policy, domains, SSO), `/o/:orgId/audit`, `/o/:orgId/settings` (rename, keys, delete) |
| `platform-core.mjs` | `/platform` overview, `/platform/orgs[/:id]`, `/platform/instances[/:id]`, `/platform/ops`, `/platform/releases` |
| `platform-people.mjs` | `/platform/registration`, `/platform/users`, `/platform/audit`, `/platform/roles`, `/platform/system` |

## A view

```js
import { api, html, icon, p, protectedAction, toast, busy, $ } from '../core.mjs';

export default [
  {
    path: '/o/:orgId/teams', // :params become ctx.params
    nav: 'teams',            // key of the active sidebar entry (shell.mjs), or (params) => key
    title: 'Teams',          // document title
    adminOnly: false,        // org views only: tenant users are sent to the org home
    async render(ctx) {
      const { teams } = await api.get(p`/api/orgs/${ctx.orgId}/teams`);
      if (!ctx.alive()) return;                 // the person navigated away meanwhile
      ctx.set(html`<div class="page">…${teams.map((t) => html`<div class="row">${t.name}</div>`)}</div>`);
      $('#new-team', ctx.el)?.addEventListener('click', (e) => busy(e.currentTarget, async () => { … }));
    },
  },
];
```

`ctx`: `params`, `query` (URLSearchParams), `me` (`GET /api/me`), `orgId`, `org` (the `me.orgs`
entry), `el` (the page container), `set(markup)`, `poll(fn, ms)` (stops when the view is left, pauses
in hidden tabs), `onLeave(fn)`, `refresh()`, `alive()`.

## Rules

- **Escaping.** Build markup only with `html\`…\``; it escapes every value. `raw()` is for trusted
  constant markup only, never for API data. Use `p\`/api/orgs/${id}\`` for URLs with ids.
- **No inline styles.** The CSP is `style-src 'self'`, so `style="…"` attributes are blocked. Add
  classes to `app.css` (in the section for your module, prefixed by a comment naming the module),
  or set `el.style.width = …` from JavaScript (allowed) for computed values like meters.
- **Links.** Navigate with real `<a href="/o/…">` links; the router intercepts same-origin links to
  known routes. Use `navigate(path)` after actions. Links to instance hosts open normally
  (they leave the app; use `target="_blank"` only where the prototype did).
- **Errors and results.** Wrap button actions in `busy(button, fn)`: it disables the button and shows an error
  toast with `errorText(e)`. Handle the error codes the API documents for your routes with
  specific, plain-language messages (`e.code`, `e.status`, `e.body`), and report each result once,
  where the eyes are: see "Feedback" in [docs/ui.md](../docs/ui.md).
- **Protected actions.** Anything the API guards with MFA, a typed name, lock-out confirmation or
  an emailed confirmation goes through `protectedAction({ title, consequence, name, call })`. It
  asks for the typed name, does the passkey step-up on `mfa_required`, shows the affected members
  on `lock_out_confirmation_required`, and shows "check your email" on 202.
- **Hide what the API would refuse** (`ctx.org.role`, `ctx.me.platformRoles`,
  `ctx.me.session.mfa`), but never rely on hiding: the API checks everything.
- **Live status.** Poll instance views every 5 seconds while something is in progress
  (`creating`, `upgrading`, `deleting`, a running `op`), every 30 seconds otherwise.
- **Empty, loading and error states** for every list. Show only data we have (D63): no history
  charts, no invented numbers.
- **Copy.** Short, concrete, sentence case, no exclamation marks. Times through `relTime` /
  `dateTime`; counts through `plural`.
- **Phone width.** Every view must work at 390 px without sideways scrolling: wrap tables in
  `.tablewrap`, let grids collapse.
- **Prototypes.** The click-through prototypes show the intended layout and copy of each view:
  [docs/prototypes](../docs/prototypes) (`tenant.js`, `platform.js`, `base.js`, `base.css`; example data only).

## Tests

`npm run test:ui` runs `test/ui/*.test.mjs` with Playwright against the local stack (`npm run dev`).
`test/ui/lib.mjs` opens a page signed in as an e2e `Person` (`pageAs`), adds a virtual WebAuthn
authenticator (`addVirtualAuthenticator`), waits for a view (`settled`) and checks phone layouts
(`assertNoHorizontalScroll`). Every view module has a test file that covers its main paths and
asserts `assertNoErrors()`.
