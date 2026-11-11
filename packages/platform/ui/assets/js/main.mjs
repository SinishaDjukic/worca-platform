// Entry point: loads /api/me, registers every view module and renders the current route.
import { api, html, icon, loadMe, navigate, registerViews, render, setHtml, setShell, state, $, isStaff, passkeySignIn, errorText, alertBox, showAlert } from './core.mjs';
import { renderShell } from './shell.mjs';
import personal from './views/personal.mjs';
import account from './views/account.mjs';
import orgOverview from './views/org-overview.mjs';
import instances from './views/instances.mjs';
import people from './views/people.mjs';
import orgAdmin from './views/org-admin.mjs';
import platformCore from './views/platform-core.mjs';
import platformPeople from './views/platform-people.mjs';
import platformAccess from './views/platform-access.mjs';

/** Platform views need a platform role and a passkey session (D24). */
const platformGate = (views) =>
  views.map((v) => ({
    ...v,
    area: 'platform',
    guard: (ctx) => (!isStaff() ? '/' : v.guard ? v.guard(ctx) : null),
    render: async (ctx) => {
      if (!ctx.me.session.mfa) return renderPasskeyGate(ctx);
      return v.render(ctx);
    },
  }));
function renderPasskeyGate(ctx) {
  ctx.set(html`<div class="page narrow"><div class="card stack center">
    <span class="g violet lg">${icon('fingerprint')}</span>
    <h2>Sign in with your passkey</h2>
    <p class="ink2">The platform console needs a session signed in with a passkey. Your current session used another method.</p>
    ${alertBox('pk-err')}
    <div><button class="btn primary" id="pk-go">${icon('fingerprint')}Use passkey</button></div></div></div>`);
  $('#pk-go', ctx.el).addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      await passkeySignIn();
      ctx.refresh();
    } catch (err) {
      const el = $('#pk-err', ctx.el);
      if (!el) return;
      showAlert(el, errorText(err));
      $('#pk-go', ctx.el).disabled = false;
    }
  });
}
/** Org views: 404 page for orgs the person isn't in; tenant-admin-only views redirect to the org home. */
const orgGate = (views) =>
  views.map((v) => ({
    ...v,
    area: 'org',
    guard: (ctx) => {
      if (!ctx.org) return '/';
      if (v.adminOnly && ctx.org.role !== 'tenant_admin') return `/o/${encodeURIComponent(ctx.orgId)}`;
      return v.guard ? v.guard(ctx) : null;
    },
  }));

const notFound = {
  path: '*', title: 'Not found', area: 'personal',
  render: (ctx) => ctx.set(html`<div class="page"><div class="head"><div><h1>Page not found</h1><p>There's nothing at this address.</p></div></div><div><a class="btn" href="/">${icon('home')}Go home</a></div></div>`),
};

async function boot() {
  try {
    await loadMe();
  } catch (e) {
    setHtml($('#app'), html`<main class="main bare"><div class="page narrow"><div class="card stack center"><h2>Couldn't load your account</h2><p>${errorText(e)}</p><div><a class="btn" href="/">Try again</a></div></div></div></main>`);
    return;
  }
  setShell(renderShell);
  registerViews([
    ...personal,
    ...account,
    ...orgGate([...orgOverview, ...instances, ...people, ...orgAdmin]),
    ...platformGate([...platformCore, ...platformPeople, ...platformAccess]),
    notFound,
  ]);
  // Waitlist: a pending account sees only the waiting page (and account basics).
  if (state.me.user.status === 'pending' && !/^\/(pending|account)/.test(location.pathname)) {
    return navigate('/pending', { replace: true });
  }
  await render();
}
boot();
// Keep `api` reachable from the console for debugging during development.
window.__worca = { api, state };
