// Platform console, Access requests (D69): people who asked for hosted worca on the website and
// confirmed their address. Superadmins grant (a single-use sign-up code, bound to the address and
// mailed to it) or decline (an optional polite mail). API: src/control/tenancy/access-requests-routes.ts.
// main.mjs adds the staff guard and the passkey gate; the capability check only hides what the
// API would refuse anyway.
import { api, brand, features, html, icon, p, relTime, dateShort, errorText, openModal, closeModal, copyText, hasRole, toast, navigate, ApiError, $, $$, fieldError } from '../core.mjs';

const canManage = () => hasRole('superadmin'); // 'access_requests.manage' (roles.ts)

const ERR = {
  not_pending: 'Someone already decided on this request.',
  unknown_tier: "That plan doesn't exist.",
  not_found: 'Not found. Someone may have handled it already.',
  unreadable: "This request can't be read any more.",
};
const say = (e) => (e instanceof ApiError && ERR[e.code]) || errorText(e);
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

const STATUS = {
  pending: ['amber', 'Waiting'],
  granted: ['blue', 'Granted'],
  declined: ['slate', 'Declined'],
  joined: ['green', 'Signed up'],
};
const statusPill = (s) => html`<span class="pill ${STATUS[s]?.[0] || 'line'}">${STATUS[s]?.[1] || s}</span>`;

function requestRow(r, tab) {
  const label = r.email || r.id.slice(0, 8);
  return html`<tr data-request="${r.id}">
    <td><div class="t"><b class="mono pp-wrap">${r.removed ? html`<span class="muted">(removed)</span>` : r.email || html`<span class="muted">Unreadable</span>`}</b>${r.company ? html`<div class="muted pp-small pp-wrap">${r.company}</div>` : ''}</div></td>
    <td class="pp-wrap">${r.removed ? html`<span class="muted">(removed)</span>` : r.useCase || ''}</td>
    <td class="muted">${r.source || '—'}</td>
    <td class="muted pp-nobr">${relTime(r.confirmedAt || r.createdAt)}</td>
    ${tab === 'pending'
      ? html`<td class="pp-acts"><button class="btn sm" data-grant="${r.id}" aria-label="Grant access to ${label}">${icon('check')}Grant</button><button class="btn sm ghost" data-decline="${r.id}" aria-label="Decline ${label}">Decline</button></td>`
      : html`<td class="pp-nobr">${statusPill(r.status)}${r.decidedAt ? html`<div class="muted pp-small">${relTime(r.decidedAt)}</div>` : ''}</td>`}</tr>`;
}

async function renderAccessRequests(ctx) {
  const tab = ctx.query.get('status') === 'all' ? 'all' : 'pending';
  const [res, tiersRes] = await Promise.all([
    api.get(`/api/platform/access-requests?status=${tab}`),
    features.tiers ? api.get('/api/platform/tiers').catch(() => ({ tiers: [] })) : { tiers: [] },
  ]);
  if (!ctx.alive()) return;
  const requests = res.requests || [];
  const c = res.counts || { byStatus: {} };
  const by = c.byStatus || {};
  const tiers = tiersRes.tiers || [];
  const tile = (ic, k, v, s) => html`<div class="tile"><div class="k">${icon(ic)}${k}</div><div class="v pp-v">${v ?? 0}</div><div class="s">${s}</div></div>`;

  const table = requests.length
    ? html`<div class="tablewrap"><table><thead><tr><th>Who</th><th>What they want to do</th><th>From</th><th>${tab === 'pending' ? 'Waiting' : 'Asked'}</th><th>${tab === 'pending' ? html`<span class="pp-sr">Actions</span>` : 'Status'}</th></tr></thead>
      <tbody>${requests.map((r) => requestRow(r, tab))}</tbody></table></div>`
    : html`<div class="empty">${tab === 'pending' ? 'No requests are waiting.' : 'No confirmed requests yet.'}</div>`;

  ctx.set(html`<div class="page">
    <div class="head"><div><h1>Access requests</h1><p>People who asked for ${brand.service}${brand.website ? html` on ${brand.website}` : ''} and confirmed their address. Granting mails them a sign-up code that only works for that address.</p></div></div>
    <div class="grid g4" id="ar-funnel">
      ${tile('mail', 'Requested', c.requested, html`<b>${by.unconfirmed ?? 0}</b> not confirmed yet`)}
      ${tile('check', 'Confirmed', c.confirmed, html`<b>${by.pending ?? 0}</b> waiting · <b>${by.declined ?? 0}</b> declined`)}
      ${tile('ticket', 'Granted', c.granted, html`<b>${by.granted ?? 0}</b> not signed up yet`)}
      ${tile('users', 'Signed up', c.joined, html`<b>${c.withInstance ?? 0}</b> run an instance`)}
    </div>
    <div class="between"><div class="seg" role="group" aria-label="Show">
      <button type="button" class="${tab === 'pending' ? 'on' : ''}" data-tab="/platform/access-requests" aria-pressed="${tab === 'pending' ? 'true' : 'false'}">Waiting · ${by.pending ?? 0}</button>
      <button type="button" class="${tab === 'all' ? 'on' : ''}" data-tab="/platform/access-requests?status=all" aria-pressed="${tab === 'all' ? 'true' : 'false'}">All confirmed</button></div></div>
    <div class="card pp-tablecard">${table}</div>
    <p class="hint">Unconfirmed requests are only counted and are deleted a week after their link expires. 180 days after a decision or sign-up, a request's address and text are deleted; the counts stay. Every listing is recorded in the audit log.</p>
  </div>`);

  for (const b of $$('[data-tab]', ctx.el)) b.addEventListener('click', () => navigate(b.dataset.tab, { replace: true }));
  const find = (id) => requests.find((r) => r.id === id);
  for (const b of $$('[data-grant]', ctx.el)) b.addEventListener('click', () => grantDialog(ctx, find(b.dataset.grant), tiers));
  for (const b of $$('[data-decline]', ctx.el)) b.addEventListener('click', () => declineDialog(ctx, find(b.dataset.decline)));
}

function grantDialog(ctx, r, tiers) {
  const list = tiers.length ? tiers : [{ id: 'free', name: 'Free' }];
  const m = openModal(html`<h2>Grant access</h2>
    <p><b class="mono pp-wrap">${r.email}</b> gets a single-use sign-up code by email. It only works for this address.</p>
    <form class="form" id="ag-form" novalidate>
      <div class="grid g2">
        ${features.tiers ? html`<div class="field"><label for="ag-tier">Plan</label><select class="inp" id="ag-tier">${list.map((t) => html`<option value="${t.id}">${t.name || t.id}</option>`)}</select></div>` : ''}
        <div class="field"><label for="ag-days">Code expires in days</label><input class="inp mono" id="ag-days" type="number" min="1" max="365" value="14" required></div>
      </div>
      <div class="field"><label for="ag-msg">Personal message <span class="opt">optional, in the email</span></label><textarea class="inp" id="ag-msg" rows="3" maxlength="2000" placeholder="A few words of welcome"></textarea></div>
      <div class="acts"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" id="ag-go" type="submit">${icon('check')}Grant and send code</button></div>
    </form>`);
  $('#ag-form', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const days = Number($('#ag-days', m).value);
    if (!Number.isInteger(days) || days < 1 || days > 365) return void fieldError($('#ag-days', m), 'Expiry must be 1 to 365 days.');
    const message = $('#ag-msg', m).value.trim();
    await run($('#ag-go', m), async () => {
      const res = await api.post(p`/api/platform/access-requests/${r.id}/grant`, { ...(features.tiers ? { tier: $('#ag-tier', m).value } : {}), expiresInDays: days, ...(message ? { message } : {}) });
      closeModal();
      if (res.mailed) {
        toast(`Granted. ${r.email} got a sign-up code by email.`);
        ctx.refresh();
      } else unsentCode(ctx, r, res);
    });
  });
}

/** The grant went through but the mail didn't: the code is shown once, to pass on by hand. */
function unsentCode(ctx, r, res) {
  const m = openModal(html`<div class="center"><span class="g amber lg">${icon('alert')}</span><h2>Granted, but the email failed</h2>
      <p>Send this code to <b class="mono">${r.email}</b> yourself. It only works for that address.</p>
      <div class="codeblock pp-code" id="ag-code" tabindex="0" aria-label="Sign-up code">${res.code}</div>
      <p class="pp-small muted">${res.expiresAt ? `Expires ${dateShort(res.expiresAt)}` : ''}</p></div>
    <div class="banner amber">${icon('alert')}<div class="grow"><b>You won't see this code again.</b> Only a hash of it is stored. Copy it now.</div></div>
    <div class="acts pp-center"><button class="btn" id="ag-copy">${icon('copy')}Copy</button><button class="btn primary" data-close>Done</button></div>`,
  { onClose: () => ctx.refresh() });
  $('#ag-copy', m).addEventListener('click', () => copyText(res.code));
}

function declineDialog(ctx, r) {
  const m = openModal(html`<h2>Decline request</h2>
    <p>The request from <b class="mono pp-wrap">${r.email}</b> is closed. They can ask again later.</p>
    <form class="form" id="ad-form" novalidate>
      <label class="check"><input type="checkbox" id="ad-notify" checked><span class="t"><b>Tell them by email</b><span>A short, polite note that we can't offer access right now</span></span></label>
      <div class="field"><label for="ad-msg">Personal message <span class="opt">optional, in the email</span></label><textarea class="inp" id="ad-msg" rows="3" maxlength="2000"></textarea></div>
      <div class="acts"><button class="btn" type="button" data-close>Cancel</button><button class="btn danger" id="ad-go" type="submit">Decline</button></div>
    </form>`);
  const notify = $('#ad-notify', m);
  notify.addEventListener('change', () => { $('#ad-msg', m).disabled = !notify.checked; });
  $('#ad-form', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = $('#ad-msg', m).value.trim();
    await run($('#ad-go', m), async () => {
      await api.post(p`/api/platform/access-requests/${r.id}/decline`, { notify: notify.checked, ...(notify.checked && message ? { message } : {}) });
      closeModal();
      toast(notify.checked ? 'Declined. They got a short note by email.' : 'Declined. No email was sent.');
      ctx.refresh();
    });
  });
}

export default [
  { path: '/platform/access-requests', nav: 'p-access', title: 'Access requests', guard: () => (features.accessRequests && canManage() ? null : '/platform'), render: renderAccessRequests },
];
