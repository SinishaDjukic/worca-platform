// People of an org: the member directory with invitations and member management (tenant admins),
// the teams and a team's detail. Role-shaped like the API (D62): tenant users see the directory
// ("People") and the teams, read-only; admins also see how people sign in, who invited them, the
// open invitations with their delivery status, and manage members, teams and instance grants.
// docs/ui.md "Org workspace"; API in src/control/tenancy/routes.ts and teams.ts.
import {
  api, html, icon, p, busy, toast, navigate, loadMe, initials, plural, relTime, dateShort, dateTime, errorText,
  setHtml, openModal, closeModal, protectedAction, glyph, shownStatus, STATUS, SIGN_IN_METHOD, ApiError, $, $$,
  fieldError, clearFieldErrors, brand,
} from '../core.mjs';

// ---- shared -------------------------------------------------------------------------------------

const isAdminRole = (role) => String(role || '').split(',').map((r) => r.trim()).includes('tenant_admin');
const rolePill = (role) => (isAdminRole(role) ? html`<span class="pill violet">Admin</span>` : html`<span class="pill line">Member</span>`);
const orgBase = (orgId) => p`/o/${orgId}`;
const teamHref = (orgId, teamId) => p`/o/${orgId}/teams/${teamId}`;
const nameOf = (m) => m.name || m.email || 'Unknown person';
const teamLabel = (t) => t.name || 'Unnamed team';
const lc = (s) => String(s || '').toLowerCase();

/** Plain-language text for the error codes of these routes; anything else goes to errorText. */
const ERRORS = {
  last_tenant_admin: 'An org needs at least one admin. Make someone else an admin first.',
  member_limit: "Your plan's member limit is reached. Members and open invitations both count: cancel an invitation or remove someone first.",
  already_member: 'That address already belongs to a member of this org.',
  already_invited: 'That address already has an open invitation. Resend it from the list instead.',
  team_not_found: 'That team no longer exists. Pick another one.',
  invitation_mail_limit: 'The daily limit for invitation mail is reached. Try again tomorrow.',
  resend_too_soon: 'This invitation was sent less than 5 minutes ago. Wait a few minutes before sending it again.',
  invitation_unreadable: "This invitation's address can't be read any more. Cancel it and invite the person again.",
  member_not_found: 'That person is no longer a member of this org.',
  instance_not_found: 'That instance no longer exists.',
  last_team: 'This is the only team of that instance, and an instance always keeps one. Give it another team first, or delete the instance.',
  rate_limited: 'Too many attempts. Wait a moment and try again.',
};
/** An Error whose message is the plain-language text for `e`, for busy()'s toast. */
const friendly = (e, extra = {}) => new Error((e instanceof ApiError && (extra[e.code] || ERRORS[e.code])) || errorText(e));

/** A confirmation dialog; resolves true when confirmed. */
function confirmModal({ title, body, action, danger = true }) {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal(html`<h2 class="${danger ? 'danger' : ''}">${title}</h2><p>${body}</p>
      <div class="acts"><button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cf-go">${action}</button></div>`,
    { onClose: () => { if (!answered) resolve(false); } });
    $('#cf-go', m).addEventListener('click', () => { answered = true; closeModal(); resolve(true); });
    $('#cf-go', m).focus();
  });
}

/** A modal with one text field; resolves the trimmed value or null. */
function askName({ title, label, value = '', action, hint }) {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal(html`<h2>${title}</h2>
      <form class="form" id="an-form" novalidate>
        <div class="field"><label for="an-name">${label}</label><input class="inp" id="an-name" maxlength="100" autocomplete="off" value="${value}" required>
          ${hint ? html`<span class="hint">${hint}</span>` : ''}</div>
        <div class="acts"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" id="an-go">${action}</button></div>
      </form>`, { onClose: () => { if (!answered) resolve(null); } });
    const inp = $('#an-name', m);
    inp.select();
    $('#an-form', m).addEventListener('submit', (e) => {
      e.preventDefault();
      const v = inp.value.trim();
      if (!v) return void fieldError(inp, 'Enter a name.');
      answered = true;
      closeModal();
      resolve(v);
    });
  });
}

const searchBox = (id, label, placeholder) => html`<div class="ppl-search">${icon('search')}
  <label class="ppl-sr" for="${id}">${label}</label><input class="inp" id="${id}" type="search" placeholder="${placeholder}" autocomplete="off" spellcheck="false"></div>`;

const avatarStack = (people, max = 6) => html`<span class="ppl-avs">${people.slice(0, max).map((m) => html`<span class="av" title="${nameOf(m)}">${initials(m.name || m.email)}</span>`)}${people.length > max ? html`<span class="av ppl-more">+${people.length - max}</span>` : ''}</span>`;

const instPill = (inst) => html`<span class="pill line"><span class="dot ppl-dot ${(STATUS[shownStatus(inst)] || { tone: 'slate' }).tone}"></span>${inst.name || 'Unnamed instance'}</span>`;

/** Instances of the org the caller can see, by id; failures leave an empty map (non-essential). */
async function instancesById(orgId) {
  try {
    const { instances } = await api.get(p`/api/orgs/${orgId}/instances`);
    return new Map((instances || []).map((i) => [i.id, i]));
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) throw e;
    return new Map();
  }
}

// ---- members ------------------------------------------------------------------------------------

/** Resend's last event for the invitation mail, as worca shows it. */
const DELIVERY = {
  accepted: { tone: 'blue', label: 'Sent', line: 'Handed to the mail service; no delivery report yet' },
  sent: { tone: 'blue', label: 'Sent', line: 'Sent; no delivery report yet' },
  delivered: { tone: 'green', label: 'Delivered', line: "Arrived at the recipient's mail server" },
  delivery_delayed: { tone: 'amber', label: 'Delayed', line: 'The receiving server is slow to accept it; still trying' },
  bounced: { tone: 'red', label: 'Bounced', line: "The address doesn't accept mail. Check the spelling", bad: true },
  complained: { tone: 'red', label: 'Marked as spam', line: 'The recipient marked it as spam; we stop mailing them', bad: true },
  suppressed: { tone: 'red', label: 'Suppressed', line: 'Not sent: the address bounced or complained before', bad: true },
  failed: { tone: 'red', label: 'Failed', line: 'The mail service could not send it', bad: true },
  send_failed: { tone: 'red', label: 'Not sent', line: "We couldn't hand it to the mail service", bad: true },
};
function deliveryCell(d) {
  if (!d) return html`<span class="muted" title="No delivery report for this invitation">—</span>`;
  const s = DELIVERY[d.status] || { tone: 'slate', label: d.status, line: '' };
  return html`<div class="ppl-deliv"><span class="pill ${s.tone}" title="${s.line}">${s.label}</span><span class="muted" title="${dateTime(d.at)}">${relTime(d.at)}</span></div>`;
}
function expiresCell(inv) {
  const t = Date.parse(inv.expiresAt);
  if (inv.expired || t <= Date.now()) return html`<span class="pill amber" title="Expired ${dateTime(inv.expiresAt)}">Expired</span>`;
  const soon = t - Date.now() < 48 * 3600e3;
  return html`<span class="${soon ? 'ppl-soon' : 'muted'}" title="${dateTime(inv.expiresAt)}">${relTime(inv.expiresAt)}</span>`;
}
function signsInWith(m) {
  const s = m.signsInWith;
  if (!s) return '—';
  return (s.methods || []).map((k) => (k === 'passkey' && s.passkeys > 1 ? `${SIGN_IN_METHOD[k]} ×${s.passkeys}` : SIGN_IN_METHOD[k] || k)).join(', ');
}
const invitedBy = (m) => (m.invitedBy ? m.invitedBy.name || 'Former member' : '—');
const teamList = (teams) => (teams && teams.length ? teams.map(teamLabel).join(', ') : '—');

function memberRow(m, { admin, meId }) {
  const me = m.userId === meId;
  const who = html`<div class="who"><span class="av">${initials(m.name || m.email)}</span><div class="t"><b>${nameOf(m)}${me ? html` <span class="muted ppl-you">(you)</span>` : ''}</b><span>${m.email || ''}</span></div></div>`;
  if (!admin) {
    return html`<tr data-member="${m.userId}"><td>${who}</td><td>${rolePill(m.role)}</td><td class="ink2">${teamList(m.teams)}</td></tr>`;
  }
  return html`<tr data-member="${m.userId}"><td>${who}</td><td>${rolePill(m.role)}</td><td class="ink2">${teamList(m.teams)}</td>
    <td class="ink2">${signsInWith(m)}</td><td class="muted" title="${dateTime(m.joinedAt)}">${dateShort(m.joinedAt)}</td><td class="ink2">${invitedBy(m)}</td>
    <td class="ppl-act"><button class="btn sm ghost" data-manage="${m.userId}" aria-label="Manage ${nameOf(m)}">Manage</button></td></tr>`;
}

function invitationRow(inv, teamsById) {
  const team = inv.teamId ? teamsById.get(inv.teamId) : null;
  return html`<tr data-invitation="${inv.id}"><td class="mono ppl-email">${inv.email || 'Unreadable address'}</td><td>${rolePill(inv.role)}</td>
    <td class="ink2">${inv.teamId ? (team ? teamLabel(team) : 'Removed team') : '—'}</td><td class="ink2">${inv.inviter?.name || '—'}</td>
    <td>${deliveryCell(inv.delivery)}</td><td>${expiresCell(inv)}</td>
    <td class="ppl-act"><button class="btn sm ghost" data-resend="${inv.id}" aria-label="Resend the invitation to ${inv.email || 'this address'}">Resend</button><button class="btn sm ghost" data-cancel="${inv.id}" aria-label="Cancel the invitation to ${inv.email || 'this address'}">Cancel</button></td></tr>`;
}

const matches = (q, ...fields) => !q || fields.some((f) => lc(f).includes(q));

const members = {
  path: '/o/:orgId/members',
  nav: 'members',
  title: 'Members',
  async render(ctx) {
    const admin = isAdminRole(ctx.org.role);
    if (!admin) document.title = `People · ${brand.product}`;
    const orgId = ctx.orgId;
    const meId = ctx.me.user.id;
    const orgName = ctx.org.name || 'this org';
    const [mem, teamsRes, invRes, org] = await Promise.all([
      api.get(p`/api/orgs/${orgId}/members`),
      admin ? api.get(p`/api/orgs/${orgId}/teams`) : null,
      admin ? api.get(p`/api/orgs/${orgId}/invitations`) : null,
      admin ? api.get(p`/api/orgs/${orgId}`).catch(() => null) : null,
    ]);
    if (!ctx.alive()) return;
    const S = {
      members: mem.members || [],
      teams: teamsRes?.teams || [],
      invitations: invRes?.invitations || [],
      seats: org?.tier?.members ?? null,
      tab: admin && ctx.query.get('tab') === 'invitations' ? 'invitations' : 'members',
      q: '',
    };
    const teamsById = () => new Map(S.teams.map((t) => [t.id, t]));

    if (!admin) {
      ctx.set(html`<div class="page">
        <div class="head"><div><h1>People</h1><p>Everyone in ${orgName}. Admins manage the org; ask one of them to change your teams.</p></div></div>
        <div class="between">${searchBox('ppl-q', 'Search people', 'Search by name, email or team')}<span class="muted" id="ppl-count"></span></div>
        <div class="card ppl-tablecard"><div class="tablewrap"><table>
          <thead><tr><th>Person</th><th>Role</th><th>Teams</th></tr></thead>
          <tbody id="mem-body"></tbody></table></div></div></div>`);
    } else {
      ctx.set(html`<div class="page">
        <div class="head"><div><h1>Members</h1><p>Everyone in ${orgName}. Admins manage the org; members use the instances their teams can reach.</p></div>
          <div class="acts"><button class="btn primary" id="invite">${icon('plus')}Invite people</button></div></div>
        <div class="between ppl-bar">
          <div class="seg" role="tablist" aria-label="Members or invitations">
            <button role="tab" id="tab-members" aria-controls="panel-members">Members</button><button role="tab" id="tab-invitations" aria-controls="panel-invitations">Invitations</button></div>
          ${searchBox('ppl-q', 'Search members and invitations', 'Search by name, email or team')}</div>
        <div id="inv-alert"></div>
        <div class="card ppl-tablecard" id="panel-members" role="tabpanel" aria-labelledby="tab-members"><div class="tablewrap"><table>
          <thead><tr><th>Person</th><th>Role</th><th>Teams</th><th>Signs in with</th><th>Joined</th><th>Invited by</th><th><span class="ppl-sr">Actions</span></th></tr></thead>
          <tbody id="mem-body"></tbody></table></div></div>
        <div class="card ppl-tablecard" id="panel-invitations" role="tabpanel" aria-labelledby="tab-invitations"><div class="tablewrap"><table>
          <thead><tr><th>Email</th><th>Role</th><th>Team</th><th>Invited by</th><th>Delivery</th><th>Expires</th><th><span class="ppl-sr">Actions</span></th></tr></thead>
          <tbody id="inv-body"></tbody></table></div></div>
        <p class="hint" id="seats"></p></div>`);
    }

    const el = ctx.el;
    function paintMembers() {
      const body = $('#mem-body', el);
      if (!body) return;
      const list = S.members.filter((m) => matches(S.q, m.name, m.email, ...(m.teams || []).map((t) => t.name)));
      const cols = admin ? 7 : 3;
      setHtml(body, list.length
        ? list.map((m) => memberRow(m, { admin, meId }))
        : html`<tr><td colspan="${cols}" class="empty">${S.members.length ? 'No one matches your search.' : 'No members yet.'}</td></tr>`);
      const count = $('#ppl-count', el);
      if (count) count.textContent = S.q ? `${list.length} of ${plural(S.members.length, 'person', 'people')}` : plural(S.members.length, 'person', 'people');
    }
    function paintInvitations() {
      const body = $('#inv-body', el);
      if (!body) return;
      const byId = teamsById();
      const list = S.invitations.filter((i) => matches(S.q, i.email, i.inviter?.name, byId.get(i.teamId)?.name));
      setHtml(body, list.length
        ? list.map((i) => invitationRow(i, byId))
        : html`<tr><td colspan="7" class="empty">${S.invitations.length ? 'No invitation matches your search.' : 'No open invitations.'}</td></tr>`);
      const bad = S.invitations.filter((i) => i.delivery && DELIVERY[i.delivery.status]?.bad);
      const expired = S.invitations.filter((i) => i.expired);
      S.alert = !!(bad.length || expired.length);
      $('#inv-alert', el).hidden = !S.alert || S.tab !== 'invitations';
      setHtml($('#inv-alert', el), S.alert
        ? html`<div class="banner amber">${icon('alert')}<div class="grow">${bad.length ? html`<div><b>${plural(bad.length, 'invitation')} didn't reach ${bad.length === 1 ? 'its address' : 'their addresses'}</b>: ${bad.map((i) => i.email).join(', ')}. Check the spelling, then cancel and invite again.</div>` : ''}${expired.length ? html`<div>${plural(expired.length, 'invitation')} expired. Resend to give ${expired.length === 1 ? 'it' : 'them'} a new link, or cancel.</div>` : ''}</div></div>`
        : '');
    }
    function paintTabs() {
      if (!admin) return;
      const t = S.tab;
      for (const k of ['members', 'invitations']) {
        const b = $(`#tab-${k}`, el);
        b.className = t === k ? 'on' : '';
        b.setAttribute('aria-selected', String(t === k));
        b.tabIndex = t === k ? 0 : -1;
        $(`#panel-${k}`, el).hidden = t !== k;
      }
      $('#tab-members', el).textContent = `Members · ${S.members.length}`;
      $('#tab-invitations', el).textContent = `Invitations · ${S.invitations.length}`;
      $('#inv-alert', el).hidden = t !== 'invitations' || !S.alert;
      const seats = $('#seats', el);
      if (seats) seats.textContent = S.seats ? `${S.members.length + S.invitations.length} of ${S.seats} seats used: members and open invitations count toward your plan's limit.` : '';
    }
    const paint = () => { paintTabs(); paintMembers(); paintInvitations(); };
    paint();

    async function reloadMembers() {
      const [m, t] = await Promise.all([api.get(p`/api/orgs/${orgId}/members`), api.get(p`/api/orgs/${orgId}/teams`)]);
      S.members = m.members || [];
      S.teams = t.teams || [];
    }
    async function reloadInvitations() {
      S.invitations = (await api.get(p`/api/orgs/${orgId}/invitations`)).invitations || [];
    }

    $('#ppl-q', el).addEventListener('input', (e) => { S.q = lc(e.currentTarget.value.trim()); paintMembers(); paintInvitations(); });
    if (!admin) return;

    const setTab = (t) => {
      S.tab = t;
      history.replaceState(null, '', t === 'invitations' ? `${location.pathname}?tab=invitations` : location.pathname);
      paintTabs();
    };
    for (const k of ['members', 'invitations']) {
      $(`#tab-${k}`, el).addEventListener('click', () => setTab(k));
      $(`#tab-${k}`, el).addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const next = k === 'members' ? 'invitations' : 'members';
        setTab(next);
        $(`#tab-${next}`, el).focus();
      });
    }

    $('#invite', el).addEventListener('click', () => openInvite());
    el.addEventListener('click', (e) => {
      const manage = e.target.closest('[data-manage]');
      if (manage) return openManage(manage.dataset.manage);
      const resend = e.target.closest('[data-resend]');
      if (resend) return busy(resend, () => doResend(resend.dataset.resend));
      const cancel = e.target.closest('[data-cancel]');
      if (cancel) return doCancel(cancel);
      return undefined;
    });

    // Delivery reports arrive from Resend's webhook after the mail went out.
    ctx.poll(async () => {
      if ($('#scrim')) return;
      try {
        await reloadInvitations();
        if (ctx.alive()) { paintTabs(); paintInvitations(); }
      } catch { /* the next poll tries again */ }
    }, 30_000);

    async function doResend(id) {
      const inv = S.invitations.find((i) => i.id === id);
      try {
        await api.post(p`/api/orgs/${orgId}/invitations/${id}/resend`);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'not_found') {
          await reloadInvitations();
          paint();
          throw new Error('That invitation is no longer open: it was accepted or canceled.');
        }
        throw friendly(e);
      }
      await reloadInvitations();
      if (!ctx.alive()) return;
      paint();
      toast(`Invitation sent again to ${inv?.email || 'the address'}`);
    }

    async function doCancel(btn) {
      const inv = S.invitations.find((i) => i.id === btn.dataset.cancel);
      if (!inv) return;
      const ok = await confirmModal({
        title: 'Cancel invitation',
        body: html`The link sent to <b>${inv.email || 'this address'}</b> stops working. You can invite them again later.`,
        action: 'Cancel invitation',
      });
      if (!ok) return;
      await busy(btn, async () => {
        try {
          await api.del(p`/api/orgs/${orgId}/invitations/${inv.id}`);
        } catch (e) {
          if (!(e instanceof ApiError && e.code === 'not_found')) throw friendly(e);
        }
        await reloadInvitations();
        if (!ctx.alive()) return;
        paint();
        toast(`Invitation to ${inv.email || 'the address'} canceled`);
      });
    }

    function openInvite() {
      const used = S.members.length + S.invitations.length;
      const full = S.seats !== null && used >= S.seats;
      const m = openModal(html`<h2>Invite people</h2>
        <form class="form" id="iv-form" novalidate>
          ${full ? html`<div class="banner amber">${icon('alert')}<div class="grow">All ${S.seats} seats of your plan are taken by members and open invitations. Cancel an invitation or remove someone to invite more.</div></div>` : ''}
          <div class="field"><label for="iv-mail">Email addresses</label>
            <textarea class="inp ppl-ta" id="iv-mail" rows="3" placeholder="name@example.com" spellcheck="false" autocomplete="off" aria-describedby="iv-mail-hint"></textarea>
            <span class="hint" id="iv-mail-hint">One or more, separated by commas or new lines. Each person gets an emailed link to join.${S.seats !== null ? ` ${Math.max(0, S.seats - used)} of ${S.seats} seats free.` : ''}</span></div>
          <div class="grid g2">
            <div class="field"><label for="iv-role">Role</label><select class="inp" id="iv-role"><option value="tenant_user">Member</option><option value="tenant_admin">Admin</option></select>
              <span class="hint" id="iv-role-hint">Uses the instances their teams can reach.</span></div>
            <div class="field"><label for="iv-team">Team <span class="opt">(optional)</span></label><select class="inp" id="iv-team"><option value="">No team</option>${S.teams.map((t) => html`<option value="${t.id}">${teamLabel(t)}</option>`)}</select></div>
          </div>
          <div class="ppl-err" id="iv-err"></div>
          <div class="acts"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" id="iv-go">${icon('mail')}Send invitation</button></div>
        </form>`, { wide: true });
      const role = $('#iv-role', m);
      role.addEventListener('change', () => {
        $('#iv-role-hint', m).textContent = role.value === 'tenant_admin' ? 'Manages the org: members, teams, instances and settings.' : 'Uses the instances their teams can reach.';
      });
      $('#iv-form', m).addEventListener('submit', (e) => {
        e.preventDefault();
        const go = $('#iv-go', m);
        busy(go, async () => {
          const ta = $('#iv-mail', m);
          const emails = [...new Set(ta.value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
          const errBox = $('#iv-err', m);
          setHtml(errBox, '');
          clearFieldErrors(m);
          const bad = emails.filter((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
          if (!emails.length || bad.length) return void fieldError(ta, emails.length ? `Not an email address: ${bad.join(', ')}` : 'Enter at least one email address.');
          const body = { role: role.value, ...($('#iv-team', m).value ? { teamId: $('#iv-team', m).value } : {}) };
          const failed = [];
          const sent = [];
          for (const email of emails) {
            try {
              await api.post(p`/api/orgs/${orgId}/invitations`, { email, ...body });
              sent.push(email);
            } catch (err) {
              if (err instanceof ApiError && err.status === 401) throw err;
              failed.push({ email, text: friendly(err, { invalid_body: 'Not a valid email address.' }).message });
            }
          }
          if (sent.length) {
            await reloadInvitations().catch(() => {});
            if (ctx.alive()) { setTab('invitations'); paint(); }
          }
          if (!failed.length) {
            closeModal();
            toast(sent.length === 1 ? `Invitation sent to ${sent[0]}` : `${sent.length} invitations sent`);
            return;
          }
          ta.value = failed.map((f) => f.email).join('\n');
          // Some sent: amber (partly done); none sent: red (the action failed).
          setHtml(errBox, html`<div class="banner ${sent.length ? 'amber' : 'red'}" role="alert">${icon(sent.length ? 'alert' : 'err')}<div class="grow">
            ${sent.length ? html`<div>Sent to ${sent.join(', ')}.</div>` : ''}
            ${failed.map((f) => html`<div><b>${f.email}</b>: ${f.text}</div>`)}</div></div>`);
        });
      });
    }

    function openManage(userId, { lastAdmin = false } = {}) {
      const mb = S.members.find((x) => x.userId === userId);
      if (!mb) return;
      const isMe = userId === meId;
      const mine = new Set((mb.teams || []).map((t) => t.id));
      const m = openModal(html`<h2>${nameOf(mb)}${isMe ? html` <span class="muted ppl-you">(you)</span>` : ''}</h2>
        <p class="mono ppl-email">${mb.email || ''}</p>
        <form class="form" id="mg-form" novalidate>
          <div class="field"><label for="mg-role">Role</label><select class="inp" id="mg-role">
            <option value="tenant_user" ${isAdminRole(mb.role) ? '' : 'selected'}>Member</option><option value="tenant_admin" ${isAdminRole(mb.role) ? 'selected' : ''}>Admin</option></select>
            ${isMe ? html`<span class="hint">If you make yourself a member, you can no longer manage this org.</span>` : ''}</div>
          <fieldset class="field ppl-fs"><legend>Teams</legend>
            ${S.teams.length
              ? html`<div class="checks">${S.teams.map((t) => html`<label class="check"><input type="checkbox" value="${t.id}" ${mine.has(t.id) ? 'checked' : ''}><span class="t"><b>${teamLabel(t)}</b><span>${plural(t.members, 'person', 'people')}</span></span></label>`)}</div>`
              : html`<div class="hint">No teams yet. <a href="${orgBase(orgId) + '/teams'}">Create one</a> to give people access to instances.</div>`}</fieldset>
          <div class="ppl-err" id="mg-err"></div>
          <div class="acts ppl-split"><button type="button" class="btn danger" id="mg-rm">${icon('trash')}${isMe ? 'Leave org' : 'Remove from org'}</button>
            <span class="flex"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" id="mg-save">Save</button></span></div>
        </form>`, { wide: true });
      for (const a of $$('a', m)) a.addEventListener('click', () => closeModal());
      const lastAdminBanner = () => setHtml($('#mg-err', m), html`<div class="banner amber" role="alert">${icon('alert')}<div class="grow"><b>${isMe ? 'You are' : `${nameOf(mb)} is`} the last admin of ${orgName}.</b> An org needs at least one admin: make someone else an admin first.</div></div>`);
      if (lastAdmin) lastAdminBanner();

      $('#mg-form', m).addEventListener('submit', (e) => {
        e.preventDefault();
        busy($('#mg-save', m), async () => {
          const role = $('#mg-role', m).value;
          const want = new Set($$('.checks input:checked', m).map((x) => x.value));
          const add = [...want].filter((t) => !mine.has(t));
          const drop = [...mine].filter((t) => !want.has(t));
          const errBox = $('#mg-err', m);
          const roleChanged = role !== (isAdminRole(mb.role) ? 'tenant_admin' : 'tenant_user');
          if (roleChanged) {
            try {
              await api.patch(p`/api/orgs/${orgId}/members/${userId}`, { role });
            } catch (err) {
              if (err instanceof ApiError && err.code === 'last_tenant_admin') return void lastAdminBanner();
              throw friendly(err);
            }
          }
          const problems = [];
          for (const t of add) {
            try { await api.post(p`/api/orgs/${orgId}/teams/${t}/members`, { userId }); } catch (err) {
              if (!(err instanceof ApiError && err.code === 'already_member')) problems.push(friendly(err, { not_found: 'A team no longer exists.' }).message);
            }
          }
          for (const t of drop) {
            try { await api.del(p`/api/orgs/${orgId}/teams/${t}/members/${userId}`); } catch (err) {
              if (!(err instanceof ApiError && err.code === 'not_found')) problems.push(friendly(err).message);
            }
          }
          if (isMe && roleChanged) {
            closeModal();
            await loadMe();
            toast('Your role changed');
            navigate(orgBase(orgId) + '/members', { replace: true });
            return;
          }
          await reloadMembers();
          if (!ctx.alive()) return;
          paint();
          if (problems.length) {
            setHtml(errBox, html`<div class="banner amber" role="alert">${icon('alert')}<div class="grow">${problems.map((x) => html`<div>${x}</div>`)}</div></div>`);
            return;
          }
          closeModal();
          toast(roleChanged || add.length || drop.length ? `Saved changes for ${nameOf(mb)}` : 'Nothing changed');
        });
      });

      $('#mg-rm', m).addEventListener('click', async () => {
        const ok = await confirmModal(isMe
          ? { title: 'Leave org', body: html`You lose access to <b>${orgName}</b> and its instances right away. An admin has to invite you again to come back.`, action: 'Leave org' }
          : { title: 'Remove from org', body: html`<b>${nameOf(mb)}</b> loses access to ${orgName} and its instances. Open instance tabs stop working within a minute. You can invite them again later.`, action: 'Remove' });
        if (!ok) return;
        await busy(null, async () => {
          try {
            await api.del(p`/api/orgs/${orgId}/members/${userId}`);
          } catch (err) {
            // Refused: back in the person's dialog, which says why.
            if (err instanceof ApiError && err.code === 'last_tenant_admin') return void openManage(userId, { lastAdmin: true });
            if (err instanceof ApiError && err.code === 'not_found') { await reloadMembers(); paint(); return; }
            throw friendly(err);
          }
          if (isMe) {
            await loadMe();
            toast(`You left ${orgName}`);
            navigate('/', { replace: true });
            return;
          }
          await reloadMembers();
          if (!ctx.alive()) return;
          paint();
          toast(`${nameOf(mb)} removed from ${orgName}`);
        });
      });
    }
  },
};

// ---- teams --------------------------------------------------------------------------------------

function teamCard(orgId, t, people, instances, admin) {
  return html`<a class="card ppl-team" href="${teamHref(orgId, t.id)}" data-team="${t.id}">
    <div class="between"><b class="ppl-team-name">${teamLabel(t)}</b><span class="flex ppl-team-r">${t.mine ? html`<span class="pill green">Yours</span>` : ''}${icon('chev')}</span></div>
    <div class="flex ppl-team-people">${people.length ? avatarStack(people) : ''}<span class="muted">${plural(t.members, 'person', 'people')}</span></div>
    ${instances
      ? html`<div class="flex ppl-pills">${instances.length ? instances.map(instPill) : html`<span class="muted">${admin ? 'No instances yet' : 'No instances'}</span>`}</div>`
      : ''}
  </a>`;
}

const teams = {
  path: '/o/:orgId/teams',
  nav: 'teams',
  title: 'Teams',
  async render(ctx) {
    const admin = isAdminRole(ctx.org.role);
    const orgId = ctx.orgId;
    const orgName = ctx.org.name || 'this org';
    const [t, mem, mine, insts] = await Promise.all([
      api.get(p`/api/orgs/${orgId}/teams`),
      api.get(p`/api/orgs/${orgId}/members`),
      admin ? null : api.get(p`/api/orgs/${orgId}/teams/mine`),
      instancesById(orgId),
    ]);
    if (!ctx.alive()) return;
    const all = t.teams || [];
    const people = mem.members || [];
    const peopleOf = (id) => people.filter((m) => (m.teams || []).some((x) => x.id === id));
    const instOf = (ids) => (ids || []).map((id) => insts.get(id)).filter(Boolean);

    if (admin) {
      ctx.set(html`<div class="page">
        <div class="head"><div><h1>Teams</h1><p>Teams decide who reaches which instance. A person can be in several teams.</p></div>
          <div class="acts"><button class="btn primary" id="new-team">${icon('plus')}New team</button></div></div>
        ${all.length
          ? html`<div class="grid g2">${all.map((x) => teamCard(orgId, x, peopleOf(x.id), instOf(x.instanceIds), true))}</div>`
          : html`<div class="card"><div class="empty">No teams yet. Instances belong to teams: people reach an instance through a team they're in. Create one, add people to it, then create instances in it.
              <div class="ppl-empty-act"><button class="btn sm" id="new-team-2">${icon('plus')}New team</button></div></div></div>`}
      </div>`);
      const create = (e) => busy(e.currentTarget, async () => {
        const name = await askName({ title: 'New team', label: 'Name', action: 'Create team', hint: 'For example the group of people who work on the same projects.' });
        if (!name) return;
        const { id } = await api.post(p`/api/orgs/${orgId}/teams`, { name }).catch((err) => { throw friendly(err); });
        toast(`Team ${name} created`);
        navigate(teamHref(orgId, id));
      });
      $('#new-team', ctx.el).addEventListener('click', create);
      $('#new-team-2', ctx.el)?.addEventListener('click', create);
      return;
    }

    const myTeams = mine.teams || [];
    const admins = people.filter((m) => isAdminRole(m.role));
    ctx.set(html`<div class="page">
      <div class="head"><div><h1>Teams</h1><p>Teams decide who reaches which instance. Admins decide who's in which.</p></div></div>
      <section class="stack" aria-labelledby="your-teams">
        <div class="label" id="your-teams">Your teams</div>
        ${myTeams.length
          ? html`<div class="rows">${myTeams.map((x) => {
              const list = instOf(x.instanceIds);
              return html`<a class="row click" href="${teamHref(orgId, x.id)}"><span class="g slate">${icon('team')}</span><div class="t"><b>${teamLabel(x)}</b>
                <span>${list.length ? list.map((i) => i.name || 'Unnamed instance').join(', ') : 'No instances yet'}</span></div><div class="r">${plural(x.members, 'person', 'people')}${icon('chev')}</div></a>`;
            })}</div>`
          : html`<div class="card"><div class="empty">You're not in a team yet, so you can't open any instance of ${orgName}. Ask an admin to add you to one.</div></div>`}
      </section>
      <section class="stack" aria-labelledby="all-teams">
        <div class="label" id="all-teams">All teams in ${orgName}</div>
        ${all.length ? html`<div class="grid g2">${all.map((x) => teamCard(orgId, x, peopleOf(x.id), null, false))}</div>` : html`<div class="card"><div class="empty">No teams yet.</div></div>`}
      </section>
      ${admins.length ? html`<section class="stack" aria-labelledby="org-admins"><div class="label" id="org-admins">Admins of ${orgName}</div>
        <div class="rows">${admins.map((m) => html`<div class="row"><span class="av">${initials(m.name || m.email)}</span><div class="t"><b>${nameOf(m)}</b><span>${m.email || ''}</span></div></div>`)}</div></section>` : ''}
    </div>`);
  },
};

// ---- team detail --------------------------------------------------------------------------------

const team = {
  path: '/o/:orgId/teams/:teamId',
  nav: 'teams',
  title: 'Team',
  async render(ctx) {
    const admin = isAdminRole(ctx.org.role);
    const orgId = ctx.orgId;
    const teamId = ctx.params.teamId;
    const orgName = ctx.org.name || 'this org';
    const el = ctx.el;
    const S = { team: null, members: [], directory: [], insts: new Map(), grants: null };

    async function load() {
      const [t, mem, insts, mine, tm] = await Promise.all([
        api.get(p`/api/orgs/${orgId}/teams`),
        api.get(p`/api/orgs/${orgId}/members`),
        instancesById(orgId),
        admin ? null : api.get(p`/api/orgs/${orgId}/teams/mine`),
        admin ? api.get(p`/api/orgs/${orgId}/teams/${teamId}/members`).catch((e) => { if (e instanceof ApiError && e.code === 'not_found') return null; throw e; }) : null,
      ]);
      S.team = (t.teams || []).find((x) => x.id === teamId) || null;
      S.directory = mem.members || [];
      S.insts = insts;
      if (admin) {
        S.members = tm?.members || [];
        S.grants = new Set(S.team?.instanceIds || []);
      } else {
        S.members = S.directory.filter((m) => (m.teams || []).some((x) => x.id === teamId));
        const my = (mine.teams || []).find((x) => x.id === teamId);
        S.grants = my ? new Set(my.instanceIds || []) : null; // instances only of one's own teams
      }
    }
    await load();
    if (!ctx.alive()) return;
    if (!S.team) {
      ctx.set(html`<div class="page narrow"><div><div class="crumb"><a href="${orgBase(orgId) + '/teams'}">Teams</a>${icon('chev')}<span>Not found</span></div>
        <div class="head"><div><h1>Team not found</h1><p>It may have been deleted.</p></div></div></div>
        <div><a class="btn" href="${orgBase(orgId) + '/teams'}">${icon('team')}All teams</a></div></div>`);
      return;
    }
    document.title = `${teamLabel(S.team)} · ${brand.product}`;

    function paint() {
      const t = S.team;
      const granted = S.grants ? [...S.grants].map((id) => S.insts.get(id)).filter(Boolean) : null;
      const allInsts = [...S.insts.values()];
      const newInTeam = p`/o/${orgId}/instances/new?team=${teamId}`;
      const peopleRows = S.members.length
        ? S.members.map((m) => html`<div class="row"><span class="av">${initials(m.name || m.email)}</span><div class="t"><b>${nameOf(m)}${m.userId === ctx.me.user.id ? html` <span class="muted ppl-you">(you)</span>` : ''}</b><span>${m.email || ''}</span></div>
            <div class="r">${m.addedAt ? html`<span class="ppl-added" title="${dateTime(m.addedAt)}">Added ${relTime(m.addedAt)}</span>` : ''}${admin ? html`<button class="btn sm ghost" data-remove="${m.userId}" aria-label="Remove ${nameOf(m)} from ${teamLabel(t)}">Remove</button>` : ''}</div></div>`)
        : html`<div class="empty">No one in this team yet.${admin ? ' Add people so they can reach its instances.' : ''}</div>`;
      let instBody;
      if (admin) {
        instBody = allInsts.length
          ? html`<div class="rows">${allInsts.map((i) => html`<label class="row ppl-grant" for="ti-${i.id}">${glyph(shownStatus(i))}<div class="t"><b>${i.name || 'Unnamed instance'}</b><span class="mono">${i.host || ''}</span></div>
              <div class="r"><span class="switch"><input type="checkbox" id="ti-${i.id}" data-grant="${i.id}" ${S.grants.has(i.id) ? 'checked' : ''} aria-label="${teamLabel(t)} can use ${i.name || 'this instance'}"><i></i></span></div></label>`)}</div>
              <p class="hint">People who lose access are signed out of the instance within a minute.</p>`
          : html`<div class="empty">No instances in ${orgName} yet. <a href="${newInTeam}">Create one in this team</a></div>`;
      } else if (granted) {
        instBody = granted.length
          ? html`<div class="rows">${granted.map((i) => html`<div class="row">${glyph(shownStatus(i))}<div class="t"><b>${i.name || 'Unnamed instance'}</b><span class="mono">${i.host || ''}</span></div></div>`)}</div>`
          : html`<div class="empty">This team doesn't grant any instance yet.</div>`;
      } else {
        instBody = html`<div class="empty">You're not in this team, so its instances aren't listed here.</div>`;
      }
      const counts = [plural(S.members.length, 'person', 'people')];
      if (granted) counts.push(plural(granted.length, 'instance'));
      setHtml(el, html`<div class="page narrow">
        <div><div class="crumb"><a href="${orgBase(orgId) + '/teams'}">Teams</a>${icon('chev')}<span>${teamLabel(t)}</span></div>
          <div class="head"><div><h1>${teamLabel(t)}</h1><p>${counts.join(' · ')}${!admin && t.mine ? ' · You are in this team' : ''}</p></div>
            ${admin ? html`<div class="acts"><button class="btn" id="rename">Rename</button><button class="btn danger" id="del-team">${icon('trash')}Delete team</button></div>` : ''}</div></div>
        <div class="card"><div class="card-head"><h2>People</h2>${admin ? html`<button class="btn sm" id="add-person">${icon('plus')}Add</button>` : ''}</div>
          <div class="list">${peopleRows}</div></div>
        <div class="card"><div class="card-head"><h2>Instances</h2>${admin ? html`<span class="sub">Members of the team can open the instances switched on</span><a class="btn sm" id="new-inst" href="${newInTeam}">${icon('plus')}New instance in this team</a>` : ''}</div>${instBody}</div>
      </div>`);
      if (admin) bind();
    }

    async function reload() {
      await load();
      if (!ctx.alive()) return;
      if (!S.team) { navigate(orgBase(orgId) + '/teams', { replace: true }); return; }
      paint();
    }

    function bind() {
      const t = S.team;
      $('#rename', el).addEventListener('click', (e) => busy(e.currentTarget, async () => {
        const name = await askName({ title: 'Rename team', label: 'Name', value: t.name || '', action: 'Rename' });
        if (!name || name === t.name) return;
        await api.patch(p`/api/orgs/${orgId}/teams/${teamId}`, { name }).catch((err) => { throw friendly(err, { not_found: 'This team no longer exists.' }); });
        toast(`Renamed to ${name}`);
        await reload();
      }));

      $('#del-team', el).addEventListener('click', (e) => busy(e.currentTarget, async () => {
        // D71: instances whose only team this is would be left without one; the API refuses too.
        const sole = [...S.grants].map((id) => S.insts.get(id)).filter((i) => i && i.status !== 'deleting' && (i.teamIds || []).every((x) => x === teamId));
        if (sole.length) return soleModal(sole.length, sole);
        const n = S.grants.size;
        const consequence = html`<b>${plural(S.members.length, 'person', 'people')}</b> ${S.members.length === 1 ? 'loses' : 'lose'} the access this team gives to ${plural(n, 'instance')}. People who reach an instance through another team keep it. The people stay in ${orgName}.`;
        // A team whose name can't be read can't be typed: confirm it plainly.
        if (!t.name && !(await confirmModal({ title: 'Delete team', body: consequence, action: 'Delete team' }))) return;
        const res = await protectedAction({
          title: 'Delete team',
          consequence,
          name: t.name || undefined,
          typed: !!t.name,
          actionLabel: 'Delete team',
          call: () => api.raw('DELETE', p`/api/orgs/${orgId}/teams/${teamId}`),
        }).catch((err) => {
          if (err instanceof ApiError && err.code === 'not_found') return { status: 200 };
          if (err instanceof ApiError && err.code === 'team_has_instances') { closeModal(); soleModal(err.body.instances || 1, []); return null; }
          throw err;
        });
        if (!res) return;
        toast(`Team ${teamLabel(t)} deleted`);
        navigate(orgBase(orgId) + '/teams', { replace: true });
      }));

      /** Explains why the team can't be deleted yet (D71). */
      function soleModal(count, list) {
        openModal(html`<h2>${teamLabel(t)} can't be deleted yet</h2>
          <p>It is the only team of ${plural(count, 'instance')}${list.length ? html`: ${list.map((i, k) => html`${k ? ', ' : ''}<b>${i.name || 'Unnamed instance'}</b>`)}` : ''}. An instance always keeps at least one team. Give ${count === 1 ? 'it' : 'them'} another team first, or delete ${count === 1 ? 'it' : 'them'}.</p>
          <div class="acts"><button class="btn primary" data-close>OK</button></div>`);
      }

      $('#add-person', el).addEventListener('click', () => {
        const inTeam = new Set(S.members.map((m) => m.userId));
        const candidates = S.directory.filter((m) => !inTeam.has(m.userId));
        const m = openModal(html`<h2>Add to ${teamLabel(t)}</h2>
          ${candidates.length
            ? html`<form class="form" id="ap-form" novalidate>
                <div class="field"><label for="ap-who">Person</label><select class="inp" id="ap-who">${candidates.map((c) => html`<option value="${c.userId}">${nameOf(c)}${c.name && c.email ? ` · ${c.email}` : ''}</option>`)}</select>
                  <span class="hint">They can open this team's instances right away.</span></div>
                <div class="acts"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" id="ap-go">Add</button></div></form>`
            : html`<p>Everyone in ${orgName} is already in this team.</p><div class="acts"><a class="btn" href="${orgBase(orgId) + '/members'}">Invite people</a><button class="btn primary" data-close>Close</button></div>`}`);
        for (const a of $$('a', m)) a.addEventListener('click', () => closeModal());
        $('#ap-form', m)?.addEventListener('submit', (e) => {
          e.preventDefault();
          busy($('#ap-go', m), async () => {
            const userId = $('#ap-who', m).value;
            const who = candidates.find((c) => c.userId === userId);
            try {
              await api.post(p`/api/orgs/${orgId}/teams/${teamId}/members`, { userId });
            } catch (err) {
              if (!(err instanceof ApiError && err.code === 'already_member')) throw friendly(err, { not_found: 'This team no longer exists.' });
            }
            closeModal();
            toast(`Added ${who ? nameOf(who) : 'them'} to ${teamLabel(t)}`);
            await reload();
          });
        });
      });

      for (const b of $$('[data-remove]', el)) {
        b.addEventListener('click', async () => {
          const who = S.members.find((x) => x.userId === b.dataset.remove);
          const ok = await confirmModal({
            title: 'Remove from team',
            body: html`<b>${who ? nameOf(who) : 'This person'}</b> loses the access ${teamLabel(t)} gives. Instances they reach through another team stay open to them.`,
            action: 'Remove',
          });
          if (!ok) return;
          await busy(b, async () => {
            try {
              await api.del(p`/api/orgs/${orgId}/teams/${teamId}/members/${b.dataset.remove}`);
            } catch (err) {
              if (!(err instanceof ApiError && err.code === 'not_found')) throw friendly(err);
            }
            toast(`Removed ${who ? nameOf(who) : 'them'} from ${teamLabel(t)}`);
            await reload();
          });
        });
      }

      for (const sw of $$('[data-grant]', el)) {
        sw.addEventListener('change', () => {
          const id = sw.dataset.grant;
          const inst = S.insts.get(id);
          const on = sw.checked;
          if (!on && inst && (inst.teamIds || []).every((x) => x === teamId)) {
            sw.checked = true; // D71: its only team; the API would refuse
            toast(ERRORS.last_team, 'error');
            return;
          }
          sw.disabled = true;
          busy(null, async () => {
            try {
              if (on) {
                await api.post(p`/api/orgs/${orgId}/teams/${teamId}/instances/${id}`);
                S.grants.add(id);
                if (inst) inst.teamIds = [...new Set([...(inst.teamIds || []), teamId])]; // the switch shows it
              } else {
                const r = await api.del(p`/api/orgs/${orgId}/teams/${teamId}/instances/${id}`);
                S.grants.delete(id);
                if (inst) inst.teamIds = (inst.teamIds || []).filter((x) => x !== teamId);
                // The switch shows the new state; a toast only for what it doesn't show.
                if (r.droppedUsers) toast(`${plural(r.droppedUsers, 'person', 'people')} signed out of ${inst?.name || 'the instance'}`, 'info');
              }
            } catch (err) {
              sw.checked = !on;
              throw friendly(err, { not_found: 'This team no longer exists.' });
            } finally {
              sw.disabled = false;
            }
            const head = $('.head p', el);
            if (head) head.textContent = `${plural(S.members.length, 'person', 'people')} · ${plural(S.grants.size, 'instance')}`;
          });
        });
      }
    }

    paint();
  },
};

export default [members, teams, team];
