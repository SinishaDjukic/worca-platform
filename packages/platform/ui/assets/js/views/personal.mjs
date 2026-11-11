// Personal area: Home (every instance the person can open, across all their orgs), Welcome (no org
// yet: create one, see pending invitations) and the waitlist page. docs/ui.md "Personal".
import {
  api, html, icon, p, busy, toast, navigate, loadMe, isStaff, initials, plural, relTime, errorText, setHtml, $,
  glyph, shownStatus, statusLine, ApiError, brand,
} from '../core.mjs';

const ROLE_LABEL = { tenant_admin: 'Tenant admin', tenant_user: 'Tenant user' };
const roleLabel = (role) => String(role || '').split(',').map((r) => ROLE_LABEL[r.trim()] || r.trim()).join(', ');
const isAdminRole = (role) => String(role || '').split(',').map((r) => r.trim()).includes('tenant_admin');
/** States in which the instance can't be opened (the gate would only show an error). */
const CLOSED = new Set(['creating', 'deleting', 'stopped', 'failed']);
/** States that change soon on their own: poll faster. */
const MOVING = new Set(['creating', 'upgrading', 'deleting']);
const orgHref = (id) => p`/o/${id}`;
const firstName = (me) => String(me.user.name || '').trim().split(/\s+/)[0] || '';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// ---- Home ---------------------------------------------------------------------------------------

function openButton(inst) {
  const st = shownStatus(inst);
  const label = inst.status === 'suspended' ? 'Wake and open' : 'Open';
  if (CLOSED.has(inst.status) || !inst.url) {
    return html`<button class="btn sm" disabled aria-label="${label} ${inst.name || ''} (not available while ${st})">${icon('ext')}${label}</button>`;
  }
  const primary = inst.status === 'running' || inst.status === 'upgrading';
  return html`<a class="btn sm${primary ? ' primary' : ''}" href="${inst.url}" data-external aria-label="${label} ${inst.name || 'instance'}">${icon('ext')}${label}</a>`;
}

function instanceLine(inst) {
  const st = shownStatus(inst);
  const running = inst.pipelines && typeof inst.pipelines.running === 'number' ? inst.pipelines.running : null;
  const live = inst.status === 'running' && running !== null;
  return html`${statusLine(st) || st}${live ? html` · <span class="muted">${plural(running, 'pipeline')} running</span>` : ''}`;
}

function instanceCard(inst) {
  const st = shownStatus(inst);
  const teams = (inst.teams || []).map((t) => t.name).filter(Boolean);
  return html`<article class="card home-inst" data-instance="${inst.id}">
    <div class="home-inst-top">${glyph(st, true)}<div class="home-inst-id"><b>${inst.name || 'Unnamed instance'}</b><div class="mono muted">${inst.host || ''}</div></div></div>
    <div class="home-inst-line ink2">${instanceLine(inst)}</div>
    <div class="between home-inst-foot"><span class="muted home-inst-teams">${teams.length ? teams.join(', ') : 'No teams yet'}</span>${openButton(inst)}</div>
  </article>`;
}

function orgEmpty(org) {
  if (isAdminRole(org.role)) {
    return html`<div class="card home-empty"><div class="empty">No instances in ${org.name || 'this org'} yet.
      <div class="home-empty-act"><a class="btn sm" href="${orgHref(org.id) + '/instances/new'}">${icon('plus')}New instance</a></div></div></div>`;
  }
  return html`<div class="card home-empty"><div class="empty">None of your teams in ${org.name || 'this org'} has an instance yet. Ask one of its admins if you need one.</div></div>`;
}

function orgGroup(org, res, grouped) {
  let body;
  if (res.error) {
    body = html`<div class="banner amber">${icon('alert')}<div class="grow">Couldn't load the instances of ${org.name || 'this org'}: ${errorText(res.error)}</div></div>`;
  } else if (!res.instances.length) {
    body = orgEmpty(org);
  } else {
    body = html`<div class="grid g2">${res.instances.map(instanceCard)}</div>`;
  }
  if (!grouped) return body;
  return html`<section class="home-org" aria-labelledby="org-${org.id}">
    <div class="home-org-head"><a class="home-org-link" href="${orgHref(org.id)}" id="org-${org.id}"><span class="av">${initials(org.name)}</span><span class="t"><b>${org.name || 'Unnamed org'}</b><span>${roleLabel(org.role)}${res.instances ? html` · ${plural(res.instances.length, 'instance')}` : ''}</span></span>${icon('chev')}</a></div>
    ${body}</section>`;
}

function summaryLine(orgs, results) {
  const all = results.flatMap((r) => r.instances || []);
  const running = all.reduce((n, i) => n + (i.status === 'running' && i.pipelines && typeof i.pipelines.running === 'number' ? i.pipelines.running : 0), 0);
  const where = orgs.length === 1 ? html`in ${orgs[0].name || 'your org'}` : html`across ${plural(orgs.length, 'org')}`;
  return html`${plural(all.length, 'instance')} ${where}${running ? html` · <b>${plural(running, 'pipeline')} running</b>` : ''}`;
}

async function loadAll(orgs) {
  return Promise.all(orgs.map(async (o) => {
    try {
      const { instances } = await api.get(p`/api/orgs/${o.id}/instances`);
      return { instances: instances || [] };
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) throw error;
      return { error, instances: null };
    }
  }));
}

function staffNoOrg(ctx) {
  const name = firstName(ctx.me);
  ctx.set(html`<div class="page narrow">
    <div class="head"><div><h1>${greeting()}${name ? `, ${name}` : ''}</h1><p>You're not a member of any org, so there are no instances to open here.</p></div></div>
    <div class="card stack">
      <div class="flex home-staff"><span class="g violet lg">${icon('crown')}</span><div class="t"><b>Platform console</b><div class="ink2">Orgs, instances, registration and the system are in the console.</div></div></div>
      <div class="flex"><a class="btn primary" href="/platform">${icon('crown')}Open the platform console</a><a class="btn" href="/welcome">${icon('plus')}Create an org</a></div>
    </div></div>`);
}

const home = {
  path: '/',
  nav: 'home',
  title: 'Home',
  guard: (ctx) => (!(ctx.me.orgs || []).length && !isStaff() ? '/welcome' : null),
  async render(ctx) {
    const orgs = ctx.me.orgs || [];
    if (!orgs.length) return staffNoOrg(ctx);
    const grouped = orgs.length > 1;
    const name = firstName(ctx.me);
    let results = await loadAll(orgs);
    if (!ctx.alive()) return;
    const single = orgs.length === 1 ? orgs[0] : null;
    ctx.set(html`<div class="page">
      <div class="head"><div><h1>${greeting()}${name ? `, ${name}` : ''}</h1><p id="home-sum">${summaryLine(orgs, results)}</p></div>
        ${single && isAdminRole(single.role) ? html`<div class="acts"><a class="btn" href="${orgHref(single.id) + '/instances/new'}">${icon('plus')}New instance</a></div>` : ''}</div>
      <div class="stack home-list" id="home-list"></div>
    </div>`);
    const paint = () => {
      const list = $('#home-list', ctx.el);
      if (!list) return;
      setHtml(list, html`${orgs.map((o, k) => orgGroup(o, results[k], grouped))}`);
      setHtml($('#home-sum', ctx.el), summaryLine(orgs, results));
    };
    paint();
    // 5 s while something is in progress, 30 s otherwise (ui/README "Live status").
    let last = Date.now();
    let inFlight = false;
    ctx.poll(async () => {
      const moving = results.some((r) => (r.instances || []).some((i) => MOVING.has(i.status) || (i.op && i.op.status === 'running')));
      if (inFlight || Date.now() - last < (moving ? 5000 : 30000) - 250) return;
      inFlight = true;
      try {
        const next = await loadAll(orgs);
        if (!ctx.alive()) return;
        results = next;
        paint();
      } catch { /* keep what is shown; the next tick tries again */ } finally {
        last = Date.now();
        inFlight = false;
      }
    }, 5000);
  },
};

// ---- Welcome (no org yet) -------------------------------------------------------------------------

const CREATE_ERRORS = {
  invalid_body: 'Give the org a name of 1 to 100 characters.',
  account_not_active: "Your account isn't active yet, so it can't create an org.",
  forbidden: "Your account can't create an org. Ask the Worca team, or join an org through an invitation.",
};

function invitationRows(invitations) {
  if (invitations === null) return html`<div class="empty">Couldn't load your invitations. <button class="linkbtn" id="inv-retry">Try again</button></div>`;
  if (!invitations.length) return html`<div class="empty">No invitations for you right now. When someone invites you to their org, it shows up here and in your email.</div>`;
  return html`<div class="rows">${invitations.map((inv) => html`<div class="row welcome-inv" data-invitation="${inv.id}">
    <span class="av welcome-org-av">${initials(inv.organizationName)}</span>
    <div class="t"><b>${inv.organizationName || 'An org'}</b><span>As ${roleLabel(inv.role).toLowerCase()} · expires ${relTime(inv.expiresAt)}</span></div>
    <div class="r"><a class="btn sm primary" href="${p`/invite/${inv.id}`}" data-external>Accept${icon('chev')}</a></div></div>`)}</div>`;
}

const welcome = {
  path: '/welcome',
  nav: 'home',
  title: 'Welcome',
  async render(ctx) {
    const hasOrgs = (ctx.me.orgs || []).length > 0;
    const name = firstName(ctx.me);
    let invitations = null;
    try {
      const list = await api.get('/api/auth/organization/list-user-invitations');
      const now = Date.now();
      invitations = (Array.isArray(list) ? list : []).filter((i) => i.status === 'pending' && Date.parse(i.expiresAt) > now);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) throw e;
      invitations = null;
    }
    if (!ctx.alive()) return;
    ctx.set(html`<div class="page narrow">
      <div class="head"><div>
        <h1>${hasOrgs ? 'Create an org' : html`Welcome${name ? `, ${name}` : ''}`}</h1>
        <p>${hasOrgs
          ? 'An org holds your instances, people and teams. You become its first admin.'
          : "You're not in an org yet. Start your own, or accept an invitation to join one."}</p></div></div>
      ${isStaff() && !hasOrgs ? html`<div class="banner blue">${icon('info')}<div class="grow">You're platform staff. The <a href="/platform">platform console</a> doesn't need an org.</div></div>` : ''}
      <section class="card" aria-labelledby="inv-h">
        <div class="card-head"><h2 id="inv-h">Invitations</h2>${invitations && invitations.length ? html`<span class="sub">${plural(invitations.length, 'invitation')}</span>` : ''}</div>
        <div id="inv-list">${invitationRows(invitations)}</div>
      </section>
      <section class="card" aria-labelledby="new-h">
        <div class="card-head"><h2 id="new-h">${hasOrgs ? 'New org' : 'Start your own org'}</h2></div>
        <form class="form" id="org-form" novalidate>
          <div class="field"><label for="org-name">Org name</label>
            <input class="inp" id="org-name" name="name" maxlength="100" autocomplete="organization" required aria-describedby="org-hint">
            <span class="hint" id="org-hint">Usually your company or team. You can rename it later.</span></div>
          <div><button class="btn primary" type="submit" id="org-go">${icon('plus')}Create org</button></div>
        </form>
      </section>
    </div>`);
    $('#inv-retry', ctx.el)?.addEventListener('click', () => ctx.refresh());
    const form = $('#org-form', ctx.el);
    const input = $('#org-name', form);
    const hint = $('#org-hint', form);
    const setHint = (text, err) => {
      hint.textContent = text;
      hint.classList.toggle('err', !!err);
      input.setAttribute('aria-invalid', err ? 'true' : 'false');
    };
    input.addEventListener('input', () => { if (hint.classList.contains('err')) setHint('Usually your company or team. You can rename it later.', false); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = input.value.trim();
      if (!value) {
        setHint('Give the org a name.', true);
        input.focus();
        return;
      }
      busy($('#org-go', form), async () => {
        try {
          const { id } = await api.post('/api/orgs', { name: value });
          await loadMe();
          toast(`Created ${value}`);
          navigate(orgHref(id));
        } catch (err) {
          if (err instanceof ApiError && CREATE_ERRORS[err.code]) {
            setHint(CREATE_ERRORS[err.code], true);
            input.focus();
            return;
          }
          throw err;
        }
      });
    });
    if (!hasOrgs && !(invitations && invitations.length)) input.focus();
  },
};

// ---- Waiting for approval (waitlist) ------------------------------------------------------------------

const pending = {
  path: '/pending',
  nav: 'home',
  title: 'Waiting for approval',
  bare: true,
  guard: (ctx) => (ctx.me.user.status === 'pending' ? null : '/'),
  async render(ctx) {
    ctx.set(html`<div class="page narrow"><div class="card stack center pending-card">
      <span class="logo pending-logo" role="img" aria-label="${brand.product}"></span>
      <span class="g blue lg">${icon('history')}</span>
      <h1 class="pending-h">Waiting for approval</h1>
      <p class="ink2 pending-p">Worca is letting people in a few at a time. Your account <b>${ctx.me.user.email}</b> is on the list, and we'll email you as soon as it's approved.</p>
      <p class="muted pending-p">Invited to an org? Open the link in your invitation email; it lets you in right away.</p>
      <div class="flex pending-acts">
        <button class="btn" id="pending-check">${icon('refresh')}Check again</button>
        <form method="post" action="/sign-out" class="navform"><button class="btn ghost" type="submit">${icon('logout')}Sign out</button></form>
      </div></div></div>`);
    $('#pending-check', ctx.el).addEventListener('click', (e) => busy(e.currentTarget, async () => {
      const me = await loadMe();
      if (me.user.status === 'pending') toast('Still waiting. We will email you.', 'info');
      else navigate((me.orgs || []).length ? '/' : '/welcome', { replace: true });
    }));
  },
};

export default [home, welcome, pending];
