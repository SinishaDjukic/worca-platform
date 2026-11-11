// Account area: profile and sign-in methods (/account), signed-in devices (/account/sessions) and
// the person's own data: export and account deletion (/account/data). docs/ui.md "Account".
// APIs: /api/me (tenancy/me-routes.ts), Better Auth's passkey and account routes (auth/routes.ts).
import {
  api, html, icon, p, busy, toast, loadMe, plural, relTime, dateShort, dateTime, errorText, openModal, closeModal,
  passkeyRegister, protectedAction, ApiError, SIGN_IN_METHOD, $, $$, fieldError, features,
} from '../core.mjs';
import { repaintContext } from '../shell.mjs';

const PROVIDERS = { google: 'Google', microsoft: 'Microsoft' };
const ROLE_LABEL = { tenant_admin: 'Tenant admin', tenant_user: 'Tenant user' };
const roleLabel = (role) => String(role || '').split(',').map((r) => ROLE_LABEL[r.trim()] || r.trim()).join(', ');
const isAdminRole = (role) => String(role || '').split(',').map((r) => r.trim()).includes('tenant_admin');

/** The section links shown under each account page's heading (the sidebar is collapsed on phones). */
function tabs(active) {
  const items = [['account', '/account', 'Profile and sign-in'], ['sessions', '/account/sessions', 'Devices'], ['data', '/account/data', 'Your data']];
  return html`<nav class="seg acct-tabs" aria-label="Account sections">${items.map(([k, href, label]) =>
    html`<a href="${href}" class="${k === active ? 'on' : ''}"${k === active ? html` aria-current="page"` : ''}>${label}</a>`)}</nav>`;
}

const head = (title, sub, active) => html`<div class="head"><div><h1>${title}</h1><p>${sub}</p></div></div>${tabs(active)}`;

// ---- passkey helpers ------------------------------------------------------------------------------

/** Plain words for what the passkey routes and the browser's WebAuthn calls throw. */
function passkeyErrorText(e) {
  if (e instanceof ApiError) {
    if (e.code === 'SESSION_NOT_FRESH') return 'This needs a recent sign-in. Sign out, sign in again, then try once more.';
    if (e.code === 'PASSKEY_NOT_FOUND') return 'That passkey no longer exists. The list was refreshed.';
    if (e.code === 'CHALLENGE_NOT_FOUND') return 'The passkey request expired. Try again.';
    if (e.code === 'FAILED_TO_VERIFY_REGISTRATION') return "The passkey couldn't be verified. Try again, or use another device.";
    return errorText(e);
  }
  if (e && e.name === 'NotAllowedError') return 'The passkey prompt was cancelled or timed out.';
  if (e && e.name === 'InvalidStateError') return 'This device already holds a passkey for your account.';
  if (e && e.name === 'SecurityError') return "This browser won't create a passkey for this site.";
  return errorText(e);
}

/**
 * Runs a passkey change through protectedAction: Better Auth refuses changes from a session that
 * didn't sign in with a passkey once the account has one (mfa_required, D24), and protectedAction
 * then asks for a passkey sign-in and retries.
 */
async function passkeyChange(title, fn) {
  try {
    return await protectedAction({ title, typed: false, call: async () => ({ status: 200, body: await fn() }) });
  } catch (e) {
    toast(passkeyErrorText(e), 'error');
    return null;
  }
}

function passkeyRow(pk) {
  const synced = pk.backedUp || pk.deviceType === 'multiDevice';
  const used = pk.lastUsedAt ? `last used ${relTime(pk.lastUsedAt)}` : 'not used yet';
  return html`<div class="row" data-passkey="${pk.id}">
    ${icon(synced ? 'fingerprint' : 'key')}
    <div class="t"><b>${pk.name || 'Unnamed passkey'}</b><span>${synced ? 'Synced passkey' : 'Device-bound passkey'} · added ${dateShort(pk.createdAt)} · ${used}</span></div>
    <div class="r"><button class="btn sm ghost" data-rename="${pk.id}" aria-label="Rename ${pk.name || 'passkey'}">Rename</button><button class="btn sm ghost" data-remove="${pk.id}" aria-label="Remove ${pk.name || 'passkey'}">Remove</button></div>
  </div>`;
}

/** A default name for a new passkey: the browser and OS, like the devices list. */
function deviceName() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** Asks for a passkey name; resolves the trimmed name or null. */
function askPasskeyName({ title, text, value, action }) {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal(html`<h2>${title}</h2>${text ? html`<p>${text}</p>` : ''}
      <form class="form" id="pkn-form">
        <div class="field"><label for="pkn-name">Name</label><input class="inp" id="pkn-name" maxlength="64" autocomplete="off" value="${value || ''}"><span class="hint">So you can tell your passkeys apart, for example "Work laptop".</span></div>
        <div class="acts"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" id="pkn-go">${action}</button></div>
      </form>`, { onClose: () => { if (!answered) resolve(null); } });
    const inp = $('#pkn-name', m), go = $('#pkn-go', m);
    inp.select();
    const sync = () => { go.disabled = !inp.value.trim(); };
    inp.addEventListener('input', sync);
    sync();
    $('#pkn-form', m).addEventListener('submit', (e) => {
      e.preventDefault();
      if (!inp.value.trim()) return;
      answered = true;
      closeModal();
      resolve(inp.value.trim());
    });
  });
}

/** Simple yes/no dialog; resolves true when confirmed. */
function confirmDialog({ title, body, action, danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal(html`<h2 class="${danger ? 'danger' : ''}">${title}</h2>${body}
      <div class="acts"><button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cf-go">${action}</button></div>`,
    { onClose: () => { if (!answered) resolve(false); } });
    $('#cf-go', m).addEventListener('click', () => { answered = true; closeModal(); resolve(true); });
  });
}

// ---- linked accounts ------------------------------------------------------------------------------

const LINK_ERRORS = {
  email_does_not_match: 'That account uses a different email address. Link an account with the same email as your Worca account.',
  "email_doesn't_match": 'That account uses a different email address. Link an account with the same email as your Worca account.',
  account_already_linked_to_different_user: 'That account is already linked to another Worca account.',
  email_not_verified: "That account's email address isn't verified with the provider, so it can't be linked.",
  unable_to_link_account: "The account couldn't be linked. Try again.",
  access_denied: 'Linking was cancelled.',
};

function linkedRows(me, accounts) {
  const available = new Set(me.signIn.available || []);
  const out = [];
  for (const id of ['google', 'microsoft']) {
    const acc = accounts.find((a) => a.providerId === id);
    if (acc) {
      out.push(html`<div class="row" data-provider="${id}">${icon('globe')}<div class="t"><b>${PROVIDERS[id]}</b><span>Linked ${dateShort(acc.createdAt)}</span></div>
        <div class="r"><button class="btn sm ghost" data-unlink="${acc.id}" data-name="${PROVIDERS[id]}">Unlink</button></div></div>`);
    } else if (available.has(id)) {
      out.push(html`<div class="row" data-provider="${id}">${icon('globe')}<div class="t"><b>${PROVIDERS[id]}</b><span>Not linked</span></div>
        <div class="r"><button class="btn sm" data-link="${id}">Link</button></div></div>`);
    }
  }
  if (accounts.some((a) => a.providerId !== 'google' && a.providerId !== 'microsoft' && a.providerId !== 'credential')) {
    out.push(html`<div class="row" data-provider="sso">${icon('building')}<div class="t"><b>${SIGN_IN_METHOD.sso}</b><span>Through your org's identity provider</span></div></div>`);
  }
  return out;
}

// ---- newsletter (D70) -----------------------------------------------------------------------------

const NL_RELEASES = [
  ['major', 'Major releases', 'Only the big ones'],
  ['minor', 'Major and minor releases', 'New features; the usual choice'],
  ['micro', 'Every stable release', 'Patches and fixes too'],
  ['rc', 'Everything', 'Release candidates too, for testing ahead'],
  ['none', 'No release mail', ''],
];

function newsletterNote(nl) {
  if (nl.status === 'suppressed') return 'Mail to your address bounced or was reported as spam, so nothing is sent. Subscribing here turns it back on.';
  if (nl.status === 'unsubscribed') return 'You unsubscribed. Choose what you want and subscribe again.';
  if (nl.status === 'unconfirmed') return 'A confirmation mail is waiting in your inbox. Subscribing here confirms it at once.';
  return '';
}

function newsletterCard(nl, email) {
  if (nl === null) {
    return html`<section class="card" aria-labelledby="acct-news"><div class="card-head"><h2 id="acct-news">Newsletter</h2></div>
      <div class="rows"><div class="empty">Couldn't load your newsletter settings. <button class="linkbtn" id="nl-retry">Try again</button></div></div></section>`;
  }
  const note = newsletterNote(nl);
  return html`<section class="card" aria-labelledby="acct-news">
    <div class="card-head"><h2 id="acct-news">Newsletter</h2>${nl.subscribed ? html`<span class="pill green" id="nl-state">Subscribed</span>` : html`<span class="pill slate" id="nl-state">Not subscribed</span>`}</div>
    ${note ? html`<div class="banner amber">${icon('alert')}<div class="grow">${note}</div></div>` : ''}
    <form class="form" id="nl-form">
      <div class="field"><span class="label" id="nl-rel">Release mail</span>
        <div class="checks" role="radiogroup" aria-labelledby="nl-rel">${NL_RELEASES.map(([v, label, sub]) =>
          html`<label class="check"><input type="radio" name="nl-releases" value="${v}" ${nl.releases === v ? 'checked' : ''}><span class="t"><b>${label}</b>${sub ? html`<span>${sub}</span>` : ''}</span></label>`)}</div></div>
      <div class="checks"><label class="check"><input type="checkbox" id="nl-product" ${nl.product ? 'checked' : ''}><span class="t"><b>Product news</b><span>Now and then: what's new in Worca and Worca hosted</span></span></label></div>
      <div class="acct-actions">
        ${nl.subscribed ? html`<button type="button" class="btn ghost" id="nl-off">Unsubscribe</button>` : ''}
        <button type="submit" class="btn primary" id="nl-save">${nl.subscribed ? 'Save' : 'Subscribe'}</button>
      </div>
    </form>
    <div class="hint acct-note">Sent to ${email}. Every mail has a link to change this or unsubscribe.</div>
  </section>`;
}

function bindNewsletter(ctx) {
  $('#nl-retry', ctx.el)?.addEventListener('click', () => ctx.refresh());
  const form = $('#nl-form', ctx.el);
  if (!form) return;
  const save = (body, done) => api.put('/api/me/newsletter', body).then((res) => { toast(done(res)); ctx.refresh(); });
  const subscribed = !!$('#nl-off', form);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const releases = $('input[name="nl-releases"]:checked', form)?.value || 'none';
    const product = $('#nl-product', form).checked;
    if (releases === 'none' && !product) return void fieldError([...$$('input[name="nl-releases"]', form), $('#nl-product', form)], 'Choose something to receive, or unsubscribe.');
    // Subscribed: a plain save, reported on the button. Subscribing changes the card: a toast says so.
    if (subscribed) busy($('#nl-save', form), () => api.put('/api/me/newsletter', { releases, product }), { done: 'Saved' });
    else busy($('#nl-save', form), () => save({ releases, product }, () => 'Subscribed to the newsletter'));
  });
  $('#nl-off', form)?.addEventListener('click', (e) => busy(e.currentTarget, () => save({ releases: 'none', product: false }, () => 'Unsubscribed from the newsletter')));
}

// ---- /account -------------------------------------------------------------------------------------

async function renderAccount(ctx) {
  const [{ passkeys }, accounts, newsletter] = await Promise.all([
    api.get('/api/me/passkeys'),
    api.get('/api/auth/list-accounts').catch(() => null),
    features.newsletter ? api.get('/api/me/newsletter').catch(() => null) : null,
  ]);
  if (!ctx.alive()) return;
  const me = ctx.me;
  const needsPasskeySession = passkeys.length > 0 && !me.session.mfa;
  const linked = accounts ? linkedRows(me, accounts) : null;
  const linkError = ctx.query.get('error');
  const justLinked = ctx.query.get('linked');

  ctx.set(html`<div class="page narrow acct">
    ${head('Account', me.user.email, 'account')}
    ${linkError ? html`<div class="banner amber" role="alert">${icon('alert')}<div class="grow">${LINK_ERRORS[linkError] || "The account couldn't be linked. Try again."}</div></div>` : ''}

    <section class="card" aria-labelledby="acct-profile">
      <div class="card-head"><h2 id="acct-profile">Profile</h2></div>
      <form class="form" id="profile-form">
        <div class="field"><label for="p-name">Name</label><input class="inp" id="p-name" maxlength="100" autocomplete="name" value="${me.user.name || ''}" required></div>
        <div class="field"><label for="p-mail">Email</label><input class="inp" id="p-mail" value="${me.user.email}" disabled>
          <span class="hint">Your email identifies you in every org; it can't be changed here.</span></div>
        <div class="acct-actions"><button type="submit" class="btn primary" id="p-save" disabled>Save</button></div>
      </form>
    </section>

    <section class="card" aria-labelledby="acct-passkeys">
      <div class="card-head"><h2 id="acct-passkeys">Passkeys</h2><button class="btn sm" id="pk-add">${icon('plus')}Add passkey</button></div>
      ${passkeys.length
        ? html`<div class="rows" id="pk-list">${passkeys.map(passkeyRow)}</div>`
        : html`<div class="rows" id="pk-list"><div class="empty">No passkeys yet. A passkey signs you in with your face, fingerprint or a security key, without a code.</div></div>`}
      <div class="hint acct-note">A passkey also counts as your second factor for admin actions.${needsPasskeySession ? ' This session signed in another way, so changing passkeys asks for one of them first.' : ''}</div>
    </section>

    <section class="card" aria-labelledby="acct-linked">
      <div class="card-head"><h2 id="acct-linked">Linked accounts</h2></div>
      ${linked === null
        ? html`<div class="rows"><div class="empty">Couldn't load your linked accounts. <button class="linkbtn" id="ln-retry">Try again</button></div></div>`
        : linked.length
          ? html`<div class="rows" id="ln-list">${linked}</div>`
          : html`<div class="rows" id="ln-list"><div class="empty">Google and Microsoft sign-in aren't available here.</div></div>`}
      <div class="hint acct-note">You can always sign in with a code sent to ${me.user.email}.</div>
    </section>

    ${features.newsletter ? newsletterCard(newsletter, me.user.email) : ''}
  </div>`);

  if (justLinked && PROVIDERS[justLinked]) toast(`${PROVIDERS[justLinked]} linked`);
  if (linkError || justLinked) history.replaceState(null, '', '/account');

  // Profile
  const form = $('#profile-form', ctx.el), nameInp = $('#p-name', ctx.el), save = $('#p-save', ctx.el);
  let original = me.user.name || '';
  nameInp.addEventListener('input', () => { save.disabled = !nameInp.value.trim() || nameInp.value.trim() === original; });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInp.value.trim();
    if (!name || name === original) return;
    busy(save, async () => {
      await api.patch('/api/me', { name });
      original = name;
      await loadMe();
      repaintContext(); // the sidebar shows the name too
    }, { done: 'Saved', idleDisabled: () => !nameInp.value.trim() || nameInp.value.trim() === original });
  });

  // Passkeys
  $('#pk-add', ctx.el).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const name = await askPasskeyName({ title: 'Add a passkey', text: 'Your browser asks you to confirm with your face, fingerprint, screen lock or a security key.', value: deviceName(), action: 'Continue' });
    if (!name) return;
    btn.disabled = true;
    const res = await passkeyChange('Adding a passkey', () => passkeyRegister(name));
    if (btn.isConnected) btn.disabled = false;
    if (!res) return;
    await loadMe().catch(() => {});
    toast('Passkey added');
    ctx.refresh();
  });
  for (const b of $$('[data-rename]', ctx.el)) {
    b.addEventListener('click', async () => {
      const pk = passkeys.find((x) => x.id === b.dataset.rename);
      const name = await askPasskeyName({ title: 'Rename passkey', value: pk?.name || '', action: 'Save' });
      if (!name || name === pk?.name) return;
      const res = await passkeyChange('Renaming a passkey', () => api.post('/api/auth/passkey/update-passkey', { id: b.dataset.rename, name }));
      if (!res) return ctx.refresh();
      toast('Passkey renamed');
      ctx.refresh();
    });
  }
  for (const b of $$('[data-remove]', ctx.el)) {
    b.addEventListener('click', async () => {
      const pk = passkeys.find((x) => x.id === b.dataset.remove);
      const last = passkeys.length === 1;
      const ok = await confirmDialog({
        title: 'Remove passkey',
        danger: true,
        action: 'Remove passkey',
        body: html`<p>${pk?.name || 'This passkey'} will no longer sign you in. Remove it from the device too, in its password or passkey settings.</p>
          ${last ? html`<div class="banner amber">${icon('alert')}<div class="grow"><b>This is your only passkey.</b> Without one you sign in with an email code only, and you can't use the platform console or approve admin actions that need a passkey until you add a new one.</div></div>` : ''}`,
      });
      if (!ok) return;
      const res = await passkeyChange('Removing a passkey', () => api.post('/api/auth/passkey/delete-passkey', { id: b.dataset.remove }));
      if (!res) return ctx.refresh();
      await loadMe().catch(() => {});
      toast('Passkey removed');
      ctx.refresh();
    });
  }

  bindNewsletter(ctx);

  // Linked accounts
  $('#ln-retry', ctx.el)?.addEventListener('click', () => ctx.refresh());
  for (const b of $$('[data-link]', ctx.el)) {
    b.addEventListener('click', () => busy(b, async () => {
      const provider = b.dataset.link;
      const res = await api.post('/api/auth/link-social', {
        provider, callbackURL: `/account?linked=${provider}`, errorCallbackURL: '/account', disableRedirect: true,
      });
      if (!res.url) throw new Error("Couldn't start linking. Try again.");
      location.assign(res.url); // the provider's sign-in page; it comes back to /account
    }));
  }
  for (const b of $$('[data-unlink]', ctx.el)) {
    b.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: `Unlink ${b.dataset.name}`,
        action: 'Unlink',
        body: html`<p>You won't be able to sign in with ${b.dataset.name} any more. Sessions it already started stay signed in; end them under Devices. You can link it again later.</p>`,
      });
      if (!ok) return;
      busy(b, async () => {
        try {
          await api.post('/api/auth/unlink-account', { accountId: b.dataset.unlink });
        } catch (e) {
          if (e instanceof ApiError && e.code === 'SESSION_NOT_FRESH') throw new Error('Unlinking needs a sign-in from the last 24 hours. Sign out, sign in again, then try once more.');
          if (e instanceof ApiError && e.code === 'ACCOUNT_NOT_FOUND') { ctx.refresh(); throw new Error('That account is no longer linked.'); }
          throw e;
        }
        await loadMe().catch(() => {});
        toast(`${b.dataset.name} unlinked`);
        ctx.refresh();
      });
    });
  }
}

// ---- /account/sessions ----------------------------------------------------------------------------

function sessionRow(s) {
  const method = SIGN_IN_METHOD[s.method] || s.method;
  const factor = s.mfa && s.method !== 'passkey' ? ' · second factor' : '';
  return html`<div class="row" data-session="${s.current ? 'current' : 'other'}">
    <span class="g ${s.current ? 'green' : 'slate'}">${icon('laptop')}</span>
    <div class="t"><b>${s.device}${s.current ? ' · this device' : ''}</b>
      <span>${method}${factor} · signed in ${dateShort(s.createdAt)} · ${s.current ? 'active now' : html`active <time datetime="${s.lastActiveAt}" title="${dateTime(s.lastActiveAt)}">${relTime(s.lastActiveAt)}</time>`}</span></div>
    <div class="r">${s.current ? html`<span class="pill green">This one</span>` : html`<button class="btn sm ghost" data-signout="${s.handle}" aria-label="Sign out ${s.device}">Sign out</button>`}</div>
  </div>`;
}

async function renderSessions(ctx) {
  const { sessions } = await api.get('/api/me/sessions');
  if (!ctx.alive()) return;
  const others = sessions.filter((s) => !s.current);
  ctx.set(html`<div class="page narrow acct">
    ${head('Devices', "Where you're signed in. Signing a device out also closes its open instance tabs within a minute.", 'sessions')}
    <section class="card" aria-labelledby="ss-h">
      <div class="card-head"><h2 id="ss-h">Signed-in devices</h2>${others.length ? html`<button class="btn sm" id="ss-others">Sign out all others</button>` : ''}</div>
      ${sessions.length
        ? html`<div class="rows" id="ss-list">${sessions.map(sessionRow)}</div>`
        : html`<div class="rows"><div class="empty">No active sessions.</div></div>`}
      <div class="hint acct-note">${others.length ? `${plural(sessions.length, 'device')} signed in.` : 'Only this device is signed in.'} Locations are never recorded.</div>
    </section>
  </div>`);

  for (const b of $$('[data-signout]', ctx.el)) {
    b.addEventListener('click', () => busy(b, async () => {
      try {
        await api.del(p`/api/me/sessions/${b.dataset.signout}`);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'session_not_found') { ctx.refresh(); throw new Error('That session had already ended, or this list was out of date. It is up to date now.'); }
        if (e instanceof ApiError && e.code === 'current_session') throw new Error("That's this device. Use Sign out in the menu instead.");
        throw e;
      }
      toast('Signed out');
      ctx.refresh();
    }));
  }
  $('#ss-others', ctx.el)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const ok = await confirmDialog({
      title: 'Sign out all other devices',
      action: 'Sign out others',
      body: html`<p>${plural(others.length, 'other device')} will be signed out, and their open instance tabs stop within a minute. This device stays signed in.</p>`,
    });
    if (!ok) return;
    busy(btn, async () => {
      const res = await api.post('/api/me/sessions/revoke-others');
      toast(res.revoked ? `Signed out ${plural(res.revoked, 'other device')}` : 'No other devices were signed in');
      ctx.refresh();
    });
  });
}

// ---- /account/data --------------------------------------------------------------------------------

/** GET /api/me/export as a file download (fetch → Blob → object URL). */
async function downloadExport() {
  let res;
  try {
    res = await fetch('/api/me/export', { credentials: 'same-origin', headers: { accept: 'application/json' } });
  } catch {
    throw new ApiError(0, 'network');
  }
  if (!res.ok) {
    let body = {};
    try { body = await res.json(); } catch { /* empty */ }
    throw new ApiError(res.status, body.error, body);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'worca-account-export.json';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function showDeleteRefusal(ctx, code) {
  const adminOrgs = (ctx.me.orgs || []).filter((o) => isAdminRole(o.role));
  const body = code === 'last_superadmin'
    ? html`<p>You're the only superadmin of the platform. Make someone else a superadmin first, under Platform roles.</p>`
    : html`<p>You're the last admin of an org, and an org can't be left without one. Make someone else an admin of it, or delete the org, first.</p>
      ${adminOrgs.length ? html`<div class="label">Orgs you administer</div><div class="rows">${adminOrgs.map((o) => html`<a class="row click" href="${p`/o/${o.id}/members`}"><span class="av">${icon('building')}</span><div class="t"><b>${o.name || 'Unnamed org'}</b><span>${roleLabel(o.role)} · open its members</span></div><div class="r">${icon('chev')}</div></a>`)}</div>` : ''}`;
  const m = openModal(html`<h2>Your account can't be deleted yet</h2>${body}<div class="acts"><button class="btn primary" data-close>OK</button></div>`);
  for (const a of $$('a', m)) a.addEventListener('click', () => closeModal());
}

async function renderData(ctx) {
  const me = ctx.me;
  const providers = (me.signIn.providers || []).map((x) => SIGN_IN_METHOD[x] || x);
  const orgs = me.orgs || [];
  ctx.set(html`<div class="page narrow acct">
    ${head('Your data', 'What Worca holds about you, a copy to download, and deleting your account.', 'data')}
    <section class="card" aria-labelledby="dt-h">
      <div class="card-head"><h2 id="dt-h">What we hold</h2></div>
      <dl class="kv">
        <dt>Profile</dt><dd>${me.user.name || 'No name'} · ${me.user.email}<span class="muted"> · encrypted at rest</span></dd>
        <dt>Sign-in</dt><dd>Email code${me.signIn.passkeys ? `, ${plural(me.signIn.passkeys, 'passkey')}` : ''}${providers.length ? `, ${providers.join(', ')}` : ''}</dd>
        <dt>Orgs</dt><dd>${orgs.length ? orgs.map((o, i) => html`${i ? ', ' : ''}${o.name || 'Unnamed org'} <span class="muted">(${roleLabel(o.role)})</span>`) : 'None'}</dd>
        <dt>Activity</dt><dd>Your entries in the platform and org audit logs, kept for 30 days</dd>
      </dl>
      <div class="between acct-export"><span class="ink2">Everything above, with your team memberships and audit entries, as one JSON file.</span>
        <button class="btn" id="dt-export">${icon('download')}Download</button></div>
    </section>
    <section class="card danger-zone" aria-labelledby="del-h">
      <div class="card-head"><h2 id="del-h">Delete your account</h2></div>
      <div class="between"><span class="ink2 acct-measure">Removes you from every org and deletes your profile, passkeys and sessions for good. You can't delete it while you're the last admin of an org. We email you a link to confirm.</span>
        <button class="btn danger" id="del-me">${icon('trash')}Delete account</button></div>
    </section>
  </div>`);

  $('#dt-export', ctx.el).addEventListener('click', (e) => busy(e.currentTarget, async () => {
    await downloadExport();
    toast('Export downloaded');
  }));
  $('#del-me', ctx.el).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await protectedAction({
        title: 'Delete account',
        consequence: html`Your profile, passkeys, sessions and org memberships are deleted for good, and you lose access to every instance. After this step we email you a link; nothing happens until you open it and confirm.`,
        name: me.user.email,
        nameLabel: 'your email',
        actionLabel: 'Delete account',
        call: (typed) => api.raw('DELETE', '/api/me', { confirmName: typed }),
      });
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'last_tenant_admin' || err.code === 'last_superadmin')) showDeleteRefusal(ctx, err.code);
      else if (err instanceof ApiError && err.code === 'confirm_name_mismatch') toast("The email didn't match. Type it exactly.", 'error');
      else toast(errorText(err), 'error');
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  });
}

export default [
  { path: '/account', area: 'personal', nav: 'account', title: 'Account', render: renderAccount },
  { path: '/account/sessions', area: 'personal', nav: 'sessions', title: 'Devices', render: renderSessions },
  { path: '/account/data', area: 'personal', nav: 'data', title: 'Your data', render: renderData },
];
