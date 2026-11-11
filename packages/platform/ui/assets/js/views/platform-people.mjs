// Platform console, people and system: Registration (mode, codes, waitlist), Users and support
// (exact-email lookup, sign-out, disable, enable, the two-person sign-in reset), the platform
// Audit log, Platform roles and System (mail, providers, keys, master-key rotation).
// docs/ui.md "Platform console"; API in docs/internal-apis.md (platform console, users and support).
// main.mjs adds the staff guard and the passkey gate; the capabilities below only hide what the
// API would refuse anyway.
import {
  api, html, icon, p, busy, toast, navigate, initials, plural, relTime, dateShort, dateTime, errorText,
  openModal, closeModal, copyText, protectedAction, hasRole, setHtml, state, ApiError, SIGN_IN_METHOD, $, $$,
  fieldError, clearFieldErrors, alertBox, showAlert, features,
} from '../core.mjs';

// ---- roles and capabilities (src/control/tenancy/roles.ts) ------------------------------------

const ROLE_LABEL = { support: 'Support', admin: 'Admin', superadmin: 'Superadmin' };
const RANK = { support: 1, admin: 2, superadmin: 3 };
const CAPS = {
  'platform.view': ['support', 'admin', 'superadmin'],
  'audit.view': ['admin', 'superadmin'],
  'registration.codes': ['admin', 'superadmin'],
  'waitlist.manage': ['admin', 'superadmin'],
  'users.support': ['admin', 'superadmin'],
  'system.settings': ['superadmin'],
  'roles.manage': ['superadmin'],
  'keys.master': ['superadmin'],
};
const can = (cap) => hasRole(...CAPS[cap]);
const rankOf = (roles) => Math.max(0, ...(roles || []).map((r) => RANK[r] || 0));
const strongest = (roles) => ['superadmin', 'admin', 'support'].find((r) => (roles || []).includes(r)) || null;
const rolePill = (role) => html`<span class="pill ${role === 'superadmin' ? 'violet' : role === 'admin' ? 'blue' : 'line'}">${ROLE_LABEL[role] || role}</span>`;
/** A guard: views that need a capability send other staff to the console overview. */
const needs = (cap) => () => (can(cap) ? null : '/platform');

// ---- errors -------------------------------------------------------------------------------------

/** Plain-language text for every error code these routes document. */
const ERR = {
  exact_email_required: "Enter the full email address. Partial matches aren't possible.",
  user_not_found: 'No account with that address.',
  cannot_disable_self: "You can't disable your own account.",
  user_pending: 'This account is waiting for approval. Approve or reject it under Registration instead.',
  last_superadmin: "This is the last superadmin. Make someone else superadmin first.",
  not_disabled: 'The account is not disabled.',
  target_outranks_you: 'They hold a platform role at or above yours. Only someone ranked higher can do this.',
  disabler_outranks_you: 'A higher-ranked staff member disabled this account. Only someone of that rank can enable it.',
  request_already_open: 'A sign-in reset for this account is already waiting for approval.',
  cannot_reset_self: "You can't reset your own sign-in. Ask another staff member.",
  second_person_required: 'You asked for this reset, so a different staff member has to approve it.',
  cannot_approve_own_reset: 'This reset is for your own account. Someone else has to approve it.',
  not_open: 'This request was already handled.',
  requester_not_staff: 'Whoever asked for this reset is no longer staff. Start a new request if it is still needed.',
  requester_outranked: 'Whoever asked for this reset no longer ranks above the person. Start a new request.',
  expired: 'The request expired after 24 hours. Start a new one if it is still needed.',
  passkey_required: 'Approving needs a session signed in with a passkey.',
  cannot_change_own_roles: "You can't change your own platform roles. Ask another superadmin.",
  unknown_tier: "That plan doesn't exist.",
  invalid_query: 'One of the filters is not valid.',
  not_found: 'Not found. Someone may have handled it already.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
};
const say = (e) => (e instanceof ApiError && ERR[e.code]) || errorText(e);
/** busy() with this module's error texts. */
async function run(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(say(e), 'error');
    return undefined;
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
}

// ---- small helpers ----------------------------------------------------------------------------

const shortId = (id) => (id ? String(id).slice(0, 8) : '—');
const meId = () => state.me?.user?.id;
/** Sets the widths of meters rendered with data-w (no inline styles under the CSP). */
function meters(root) {
  for (const el of $$('[data-w]', root)) el.style.width = `${Math.max(0, Math.min(100, Number(el.dataset.w) || 0))}%`;
}
/** A yes/no dialog. Resolves true when confirmed. */
function confirmDialog({ title, body, action, danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal(html`<h2 class="${danger ? 'danger' : ''}">${title}</h2>${body}
      <div class="acts"><button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="pp-yes">${action}</button></div>`,
    { onClose: () => { if (!answered) resolve(false); } });
    $('#pp-yes', m).addEventListener('click', () => { answered = true; closeModal(); resolve(true); });
    $('#pp-yes', m).focus();
  });
}
/** Staff names by user id, for "who" columns. Only superadmins can list roles. */
async function staffNames() {
  const names = new Map();
  if (state.me?.user) names.set(meId(), state.me.user.name || state.me.user.email);
  if (!can('roles.manage')) return names;
  try {
    const { bindings } = await api.get('/api/platform/roles');
    for (const b of bindings) names.set(b.userId, b.name || b.email || shortId(b.userId));
  } catch { /* names are a convenience */ }
  return names;
}
const who = (id, names) => (!id ? 'System' : id === meId() ? 'You' : names.get(id) || shortId(id));

// ---- Registration ---------------------------------------------------------------------------

const MODES = {
  invite_code: { label: 'Invite code', line: 'Only people with a registration code can sign up.' },
  waitlist: { label: 'Waitlist', line: 'Anyone can sign up and waits for approval; a code skips the wait.' },
  open: { label: 'Open', line: 'Anyone with a verified email address gets an account.' },
};
const codeLive = (c) => c.usesLeft > 0 && (!c.expiresAt || c.expiresAt > Date.now());

function codeRow(c) {
  const used = (c.usesTotal ?? c.usesLeft) - c.usesLeft;
  const expired = c.expiresAt && c.expiresAt <= Date.now();
  const state_ = codeLive(c) ? '' : expired ? html` <span class="pill slate">Expired</span>` : html` <span class="pill slate">Used up</span>`;
  return html`<tr data-code="${c.id}">
    <td><div class="pp-cell"><b>${c.note || html`<span class="muted">No note</span>`}</b>${state_}</div><div class="mono muted pp-small">${c.id.slice(0, 12)}</div></td>
    ${features.tiers ? html`<td>${c.tier}</td>` : ''}
    <td class="mono">${used} / ${c.usesTotal ?? '—'}</td>
    <td class="muted">${c.expiresAt ? dateShort(c.expiresAt) : 'Never'}</td>
    <td class="muted">${relTime(c.createdAt)}</td>
    <td class="pp-acts"><button class="btn sm ghost" data-revoke="${c.id}" aria-label="Revoke code ${c.note || c.id.slice(0, 12)}">Revoke</button></td></tr>`;
}

function waitRow(w) {
  const label = w.name || w.email || shortId(w.id);
  return html`<tr data-pending="${w.id}">
    <td><div class="who"><span class="av">${initials(w.name || w.email)}</span><div class="t"><b>${w.name || html`<span class="muted">No name</span>`}</b><span class="mono">${w.email || shortId(w.id)}</span></div></div></td>
    <td class="muted">${relTime(w.createdAt)}</td>
    <td>${w.emailVerified ? html`<span class="pill green">Verified</span>` : html`<span class="pill slate">Not verified</span>`}</td>
    <td class="pp-acts"><button class="btn sm" data-approve="${w.id}" aria-label="Approve ${label}">${icon('check')}Approve</button><button class="btn sm ghost" data-reject="${w.id}" aria-label="Reject ${label}">Reject</button></td></tr>`;
}

async function renderRegistration(ctx) {
  const tab = ctx.query.get('tab') === 'waitlist' && can('waitlist.manage') ? 'waitlist' : 'codes';
  const showAll = ctx.query.get('all') === '1';
  const [reg, codesRes, waitRes, tiersRes] = await Promise.all([
    api.get('/api/platform/registration'),
    can('registration.codes') ? api.get('/api/platform/registration/codes') : { codes: [] },
    can('waitlist.manage') ? api.get('/api/platform/waitlist') : { pending: [] },
    features.tiers ? api.get('/api/platform/tiers').catch(() => ({ tiers: [] })) : { tiers: [] },
  ]);
  if (!ctx.alive()) return;
  const mode = MODES[reg.mode] ? reg.mode : 'invite_code';
  const sa = can('system.settings');
  const codes = codesRes.codes || [];
  const live = codes.filter(codeLive);
  const shown = showAll ? codes : live;
  const pending = waitRes.pending || [];
  const tiers = tiersRes.tiers || [];
  const tierName = (id) => tiers.find((t) => t.id === id)?.name || id;
  const tabHref = (t, all) => `/platform/registration${t === 'waitlist' ? '?tab=waitlist' : all ? '?all=1' : ''}`;

  const codesTable = shown.length
    ? html`<div class="tablewrap"><table><thead><tr><th>Note</th>${features.tiers ? html`<th>Plan</th>` : ''}<th>Used</th><th>Expires</th><th>Created</th><th><span class="pp-sr">Actions</span></th></tr></thead>
      <tbody>${shown.map((c) => codeRow({ ...c, tier: tierName(c.tier) }))}</tbody></table></div>`
    : html`<div class="empty">${codes.length ? 'No codes can be used right now. Every code is used up or expired.' : 'No registration codes yet.'}</div>`;
  const waitTable = pending.length
    ? html`<div class="tablewrap"><table><thead><tr><th>Person</th><th>Signed up</th><th>Address</th><th><span class="pp-sr">Actions</span></th></tr></thead>
      <tbody>${pending.map(waitRow)}</tbody></table></div>`
    : html`<div class="empty">Nobody is waiting.${mode !== 'waitlist' ? ' New sign-ups only wait when the mode is Waitlist.' : ''}</div>`;

  ctx.set(html`<div class="page">
    <div class="head"><div><h1>Registration</h1><p>Who can create an account. Invitations into an existing org don't need any of this.</p></div>
      <div class="acts">${can('registration.codes') && tab === 'codes' ? html`<button class="btn primary" id="new-code">${icon('plus')}New code</button>` : ''}</div></div>
    <div class="card"><div class="between"><div><b>Sign-up mode</b><div class="ink2 pp-small" id="mode-line">${MODES[mode].line}</div></div>
      <div class="seg" role="group" aria-label="Sign-up mode">${Object.entries(MODES).map(([k, m]) => html`<button type="button" class="${k === mode ? 'on' : ''}" data-mode="${k}" aria-pressed="${k === mode ? 'true' : 'false'}" ${sa ? '' : 'disabled'}>${m.label}</button>`)}</div></div>
      ${sa ? '' : html`<p class="hint pp-gap">Only a superadmin can change the mode.</p>`}</div>
    ${can('waitlist.manage') || can('registration.codes') ? html`<div class="between">
      <div class="seg" role="group" aria-label="Show">
        ${can('registration.codes') ? html`<button type="button" class="${tab === 'codes' ? 'on' : ''}" data-tab="${tabHref('codes', showAll)}" aria-pressed="${tab === 'codes' ? 'true' : 'false'}">Codes · ${live.length}</button>` : ''}
        ${can('waitlist.manage') ? html`<button type="button" class="${tab === 'waitlist' ? 'on' : ''}" data-tab="${tabHref('waitlist')}" aria-pressed="${tab === 'waitlist' ? 'true' : 'false'}">Waiting · ${pending.length}</button>` : ''}</div>
      ${tab === 'codes' && codes.length > live.length ? html`<a class="linkbtn" href="${tabHref('codes', !showAll)}">${showAll ? 'Only usable codes' : `Show used and expired (${codes.length - live.length})`}</a>` : ''}</div>
    <div class="card pp-tablecard">${tab === 'codes' ? codesTable : waitTable}</div>
    ${tab === 'codes' ? html`<p class="hint">Codes are stored only as a hash, so a code can't be shown again after it is created. The note helps you tell them apart.</p>` : html`<p class="hint">Approving mails the person that their account is ready; rejecting deletes the account.</p>`}` : ''}
  </div>`);

  for (const b of $$('[data-tab]', ctx.el)) b.addEventListener('click', () => navigate(b.dataset.tab, { replace: true }));
  for (const b of $$('[data-mode]', ctx.el)) {
    b.addEventListener('click', async () => {
      const next = b.dataset.mode;
      if (next === mode || !sa) return;
      const ok = await confirmDialog({
        title: `Switch sign-up to ${MODES[next].label}?`,
        body: html`<p>This applies to every new account from now on. Invitations into an existing org keep working in every mode.</p>
          <div class="rows">${Object.entries(MODES).map(([k, m]) => html`<div class="row${k === next ? ' pp-picked' : ''}"><span class="g ${k === next ? 'violet' : 'slate'}">${icon(k === next ? 'check' : k === 'invite_code' ? 'ticket' : k === 'waitlist' ? 'history' : 'globe')}</span><div class="t"><b>${m.label}${k === mode ? ' (now)' : ''}</b><span class="pp-wrap">${m.line}</span></div></div>`)}</div>`,
        action: `Switch to ${MODES[next].label}`,
      });
      if (!ok) return;
      await run(b, async () => {
        await api.put('/api/platform/registration', { mode: next });
        toast(`Sign-up mode: ${MODES[next].label}`);
        ctx.refresh();
      });
    });
  }
  $('#new-code', ctx.el)?.addEventListener('click', () => newCodeDialog(ctx, tiers));
  for (const b of $$('[data-revoke]', ctx.el)) {
    b.addEventListener('click', async () => {
      const c = codes.find((x) => x.id === b.dataset.revoke);
      const ok = await confirmDialog({
        title: 'Revoke this code?',
        body: html`<p>${c?.note ? html`<b>${c.note}</b>: ` : ''}nobody can sign up with it any more. Accounts already created with it stay.</p>`,
        action: 'Revoke code', danger: true,
      });
      if (!ok) return;
      await run(b, async () => {
        await api.del(p`/api/platform/registration/codes/${b.dataset.revoke}`);
        toast('Code revoked');
        ctx.refresh();
      });
    });
  }
  for (const b of $$('[data-approve]', ctx.el)) {
    b.addEventListener('click', () => run(b, async () => {
      await api.post(p`/api/platform/waitlist/${b.dataset.approve}/approve`);
      toast('Approved. They got an email that their account is ready.');
      ctx.refresh();
    }));
  }
  for (const b of $$('[data-reject]', ctx.el)) {
    b.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Reject this sign-up?',
        body: html`<p>The waiting account of <b>${(() => { const w = pending.find((x) => x.id === b.dataset.reject); return w?.email || w?.name || shortId(b.dataset.reject); })()}</b> is deleted at once, with everything stored for it. They can sign up again later.</p>`,
        action: 'Reject and delete', danger: true,
      });
      if (!ok) return;
      await run(b, async () => {
        await api.post(p`/api/platform/waitlist/${b.dataset.reject}/reject`);
        toast('Rejected; the account is deleted');
        ctx.refresh();
      });
    });
  }
}

function newCodeDialog(ctx, tiers) {
  const list = tiers.length ? tiers : [{ id: 'free', name: 'Free' }];
  const m = openModal(html`<h2>New registration code</h2>
    <form class="form" id="nc-form" novalidate>
      <div class="grid g2">
        ${features.tiers ? html`<div class="field"><label for="nc-tier">Plan</label><select class="inp" id="nc-tier">${list.map((t) => html`<option value="${t.id}">${t.name || t.id}</option>`)}</select></div>` : ''}
        <div class="field"><label for="nc-uses">Uses</label><input class="inp mono" id="nc-uses" type="number" min="1" max="1000" value="1" required></div>
      </div>
      <div class="field"><label for="nc-days">Expires in days <span class="opt">empty: never</span></label><input class="inp mono" id="nc-days" type="number" min="1" max="365" value="30"></div>
      <div class="field"><label for="nc-note">Note <span class="opt">only staff see it</span></label><input class="inp" id="nc-note" maxlength="200" placeholder="Who it is for"></div>
      <div class="acts"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" id="nc-go" type="submit">Create code</button></div>
    </form>`);
  $('#nc-form', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const uses = Number($('#nc-uses', m).value);
    const daysRaw = $('#nc-days', m).value.trim();
    const days = daysRaw === '' ? null : Number(daysRaw);
    clearFieldErrors(m);
    if (!Number.isInteger(uses) || uses < 1 || uses > 1000) return void fieldError($('#nc-uses', m), 'Uses must be a whole number from 1 to 1,000.');
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) return void fieldError($('#nc-days', m), 'Expiry must be 1 to 365 days, or empty for never.');
    const note = $('#nc-note', m).value.trim();
    await run($('#nc-go', m), async () => {
      const res = await api.post('/api/platform/registration/codes', { ...(features.tiers ? { tier: $('#nc-tier', m).value } : {}), uses, expiresInDays: days, ...(note ? { note } : {}) });
      showNewCode(ctx, res);
    });
  });
}

function showNewCode(ctx, res) {
  const m = openModal(html`<div class="center"><span class="g green lg">${icon('ticket')}</span><h2>Code created</h2>
      <p>Send it to the person yourself. They enter it when they sign up at ${location.host}.</p>
      <div class="codeblock pp-code" id="nc-code" tabindex="0" aria-label="Registration code">${res.code}</div>
      <p class="pp-small muted">${plural(res.usesTotal, 'use')} · ${res.expiresAt ? `expires ${dateShort(res.expiresAt)}` : 'never expires'}${res.note ? ` · ${res.note}` : ''}</p></div>
    <div class="banner amber">${icon('alert')}<div class="grow"><b>You won't see this code again.</b> Only a hash of it is stored. Copy it now.</div></div>
    <div class="acts pp-center"><button class="btn" id="nc-copy">${icon('copy')}Copy</button><button class="btn primary" data-close>Done</button></div>`,
  { onClose: () => ctx.refresh() });
  $('#nc-copy', m).addEventListener('click', () => copyText(res.code));
}

// ---- Users and support ------------------------------------------------------------------------

const STATUS_PILL = { active: ['green', 'Active'], pending: ['amber', 'Waiting for approval'], disabled: ['red', 'Disabled'] };
const VIA = { code: 'a registration code', invitation: 'an invitation', sso: 'single sign-on', waitlist: 'the waitlist', approved: 'the waitlist, approved', open: 'open sign-up', setup: 'platform setup' };
const ORG_ROLE = { tenant_admin: 'admin', tenant_user: 'member' };

function methodsText(u) {
  const parts = [];
  if (u.signInMethods?.passkeys) parts.push(plural(u.signInMethods.passkeys, 'passkey'));
  for (const prov of u.signInMethods?.providers || []) {
    if (prov === 'credential') continue;
    parts.push(SIGN_IN_METHOD[prov] || (String(prov).startsWith('sso-') ? 'Single sign-on' : prov));
  }
  parts.push('Email code');
  return [...new Set(parts)].join(', ');
}

function userCard(u, { requestOpen }) {
  const [tone, label] = STATUS_PILL[u.status] || ['slate', u.status];
  const self = u.id === meId();
  const outranked = !self && rankOf(u.platformRoles) >= rankOf(state.me.platformRoles);
  const supportable = can('users.support') && !self && !outranked;
  const name = u.name || u.email || 'Unnamed';
  const actions = [];
  if (supportable) {
    if (u.status !== 'pending') {
      actions.push(html`<div class="row">${icon('key')}<div class="t"><b>Reset sign-in after lost passkeys</b><span class="pp-wrap">Removes every passkey and session; they then sign in with an email code. A second staff member approves it within 24 hours.</span></div>
        <div class="r">${requestOpen ? html`<span class="pill amber">Waiting for approval</span>` : html`<button class="btn sm" id="u-reset">Start reset</button>`}</div></div>`);
    }
    actions.push(html`<div class="row">${icon('logout')}<div class="t"><b>Sign out everywhere</b><span class="pp-wrap">Ends every session, including open instance tabs, at once.</span></div><div class="r"><button class="btn sm" id="u-signout">Sign out</button></div></div>`);
    if (u.status === 'active') actions.push(html`<div class="row">${icon('lock')}<div class="t"><b>Disable the account</b><span class="pp-wrap">Blocks sign-in and ends every session until enabled again. Their orgs are not touched.</span></div><div class="r"><button class="btn sm danger" id="u-disable">Disable</button></div></div>`);
    if (u.status === 'disabled') actions.push(html`<div class="row">${icon('check')}<div class="t"><b>Enable the account</b><span class="pp-wrap">They can sign in again.</span></div><div class="r"><button class="btn sm" id="u-enable">Enable</button></div></div>`);
  }
  return html`<div class="card stack" id="user-card" data-user="${u.id}">
    <div class="flex pp-nowrap"><span class="av pp-av">${initials(name)}</span><div class="pp-grow"><b class="pp-name">${name}</b><div class="mono muted pp-small pp-wrap">${u.email || '—'} · ${shortId(u.id)}</div></div><span class="pill ${tone}">${label}</span></div>
    <dl class="kv">
      <dt>Orgs</dt><dd>${u.orgs?.length ? u.orgs.map((o, i) => html`${i ? ', ' : ''}<a href="${p`/platform/orgs/${o.id}`}">${o.name || shortId(o.id)}</a> <span class="muted">(${String(o.role || '').split(',').map((r) => ORG_ROLE[r.trim()] || r.trim()).join(', ')})</span>`) : html`<span class="muted">None</span>`}</dd>
      <dt>Signs in with</dt><dd>${methodsText(u)}</dd>
      <dt>Last sign-in</dt><dd>${u.lastSignIn ? html`${dateTime(u.lastSignIn.at)}${u.lastSignIn.method ? html` · ${SIGN_IN_METHOD[u.lastSignIn.method] || u.lastSignIn.method}` : ''}` : html`<span class="muted">Not in the last 30 days</span>`}</dd>
      <dt>Active sessions</dt><dd class="mono">${u.activeSessions ?? 0}</dd>
      <dt>Account since</dt><dd>${dateShort(u.createdAt)}${u.registeredVia ? html`, via ${VIA[u.registeredVia] || u.registeredVia}` : ''}${u.signupTier ? html` · plan ${u.signupTier}` : ''}</dd>
      <dt>Platform roles</dt><dd>${u.platformRoles?.length ? html`<span class="flex">${u.platformRoles.map(rolePill)}</span>` : html`<span class="muted">None</span>`}</dd>
    </dl>
    ${!can('users.support') ? '' : self
      ? html`<div class="banner blue">${icon('info')}<div class="grow">This is your own account. Another staff member handles support actions for it.</div></div>`
      : outranked
        ? html`<div class="banner amber" id="u-outranked">${icon('lock')}<div class="grow">They hold the ${ROLE_LABEL[strongest(u.platformRoles)]} role, at or above yours. Only someone ranked higher can sign them out, disable them or reset their sign-in.</div></div>`
        : html`<div class="label">Support actions</div>
          ${u.status === 'pending' ? html`<div class="banner amber">${icon('info')}<div class="grow">This account is waiting for approval. Approve or reject it under <a href="/platform/registration?tab=waitlist">Registration</a>.</div></div>` : ''}
          <div class="rows">${actions}</div>`}
  </div>`;
}

function requestRow(r, names) {
  const mine = r.requestedBy === meId();
  const note = r.canApprove ? '' : mine ? 'You asked for this; another staff member approves it' : r.userId === meId() ? 'This is your own account' : 'Needs someone ranked above them';
  return html`<div class="row pp-req" data-request="${r.id}">${icon('key')}
    <div class="t"><b>${r.name || r.email || shortId(r.userId)}</b>
      <span class="pp-wrap">${r.email ? html`<a href="${`/platform/users?email=${encodeURIComponent(r.email)}`}">${r.email}</a> · ` : ''}asked by ${who(r.requestedBy, names)} ${relTime(r.createdAt)} · expires ${relTime(r.expiresAt)}</span>
      ${r.reason ? html`<span class="pp-wrap pp-reason">“${r.reason}”</span>` : ''}</div>
    <div class="r">${r.canApprove ? html`<button class="btn sm primary" data-approve-req="${r.id}">${icon('check')}Approve</button>` : html`<span class="muted pp-small">${note}</span>`}</div></div>`;
}

async function renderUsers(ctx) {
  const email = (ctx.query.get('email') || '').trim();
  const [user, reqRes, names] = await Promise.all([
    email ? api.get(`/api/platform/users?email=${encodeURIComponent(email)}`).catch((e) => ({ error: e })) : null,
    api.get('/api/platform/support-requests').catch((e) => ({ error: e })),
    staffNames(),
  ]);
  if (!ctx.alive()) return;
  const requests = reqRes.requests || [];
  const requestOpen = !!(user && !user.error && requests.some((r) => r.userId === user.id));
  let result = '';
  if (user?.error) {
    const e = user.error;
    result = e.code === 'user_not_found'
      ? html`<div class="card empty" id="user-miss">No account with that address. Check it for typos; partial matches aren't possible.</div>`
      : html`<div class="card"><div class="banner amber">${icon('alert')}<div class="grow">${say(e)}</div></div></div>`;
  } else if (user) {
    result = userCard(user, { requestOpen });
  }

  ctx.set(html`<div class="page narrow">
    <div class="head"><div><h1>Find a user</h1><p>Look up one account by its exact email address. Addresses are stored encrypted, so there's no browsing or partial search. Every lookup is in the audit log.</p></div></div>
    <form class="card flex pp-nowrap" id="find" role="search"><label class="pp-sr" for="q">Email address</label>
      <input class="inp" id="q" type="email" placeholder="name@company.com" autocomplete="off" spellcheck="false" value="${email}" required>
      <button class="btn primary" type="submit">${icon('search')}Find</button></form>
    ${result}
    <div class="card"><div class="card-head"><h2>Sign-in resets waiting for approval</h2><span class="sub">${reqRes.error ? '' : plural(requests.length, 'request')}</span></div>
      ${reqRes.error ? html`<div class="banner amber">${icon('alert')}<div class="grow">Couldn't load the requests: ${say(reqRes.error)}</div></div>`
        : requests.length ? html`<div class="rows" id="requests">${requests.map((r) => requestRow(r, names))}</div>`
          : html`<div class="empty">No resets are waiting. When someone loses every passkey, find them above and start one.</div>`}
      <p class="hint pp-gap">A reset needs two people: one staff member asks for it, a different one approves it from a passkey session within 24 hours. Approving removes every passkey and session of the person at once.</p></div>
  </div>`);

  $('#find', ctx.el).addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#q', ctx.el).value.trim();
    navigate(q ? `/platform/users?email=${encodeURIComponent(q)}` : '/platform/users');
  });
  if (!email) $('#q', ctx.el).focus();

  if (user && !user.error) bindUserActions(ctx, user);
  for (const b of $$('[data-approve-req]', ctx.el)) {
    const r = requests.find((x) => x.id === b.dataset.approveReq);
    b.addEventListener('click', () => approveReset(ctx, b, r));
  }
}

function bindUserActions(ctx, u) {
  const name = u.name || u.email;
  $('#u-signout', ctx.el)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const ok = await confirmDialog({ title: `Sign ${name} out everywhere?`, body: html`<p>Every session ends now, including open instance tabs. They can sign in again right away.</p>`, action: 'Sign out everywhere' });
    if (!ok) return;
    await run(btn, async () => {
      const r = await api.post(p`/api/platform/users/${u.id}/sign-out`);
      toast(`Signed out of ${plural(r.sessionsEnded ?? 0, 'session')}`);
      ctx.refresh();
    });
  });
  $('#u-disable', ctx.el)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const ok = await confirmDialog({
      title: `Disable ${name}?`,
      body: html`<p>They can't sign in until the account is enabled again, and every session ends now, including open instance tabs. Their orgs and instances are not touched.</p>`,
      action: 'Disable account', danger: true,
    });
    if (!ok) return;
    await run(btn, async () => {
      await api.post(p`/api/platform/users/${u.id}/disable`);
      toast('Account disabled');
      ctx.refresh();
    });
  });
  $('#u-enable', ctx.el)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const ok = await confirmDialog({ title: `Enable ${name}?`, body: html`<p>They can sign in again with their usual methods.</p>`, action: 'Enable account' });
    if (!ok) return;
    await run(btn, async () => {
      await api.post(p`/api/platform/users/${u.id}/enable`);
      toast('Account enabled');
      ctx.refresh();
    });
  });
  $('#u-reset', ctx.el)?.addEventListener('click', () => {
    const m = openModal(html`<h2>Reset sign-in for ${name}</h2>
      <p>Use this when someone has lost every passkey. Once a second staff member approves it, every passkey and session of the account is removed and they sign in with an email code to add a new passkey.</p>
      <form class="form" id="rs-form" novalidate>
        <div class="field"><label for="rs-why">Reason <span class="opt">the approver sees it</span></label>
          <textarea class="inp" id="rs-why" rows="3" maxlength="1000" placeholder="How they contacted us and how we checked it was them"></textarea></div>
        <div class="acts"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" id="rs-go" type="submit">Ask for approval</button></div></form>`);
    $('#rs-form', m).addEventListener('submit', async (e) => {
      e.preventDefault();
      const reason = $('#rs-why', m).value.trim();
      if (!reason) return void fieldError($('#rs-why', m), 'Give a reason.');
      await run($('#rs-go', m), async () => {
        const r = await api.post(p`/api/platform/users/${u.id}/reset-signin`, { reason });
        openModal(html`<div class="center"><span class="g amber lg">${icon('users')}</span><h2>Needs a second person</h2>
          <p>Resetting sign-in lets someone take over an account, so a different staff member approves it under Users and support. The request expires ${relTime(r.expiresAt)}.</p></div>
          <div class="acts"><button class="btn primary" data-close>OK</button></div>`, { onClose: () => ctx.refresh() });
      });
    });
  });
}

async function approveReset(ctx, btn, r) {
  const name = r.name || r.email || shortId(r.userId);
  const ok = await confirmDialog({
    title: `Approve the sign-in reset for ${name}?`,
    body: html`<p>This happens at once: <b>every passkey and every session</b> of ${r.email || name} is deleted, they are signed out of every instance, and they get an email. They then sign in with an email code and add a new passkey.</p>
      ${r.reason ? html`<div class="banner violet">${icon('info')}<div class="grow">Reason given: “${r.reason}”</div></div>` : ''}
      <p class="muted pp-small">Only approve if you checked it is really them.</p>`,
    action: 'Approve and reset', danger: true,
  });
  if (!ok) return;
  await run(btn, async () => {
    const res = await protectedAction({ title: 'Approve a sign-in reset', typed: false, call: () => api.raw('POST', p`/api/platform/support-requests/${r.id}/approve`, {}) });
    if (!res) return;
    toast(`Reset done: ${plural(res.body.passkeys ?? 0, 'passkey')} and ${plural(res.body.sessions ?? 0, 'session')} removed`);
    ctx.refresh();
  });
}

// ---- Audit log ------------------------------------------------------------------------------

/** Plain-language labels for every action in src/control/tenancy/audit.ts. */
const ACTION_LABEL = {
  'org.created': 'Created an org', 'org.renamed': 'Renamed an org', 'org.deleted': 'Deleted an org', 'org.tier_changed': 'Changed an org’s plan',
  'org.key_rotated': 'Rotated an org’s data key', 'org.policy_updated': 'Changed an org’s sign-in policy', 'org.audit_viewed': 'Viewed an org’s audit log',
  'member.role_changed': 'Changed a member’s role', 'member.removed': 'Removed a member',
  'invitation.created': 'Invited someone', 'invitation.canceled': 'Canceled an invitation', 'invitation.resent': 'Resent an invitation',
  'team.created': 'Created a team', 'team.renamed': 'Renamed a team', 'team.deleted': 'Deleted a team', 'team.member_added': 'Added someone to a team', 'team.member_removed': 'Removed someone from a team',
  'instance.policy_updated': 'Changed an instance’s sign-in policy', 'instance.stopped': 'Stopped an instance for abuse', 'instance.stop_lifted': 'Lifted an abuse stop',
  'instance.create_started': 'Started creating an instance', 'instance.created': 'Instance created', 'instance.create_failed': 'Instance creation failed',
  'instance.renamed': 'Renamed an instance', 'instance.teams_changed': 'Changed which teams can open an instance',
  'instance.upgrade_started': 'Started an upgrade', 'instance.upgraded': 'Instance upgraded', 'instance.upgrade_rolled_back': 'Upgrade rolled back', 'instance.auto_update_set': 'Changed automatic updates',
  'instance.suspended': 'Instance went to sleep', 'instance.delete_started': 'Started deleting an instance', 'instance.deleted': 'Instance deleted', 'instance.op_restarted': 'Restarted a stuck operation',
  'instance.rotate_started': 'Started renewing an instance’s credentials', 'instance.secrets_rotated': 'Instance credentials renewed', 'instances.rotate_all_started': 'Started renewing every instance’s credentials',
  'auth.signed_in': 'Signed in', 'auth.sign_in_failed': 'Sign-in failed', 'auth.signed_out': 'Signed out', 'auth.passkey_added': 'Added a passkey',
  'auth.session_revoked': 'Ended a session', 'auth.other_sessions_revoked': 'Ended their other sessions',
  'platform.bootstrapped': 'Set up the platform',
  'domain.added': 'Added a domain', 'domain.verified': 'Verified a domain', 'domain.verify_failed': 'Domain check failed', 'domain.removed': 'Removed a domain',
  'sso.registered': 'Added single sign-on', 'sso.removed': 'Removed single sign-on',
  'confirmation.started': 'Emailed a confirmation link', 'confirmation.completed': 'Confirmed by email',
  'platform.role_granted': 'Granted a platform role', 'platform.role_revoked': 'Removed a platform role',
  'platform.registration_mode_set': 'Changed the sign-up mode', 'platform.worca_version_set': 'Published a Worca version',
  'platform.tier_created': 'Created a tier', 'platform.tier_updated': 'Changed a tier', 'platform.tier_deleted': 'Deleted a tier', 'platform.provider_settings_set': 'Changed the provider settings', 'instance.provider_settings_set': 'Changed an instance\'s hosting settings', 'instance.size_set': 'Changed an instance\'s compute size',
  'platform.code_created': 'Created a registration code', 'platform.code_revoked': 'Revoked a registration code',
  'platform.waitlist_approved': 'Approved a waiting account', 'platform.waitlist_viewed': 'Viewed the waitlist', 'platform.waitlist_rejected': 'Rejected a waiting account',
  'platform.audit_viewed': 'Viewed the platform audit log', 'platform.master_key_rotated': 'Re-wrapped keys under the master key',
  'user.renamed': 'Changed their name', 'user.exported': 'Exported their data', 'user.deleted': 'Deleted an account',
  'support.user_looked_up': 'Looked up a user', 'support.user_signed_out': 'Signed a user out everywhere', 'support.user_disabled': 'Disabled an account',
  'support.user_enabled': 'Enabled an account', 'support.reset_requested': 'Asked for a sign-in reset', 'support.reset_executed': 'Approved a sign-in reset',
  'support.requests_viewed': 'Viewed sign-in reset requests',
  'audit.pruned': 'Removed entries older than 30 days',
};
const PAGE = 50;
const actionLabel = (a) => ACTION_LABEL[a] || String(a).replace(/[._]/g, ' ');
const CATEGORIES = [['', 'All'], ['instances', 'Instances'], ['members', 'People'], ['security', 'Security'], ['settings', 'Settings']];
const ACTION_GROUPS = [
  ['', 'Any action'], ['support.', 'Support actions'], ['platform.', 'Platform settings and roles'], ['auth.', 'Sign-ins and sessions'],
  ['instance.', 'Instances'], ['org.', 'Orgs'], ['member.', 'Members'], ['invitation.', 'Invitations'], ['team.', 'Teams'],
  ['domain.', 'Domains'], ['sso.', 'Single sign-on'], ['confirmation.', 'Email confirmations'], ['user.', 'Accounts'],
];
const DETAIL_LABEL = { method: 'method', role: 'role', mode: 'mode', tier: 'plan', from: 'from', to: 'to', uses: 'uses', sessions: 'sessions', passkeys: 'passkeys', version: 'version', found: 'found', count: 'count', rewrapped: 're-wrapped', failed: 'failed', reason: 'reason' };

function detailsText(d) {
  if (!d || typeof d !== 'object') return '';
  return Object.entries(d)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .slice(0, 5)
    .map(([k, v]) => `${DETAIL_LABEL[k] || k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${typeof v === 'boolean' ? (v ? 'yes' : 'no') : v}`)
    .join(' · ');
}

function auditRow(e, names) {
  const det = detailsText(e.details);
  return html`<tr data-entry="${e.id}">
    <td class="muted pp-nobr" title="${dateTime(e.at)}">${relTime(e.at)}</td>
    <td class="pp-nobr">${e.actorId ? html`<button type="button" class="linkbtn" data-actor="${e.actorId}" title="Only this person's actions">${who(e.actorId, names)}</button>` : html`<span class="muted">System</span>`}</td>
    <td>${e.actorRole && RANK[e.actorRole] ? rolePill(e.actorRole) : html`<span class="muted">${e.actorRole === 'system' ? 'system' : e.actorRole || '—'}</span>`}</td>
    <td><div>${actionLabel(e.action)}</div><div class="muted pp-small pp-wrap"><span class="mono">${e.action}</span>${e.targetId ? html` · ${e.targetType || 'target'} <span class="mono">${shortId(e.targetId)}</span>` : ''}${det ? html` · ${det}` : ''}</div></td></tr>`;
}

function csvOf(entries, names) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
  };
  const head = ['time', 'actor', 'actor_id', 'role', 'action', 'what', 'category', 'target_type', 'target_id', 'details'];
  const lines = entries.map((e) => [new Date(e.at).toISOString(), e.actorId ? who(e.actorId, names) : 'System', e.actorId, e.actorRole, e.action, actionLabel(e.action), e.category, e.targetType, e.targetId, e.details ? JSON.stringify(e.details) : ''].map(cell).join(','));
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}

async function renderAudit(ctx) {
  const f = { category: ctx.query.get('category') || '', actorId: ctx.query.get('actor') || '', action: ctx.query.get('action') || '' };
  const qs = (extra = {}) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ category: f.category, actorId: f.actorId, action: f.action, limit: String(PAGE), ...extra })) if (v) u.set(k, v);
    return u.toString();
  };
  const [first, names] = await Promise.all([api.get(`/api/platform/audit?${qs()}`), staffNames()]);
  if (!ctx.alive()) return;
  let entries = first.entries || [];
  let more = entries.length === PAGE;
  const filtered = !!(f.category || f.actorId || f.action);
  const go = (patch) => {
    const n = { ...f, ...patch };
    const u = new URLSearchParams();
    if (n.category) u.set('category', n.category);
    if (n.actorId) u.set('actor', n.actorId);
    if (n.action) u.set('action', n.action);
    navigate(`/platform/audit${u.toString() ? `?${u}` : ''}`, { replace: true });
  };
  const actorOptions = [['', 'Anyone'], [meId(), 'You'], ...[...names.entries()].filter(([id]) => id !== meId()).map(([id, n]) => [id, n])];
  if (f.actorId && !actorOptions.some(([id]) => id === f.actorId)) actorOptions.push([f.actorId, who(f.actorId, names)]);

  ctx.set(html`<div class="page">
    <div class="head"><div><h1>Audit log</h1><p>Every platform action by staff and by the system. Ids and numbers only, never tenant content. Kept for 30 days.</p></div>
      <div class="acts"><button class="btn" id="csv" ${entries.length ? '' : 'disabled'}>${icon('download')}Export CSV</button></div></div>
    ${first.lostWritesToday > 0 ? html`<div class="banner amber" id="lost">${icon('alert')}<div class="grow"><b>${plural(first.lostWritesToday, 'audit entry', 'audit entries')} could not be written today.</b> The actions themselves went through; check the Worker logs for <span class="code">at: audit</span>.</div></div>` : ''}
    <div class="card pp-filters">
      <div class="seg" role="group" aria-label="Category">${CATEGORIES.map(([k, l]) => html`<button type="button" class="${f.category === k ? 'on' : ''}" data-cat="${k}" aria-pressed="${f.category === k ? 'true' : 'false'}">${l}</button>`)}</div>
      <div class="pp-filter-row">
        <div class="field"><label for="f-actor">Who</label><select class="inp" id="f-actor">${actorOptions.map(([id, n]) => html`<option value="${id}" ${id === f.actorId ? 'selected' : ''}>${n}</option>`)}</select></div>
        <div class="field"><label for="f-action">Action</label><select class="inp" id="f-action">${ACTION_GROUPS.map(([k, l]) => html`<option value="${k}" ${k === f.action ? 'selected' : ''}>${l}</option>`)}${f.action && !ACTION_GROUPS.some(([k]) => k === f.action) ? html`<option value="${f.action}" selected>${f.action}</option>` : ''}</select></div>
        ${filtered ? html`<button class="btn ghost sm pp-clear" id="f-clear">${icon('x')}Clear filters</button>` : ''}
      </div></div>
    <div class="card pp-tablecard">${entries.length
      ? html`<div class="tablewrap"><table><thead><tr><th>When</th><th>Who</th><th>Role</th><th>What</th></tr></thead><tbody id="audit-rows">${entries.map((e) => auditRow(e, names))}</tbody></table></div>`
      : html`<div class="empty">${filtered ? 'No entries match these filters.' : 'No entries in the last 30 days.'}</div>`}</div>
    <div class="pp-center" id="more-wrap" ${more ? '' : 'hidden'}><button class="btn" id="more">Load older entries</button></div>
  </div>`);

  const bindActors = (root) => { for (const b of $$('[data-actor]', root)) b.addEventListener('click', () => go({ actorId: b.dataset.actor })); };
  bindActors(ctx.el);
  for (const b of $$('[data-cat]', ctx.el)) b.addEventListener('click', () => go({ category: b.dataset.cat }));
  $('#f-actor', ctx.el).addEventListener('change', (e) => go({ actorId: e.target.value }));
  $('#f-action', ctx.el).addEventListener('change', (e) => go({ action: e.target.value }));
  $('#f-clear', ctx.el)?.addEventListener('click', () => go({ category: '', actorId: '', action: '' }));
  $('#more', ctx.el).addEventListener('click', (e) => run(e.currentTarget, async () => {
    const res = await api.get(`/api/platform/audit?${qs({ before: String(entries.at(-1).at) })}`);
    if (!ctx.alive()) return;
    const next = res.entries || [];
    entries = entries.concat(next);
    more = next.length === PAGE;
    const tbody = $('#audit-rows', ctx.el);
    const tmp = document.createElement('tbody');
    setHtml(tmp, next.map((x) => auditRow(x, names)));
    bindActors(tmp);
    tbody.append(...tmp.children);
    $('#more-wrap', ctx.el).hidden = !more;
  }));
  $('#csv', ctx.el).addEventListener('click', () => {
    const blob = new Blob([csvOf(entries, names)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `worca-platform-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`Exported ${plural(entries.length, 'entry', 'entries')}`);
  });
}

// ---- Platform roles -------------------------------------------------------------------------

const ROLE_DESC = {
  support: 'Reads orgs, instances, their status and the system page',
  admin: 'Plus registration, plans, abuse stops, user support and the audit log',
  superadmin: 'Plus releases, roles, system settings and keys',
};

async function renderRoles(ctx) {
  const { bindings } = await api.get('/api/platform/roles');
  if (!ctx.alive()) return;
  const superadmins = bindings.filter((b) => b.role === 'superadmin').length;
  const names = new Map(bindings.map((b) => [b.userId, b.name || b.email]));
  const order = (b) => -RANK[b.role] || 0;
  const sorted = [...bindings].sort((a, b) => order(a) - order(b) || (a.grantedAt || 0) - (b.grantedAt || 0));
  ctx.set(html`<div class="page narrow">
    <div class="head"><div><h1>Staff and roles</h1><p>Platform roles never open a tenant's instance. Staff need a passkey to use the console.</p></div>
      <div class="acts"><button class="btn primary" id="grant">${icon('plus')}Add staff</button></div></div>
    <div class="grid g3">${['support', 'admin', 'superadmin'].map((r) => html`<div class="tile"><div class="k">${icon(r === 'superadmin' ? 'crown' : r === 'admin' ? 'shield' : 'search')}${ROLE_LABEL[r]}</div><div class="v pp-v">${bindings.filter((b) => b.role === r).length}</div><div class="s">${ROLE_DESC[r]}</div></div>`)}</div>
    <div class="card">${sorted.length ? html`<div class="list" id="staff">${sorted.map((b) => {
      const self = b.userId === meId();
      const last = b.role === 'superadmin' && superadmins <= 1;
      const label = `${b.name || b.email || shortId(b.userId)}`;
      return html`<div class="row" data-binding="${b.userId}:${b.role}"><span class="av">${initials(b.name || b.email)}</span>
        <div class="t"><b>${label}${self ? html` <span class="muted pp-light">(you)</span>` : ''}</b><span><span class="mono">${b.email || shortId(b.userId)}</span> · granted ${relTime(b.grantedAt)}${b.grantedBy ? html` by ${b.grantedBy === meId() ? 'you' : names.get(b.grantedBy) || shortId(b.grantedBy)}` : ''}</span></div>
        <div class="r">${rolePill(b.role)}${self ? '' : html`<button class="btn sm ghost" data-revoke-role="${b.userId}" data-role="${b.role}" ${last ? html`disabled title="There must always be one superadmin"` : ''} aria-label="Remove ${ROLE_LABEL[b.role]} from ${label}">Remove</button>`}</div></div>`;
    })}</div>` : html`<div class="empty">No staff yet.</div>`}
    <p class="hint pp-gap">The last superadmin can't be removed, and nobody can change their own roles.</p></div>
  </div>`);

  $('#grant', ctx.el).addEventListener('click', () => {
    const m = openModal(html`<h2>Add staff</h2>
      <form class="form" id="g-form" novalidate>
        <div class="field"><label for="g-mail">Their Worca account's email</label><input class="inp" id="g-mail" type="email" autocomplete="off" spellcheck="false" required placeholder="name@example.com">
          <span class="hint">They need an account first, and a passkey to open the console.</span></div>
        <fieldset class="field pp-fieldset"><legend class="pp-legend">Role</legend><div class="checks">${['support', 'admin', 'superadmin'].map((r) => html`<label class="check"><input type="radio" name="g-role" value="${r}" ${r === 'support' ? 'checked' : ''}><span class="t"><b>${ROLE_LABEL[r]}</b><span>${ROLE_DESC[r]}</span></span></label>`)}</div></fieldset>
        ${alertBox('g-err')}
        <div class="acts"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" id="g-go" type="submit">Add</button></div></form>`);
    $('#g-form', m).addEventListener('submit', async (e) => {
      e.preventDefault();
      const mail = $('#g-mail', m);
      const email = mail.value.trim();
      const role = $('input[name="g-role"]:checked', m).value;
      const err = $('#g-err', m);
      showAlert(err, '');
      if (!email) return void fieldError(mail, 'Enter their email address.');
      const go = $('#g-go', m);
      go.disabled = true;
      try {
        await api.post('/api/platform/roles', { email, role });
        closeModal();
        toast(`${email} is now ${ROLE_LABEL[role]}`);
        ctx.refresh();
      } catch (ex) {
        go.disabled = false;
        const field = ex instanceof ApiError && { user_not_found: 'No account with that address. They need to sign up first.', invalid_body: 'Enter a full email address.' }[ex.code];
        if (field) fieldError(mail, field);
        else showAlert(err, say(ex));
      }
    });
  });
  for (const b of $$('[data-revoke-role]', ctx.el)) {
    b.addEventListener('click', async () => {
      const userId = b.dataset.revokeRole, role = b.dataset.role;
      const bind = bindings.find((x) => x.userId === userId && x.role === role);
      const ok = await confirmDialog({
        title: 'Remove platform role?',
        body: html`<p><b>${bind?.name || bind?.email || shortId(userId)}</b> loses the ${ROLE_LABEL[role]} role at once. Their own account and org memberships stay.</p>`,
        action: 'Remove role', danger: true,
      });
      if (!ok) return;
      await run(b, async () => {
        await api.del(p`/api/platform/roles/${userId}/${role}`);
        toast('Role removed');
        ctx.refresh();
      });
    });
  }
}

// ---- System ---------------------------------------------------------------------------------

const MAIL_KIND = { sign_in_code: 'Sign-in codes', invitation: 'Invitations', confirmation: 'Confirmations', notification: 'Notifications', passkey_notice: 'Passkey notices', access_request: 'Access requests', staff_digest: 'Staff notices', newsletter: 'Newsletter', newsletter_confirm: 'Newsletter sign-ups' };
const pct = (n, of) => (of ? Math.round((n / of) * 100) : 0);
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');
const meterTone = (n, of) => (n >= of ? 'red' : n >= of * 0.8 ? 'amber' : '');

function mailCard(mail) {
  const daily = mail.limits?.daily || 100, monthly = mail.limits?.monthly || 3000;
  const today = mail.today?.total || 0;
  const kinds = Object.entries(mail.today?.byKind || {}).sort((a, b) => b[1] - a[1]);
  const days = mail.last14Days || [];
  const peak = Math.max(1, ...days.map((d) => d.total));
  return html`<div class="card" id="mail"><div class="card-head"><h2>Mail</h2><span class="sub">Resend ${mail.limits?.plan || 'free'} plan · our own count per UTC day</span></div>
    ${today >= daily ? html`<div class="banner amber pp-mb">${icon('alert')}<div class="grow"><b>Today's limit is reached.</b> Resend refuses further mail until midnight UTC, including sign-in codes.</div></div>` : ''}
    <div class="grid g2">
      <div class="pp-quota"><div class="between"><span class="ink2">Today</span><span class="mono"><b>${fmt(today)}</b> / ${fmt(daily)}</span></div><div class="meter pp-meter ${meterTone(today, daily)}"><i data-w="${pct(today, daily)}"></i></div></div>
      <div class="pp-quota"><div class="between"><span class="ink2">This month</span><span class="mono"><b>${fmt(mail.monthToDate || 0)}</b> / ${fmt(monthly)}</span></div><div class="meter pp-meter ${meterTone(mail.monthToDate || 0, monthly)}"><i data-w="${pct(mail.monthToDate || 0, monthly)}"></i></div></div>
    </div>
    <div class="grid g2 pp-gap">
      <div><div class="label">Today by kind</div>${kinds.length ? html`<div class="rows">${kinds.map(([k, n]) => html`<div class="row pp-tight"><div class="t"><b>${MAIL_KIND[k] || k}</b></div><div class="r mono">${fmt(n)}</div></div>`)}</div>` : html`<div class="empty">No mail sent today.</div>`}</div>
      <div><div class="label">Last 14 days</div><div class="pp-days" id="mail-days">${days.slice().reverse().map((d) => html`<div class="pp-day"><span class="muted mono">${d.day.slice(5)}</span><span class="pp-daybar"><i data-w="${pct(d.total, peak)}" class="${d.total >= daily ? 'over' : ''}"></i></span><span class="mono">${fmt(d.total)}</span></div>`)}</div></div>
    </div>
    ${mail.quotaHeaders ? html`<p class="hint pp-gap">Resend's own count at the last send (${relTime(mail.quotaHeaders.at)}): ${mail.quotaHeaders.daily ?? '—'} today, ${mail.quotaHeaders.monthly ?? '—'} this month.</p>` : ''}
  </div>`;
}

function probeRow({ title, probe, line }) {
  const ok = probe && probe.ok;
  return html`<div class="row"><span class="g ${ok ? 'green' : 'red'}">${icon(ok ? 'check' : 'alert')}</span>
    <div class="t"><b>${title}${probe?.fake ? html` <span class="pill slate">fake</span>` : ''}</b><span class="pp-wrap">${ok ? line : probe?.error ? (String(probe.error).startsWith('not_configured') ? `Not configured: ${String(probe.error).replace(/^not_configured:\s*/, '')}` : probe.error) : 'No answer'}</span></div>
    <div class="r mono">${probe && typeof probe.latencyMs === 'number' ? `${fmt(probe.latencyMs)} ms` : '—'}</div></div>`;
}

function providersCard(pr) {
  const r = pr.compute || {}, t = pr.cloudflare?.tunnels || {}, d = pr.cloudflare?.dnsRecords || {};
  const usage = (r.items || []).map((x, k) => html`${k ? ' · ' : ''}${fmt(x.used)}${x.limit ? ` of ${fmt(x.limit)}` : ''} ${x.label}`);
  return html`<div class="card" id="providers"><div class="card-head"><h2>Providers</h2><span class="sub">Checked ${relTime(pr.checkedAt)}${pr.cached ? ' · cached for up to 10 min' : ''}</span></div>
    ${pr.fake ? html`<div class="banner blue pp-mb">${icon('info')}<div class="grow">Fake providers: nothing real is called here (local development). The numbers below are stand-ins.</div></div>` : ''}
    <div class="rows">
      ${probeRow({ title: `${r.displayName || 'Compute provider'} · compute`, probe: r, line: html`Plan ${r.plan || '—'}${usage.length ? html` · ${usage}` : ''}` })}
      ${probeRow({ title: 'Cloudflare · tunnels', probe: t, line: html`${plural(t.count ?? 0, 'tunnel')}` })}
      ${probeRow({ title: 'Cloudflare · DNS', probe: d, line: html`${fmt(d.count)}${d.quota ? ` of ${fmt(d.quota)}` : ''} DNS records${d.zonePlan ? ` · zone plan ${d.zonePlan}` : ''}` })}
      <div class="row"><span class="g ${pr.turnstile?.configured ? 'green' : 'amber'}">${icon(pr.turnstile?.configured ? 'check' : 'alert')}</span><div class="t"><b>Bot protection on sign-in</b><span class="pp-wrap">${pr.turnstile?.configured ? 'Turnstile is configured' : 'Turnstile is not configured (TURNSTILE_SECRET and TURNSTILE_SITE_KEY)'}</span></div></div>
    </div><p class="hint pp-gap">Latency is the time of our own call to the provider's API.</p></div>`;
}

function keysCard(keys) {
  const sa = can('keys.master');
  const groups = (type) => (keys.wrapped?.[type] || []);
  const total = (type) => groups(type).reduce((n, g) => n + g.count, 0);
  const rows = (type, label) => groups(type).map((g) => html`<tr><td>${label}</td><td class="mono">v${g.version}</td>${sa ? html`<td class="mono pp-small">${g.masterId || html`<span class="muted">before fingerprints</span>`}${keys.master && g.masterId === keys.master.masterId ? html` <span class="pill green">current</span>` : ''}</td>` : ''}<td class="num">${fmt(g.count)}</td></tr>`);
  return html`<div class="card" id="keys"><div class="card-head"><h2>Data keys</h2><span class="sub">${fmt(total('org'))} org keys, ${fmt(total('user'))} user keys</span></div>
    ${total('org') + total('user') ? html`<div class="tablewrap"><table><thead><tr><th>Owner</th><th>Version</th>${sa ? html`<th>Wrapped by master key</th>` : ''}<th class="num">Keys</th></tr></thead>
      <tbody>${rows('org', 'Org')}${rows('user', 'User')}</tbody></table></div>` : html`<div class="empty">No data keys yet.</div>`}
    <dl class="kv pp-gap"><dt>Destroyed</dt><dd>${plural(keys.destroyed?.org || 0, 'org key')}, ${plural(keys.destroyed?.user || 0, 'user key')} <span class="muted">(crypto-erased with their org or account)</span></dd>
      <dt>Form keys</dt><dd>${plural(keys.formKeys?.accessRequests || 0, 'access request')}, ${plural(keys.formKeys?.newsletter || 0, 'newsletter subscriber')} <span class="muted">(one key each, deleted with their data)</span></dd>
      <dt>Last org key rotation</dt><dd>${keys.lastOrgKeyRotationAt ? dateTime(keys.lastOrgKeyRotationAt) : html`<span class="muted">None yet</span>`}</dd></dl></div>`;
}

function masterCard(m) {
  if (!m) return html`<div class="card"><div class="card-head"><h2>Master key</h2></div><div class="banner amber">${icon('alert')}<div class="grow">The master key status couldn't be read. Check the Worker logs.</div></div></div>`;
  const pending = m.status !== 'done';
  return html`<div class="card" id="master"><div class="card-head"><h2>Master key</h2><span class="pill ${pending ? 'amber' : 'green'}" id="master-status">${pending ? 'Rotation pending' : 'All keys current'}</span></div>
    <dl class="kv"><dt>Current</dt><dd class="mono">${m.masterId}</dd>
      <dt>Previous</dt><dd>${m.previousMasterId ? html`<span class="mono">${m.previousMasterId}</span>` : html`<span class="muted">Not set (MASTER_KEY_PREVIOUS)</span>`}</dd>
      <dt>Under the current key</dt><dd><span class="mono" id="master-done">${fmt(m.done)} of ${fmt(m.total)}</span> data keys</dd></dl>
    <div class="meter pp-meter pp-gap"><i id="master-meter" data-w="${pct(m.done, m.total || 1)}"></i></div>
    <div class="banner violet pp-gap">${icon('info')}<div class="grow"><b>Before rotating:</b> make the new key and put it in the offline backup. Then set <span class="code">MASTER_KEY_PREVIOUS</span> to the old key and <span class="code">MASTER_KEY</span> to the new one on the control Worker and deploy. Rotating here re-wraps every org and user key under the new key; tenant data isn't re-encrypted, so it takes seconds. Remove <span class="code">MASTER_KEY_PREVIOUS</span> only once every key is current.</div></div>
    ${!pending ? html`<p class="hint pp-gap">Every data key is wrapped by the current master key. There is nothing to rotate until a new MASTER_KEY is deployed.</p>`
      : !m.previousMasterId ? html`<div class="banner amber pp-gap">${icon('alert')}<div class="grow">Some keys are wrapped by another master key, but <span class="code">MASTER_KEY_PREVIOUS</span> isn't set, so they can't be re-wrapped. Set it to the old key and deploy first.</div></div>` : ''}
    ${alertBox('master-err', 'pp-gap')}
    <div class="between pp-gap"><span class="ink2 pp-small" id="master-progress">${pending ? `${fmt(m.total - m.done)} keys still wrapped by an older master key.` : ''}</span>
      <button class="btn" id="rotate-master" ${pending && m.previousMasterId ? '' : 'disabled'}>${icon('key')}Rotate master key</button></div></div>`;
}

async function rotateMaster(ctx, btn) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const res = await protectedAction({
    title: 'Rotate master key',
    consequence: 'Every org and user key is re-wrapped under the master key now deployed as MASTER_KEY. Keep the old key in the offline backup until you no longer need database backups from before today.',
    name: 'rotate master key',
    actionLabel: 'Start rotation',
    call: () => api.raw('POST', '/api/platform/keys/rotate-master', {}),
  });
  if (!res) return;
  btn.disabled = true;
  const err = $('#master-err', ctx.el);
  showAlert(err, '');
  let s = res.body, rewrapped = s.rewrapped || 0, failed = s.failed || 0, retries = 0;
  const show = () => {
    if (!ctx.alive()) return;
    const meter = $('#master-meter', ctx.el);
    if (meter) meter.style.width = `${pct(s.done, s.total || 1)}%`;
    const done = $('#master-done', ctx.el);
    if (done) done.textContent = `${fmt(s.done)} of ${fmt(s.total)}`;
    const prog = $('#master-progress', ctx.el);
    if (prog) prog.textContent = s.status === 'done' ? `Done: ${fmt(rewrapped)} keys re-wrapped.` : `Re-wrapping… ${fmt(rewrapped)} so far${failed ? `, ${fmt(failed)} failed` : ''}.`;
  };
  show();
  while (ctx.alive() && s.status !== 'done') {
    if (s.rewrapped === 0) {
      // No progress: rows neither key can unwrap. Stop instead of looping (security.md step 4).
      showAlert(err, `${fmt(s.total - s.done)} keys could not be re-wrapped with either key. Check that MASTER_KEY_PREVIOUS really is the old key, then try again.`);
      break;
    }
    try {
      s = (await api.raw('POST', '/api/platform/keys/rotate-master', {})).body;
      rewrapped += s.rewrapped || 0;
      failed += s.failed || 0;
      retries = 0;
      show();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 429 || e.status === 409) && retries < 5) {
        retries++;
        const p_ = $('#master-progress', ctx.el);
        if (p_) p_.textContent = e.status === 429 ? 'Too many requests; waiting a moment…' : 'Another rotation is running; waiting…';
        await sleep(3000 * retries);
        continue;
      }
      showAlert(err, `Rotation stopped: ${say(e)} Run it again to continue; finished keys stay done.`);
      break;
    }
  }
  if (!ctx.alive()) return;
  if (s.status === 'done') {
    toast('Master key rotation done');
    const st = $('#master-status', ctx.el);
    if (st) { st.className = 'pill green'; st.textContent = 'All keys current'; }
    const p_ = $('#master-progress', ctx.el);
    if (p_) p_.textContent = `Done: ${fmt(rewrapped)} keys re-wrapped. You can now remove MASTER_KEY_PREVIOUS.`;
  } else {
    btn.disabled = false;
  }
}

async function renderSystem(ctx) {
  const settle = (pr) => pr.then((v) => ({ v }), (e) => ({ e }));
  const [mail, prov, keys] = await Promise.all([
    settle(api.get('/api/platform/system/mail')),
    settle(api.get('/api/platform/system/providers')),
    settle(api.get('/api/platform/keys')),
  ]);
  if (!ctx.alive()) return;
  const failed = (what, r) => html`<div class="card"><div class="card-head"><h2>${what}</h2></div><div class="banner amber">${icon('alert')}<div class="grow">Couldn't load: ${say(r.e)}</div></div></div>`;
  ctx.set(html`<div class="page narrow">
    <div class="head"><div><h1>System</h1><p>Mail, providers and keys. Current state only; changes here affect every tenant.</p></div>
      <div class="acts"><button class="btn" id="sys-refresh">${icon('refresh')}Refresh</button></div></div>
    ${mail.e ? failed('Mail', mail) : mailCard(mail.v)}
    ${prov.e ? failed('Providers', prov) : providersCard(prov.v)}
    ${can('keys.master') && !keys.e ? masterCard(keys.v.master) : ''}
    ${keys.e ? failed('Data keys', keys) : keysCard(keys.v)}
  </div>`);
  meters(ctx.el);
  $('#sys-refresh', ctx.el).addEventListener('click', () => ctx.refresh());
  $('#rotate-master', ctx.el)?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    run(btn, () => rotateMaster(ctx, btn));
  });
}

// ---- views ------------------------------------------------------------------------------------

export default [
  { path: '/platform/registration', nav: 'p-registration', title: 'Registration', guard: needs('registration.codes'), render: renderRegistration },
  { path: '/platform/users', nav: 'p-users', title: 'Users and support', guard: needs('users.support'), render: renderUsers },
  { path: '/platform/audit', nav: 'p-audit', title: 'Audit log', guard: needs('audit.view'), render: renderAudit },
  { path: '/platform/roles', nav: 'p-roles', title: 'Platform roles', guard: needs('roles.manage'), render: renderRoles },
  { path: '/platform/system', nav: 'p-system', title: 'System', guard: needs('platform.view'), render: renderSystem },
];

