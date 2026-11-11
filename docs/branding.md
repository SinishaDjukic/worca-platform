# Branding a deployment

A deployment shows its own names, links, logo and colours without changing the platform's code.
Everything here is optional: without it, pages and mail say "Worca" (the product being hosted),
use Worca's logo, and leave out the operator's lines and links.

## Names and links: `worca.config.ts`

```ts
branding: {
  productName: 'Worca',               // page titles, the logo's text alternative, mail logo alt
  serviceName: 'Worca hosted',        // page footers ("Worca hosted · What is this?"); default "<productName> hosted"
  operatorName: 'Example Hosting Ltd', // mail footers name it as the sender
  websiteUrl: 'https://example.com',
  aboutUrl: 'https://example.com/hosted/', // "What is this?"; default: websiteUrl, else the app
  contactEmail: 'hello@example.com',
  abuseEmail: 'abuse@example.com',    // default: contactEmail
  abuseUrl: 'https://example.com/abuse',
  privacyUrl: '…', termsUrl: '…', legalUrl: '…',
  mailLogoSize: { width: 148, height: 44 }, // the size mail shows branding/mail-logo-*.png at
}
```

They reach both Workers as wrangler `vars` (`PRODUCT_NAME`, `SERVICE_NAME`, `OPERATOR_NAME`, …,
`src/shared/config.ts` `wranglerVars`). Server-rendered pages, gate pages and mail read them through
`siteOf(env)` (`src/shared/site.ts`). The console reads them from `data-` attributes the control
Worker puts on the shell's `<body>` (`src/control/ui.ts` `brandShell`, `ui/assets/js/core.mjs`
`brand`), so nothing in `ui/` names a deployment's hosts or addresses.

## Logo, mark, favicon, mail logo, colours: `branding/`

Wrangler serves one assets directory per Worker, so a deployment's files can't be layered over the
package's `ui/` at request time. Instead the deployment builds its assets directory from both:

```
node node_modules/@worca/platform/scripts/brand-assets.mjs \
  --ui node_modules/@worca/platform/ui --branding branding --out .assets
```

and points `assets.directory` in `wrangler.control.jsonc` at `.assets` (the scaffolder sets this up
as the Worker's build step, so `wrangler dev` and `wrangler deploy` run it first). A deployment
without a `branding/` folder can point at the package's `ui/` directly.

| `branding/` file | Replaces | Used for |
|---|---|---|
| `logo-mask.png` | `assets/worca-logo-mask.png` | the wordmark in the console sidebar and on server-rendered pages: an alpha mask, coloured by the text colour |
| `mark-mask.png` | `assets/worca-mark-mask.png` | the small mark (alpha mask) |
| `favicon.png` | `assets/favicon.png` | the browser tab icon |
| `mail-logo-light.png`, `mail-logo-dark.png` | `assets/mail/worca-logo-*.png` | the logo in mail (set `mailLogoSize` if it isn't 148×44); the file names stay, because mail already sent links them |
| `theme.css` | `assets/theme.css` (empty) | colour overrides: loaded after `app.css` and `pages.css`; set the CSS variables from `app.css`, including its dark-mode blocks |

Any other file name is refused (except `README.md`), as is a `.png` that isn't a PNG. The output
folder is replaced on every build, but only if it is empty or was written by the script before.

## The gate's logo

The gate has no static files: its pages inline the logo so an instance's pages make no request to
another origin. A deployment passes its own to `definePlatform` in its gate entry module, as PNG
bytes (wrangler `Data` module rule) or a `data:image/png;base64,` URI:

```ts
import logo from '../branding/logo-mask.png';
definePlatform(config, { branding: { gateLogo: { mask: logo, aspect: '205/76' } } });
```

Keep it small: it is part of every gate page. Without it the gate shows Worca's.

## Not covered yet

Mail colours are fixed in `src/control/auth/mail-layout.ts`, and the gate pages' colours in
`src/gate/pages.ts`; `theme.css` changes the console and the server-rendered pages only. Text that
names "Worca support" or "hosted Worca" in the console and in mail is written for the product as a
hosted service and isn't configurable yet.

## The Worca name and logo

The platform's code is MIT-licensed. The Worca name, logo and mark are not covered by that licence
(see `NOTICE`). A deployment that offers its own service under another name should set
`productName` / `serviceName` and bring its own `branding/` files.
