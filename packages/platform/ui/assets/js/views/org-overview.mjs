// /o/:orgId — the org home. Tenant admins get the Overview (GET /summary, the instances, the last
// audit entries): things that need them first, then the numbers. Until the org has a team and an
// instance, a "Get started" checklist leads: the first team, then the first instance in it (D71). Tenant users get the instances
// their teams grant them, as cards with an Open button, and which teams give them that access.
import { api, brand, html, icon, p, STATUS, glyph, statusPill, shownStatus, statusLine, relTime, plural, dateTime, SIGN_IN_METHOD } from '../core.mjs';
import { bindFirstTeam, newInstanceAction, teamPills, TEAMS_FIRST } from './instances.mjs';

const TRANSITIONAL = new Set(['creating', 'upgrading', 'deleting']);
const isBusy = (i) => TRANSITIONAL.has(i.status) || i.op?.status === 'running';
const CANT_OPEN = new Set(['creating', 'deleting', 'stopped', 'failed']);
const DAY_MS = 86_400_000;
const statusLabel = (st) => (STATUS[st]?.label || st || 'unknown').toLowerCase();

/**
 * Re-renders every 5 s while something is in progress, every 30 s otherwise. `load` fetches and
 * returns { markup, busy }; the page is only replaced when the markup changed (keeps focus).
 */
function live(ctx, load) {
  let last = '';
  let busy = false;
  let since = 0;
  const show = async () => {
    const out = await load();
    if (!ctx.alive() || !out) return;
    busy = out.busy;
    since = Date.now();
    const s = String(out.markup);
    if (s !== last) {
      last = s;
      ctx.set(out.markup);
    }
  };
  ctx.poll(() => {
    if (busy || Date.now() - since >= 30_000 - 500) show().catch(() => { /* keep what is shown; next tick retries */ });
  }, 5_000);
  return show;
}

// ---- tenant users ---------------------------------------------------------------------------

/** One instance as a card (same look as Home): status, host, a line, teams, Open. */
export function instanceCard(i) {
  const st = shownStatus(i);
  const running = i.pipelines?.running || 0;
  const label = i.status === 'suspended' ? 'Wake and open' : 'Open';
  const open = CANT_OPEN.has(i.status) || !i.url
    ? html`<button class="btn sm" disabled aria-label="${label} ${i.name || ''} (not available while ${statusLabel(st)})">${icon('ext')}${label}</button>`
    : html`<a class="btn sm${i.status === 'running' || i.status === 'upgrading' ? ' primary' : ''}" href="${i.url}" data-external aria-label="${label} ${i.name || 'instance'}">${icon('ext')}${label}</a>`;
  const teams = (i.teams || []).map((t) => t.name).filter(Boolean);
  return html`<article class="card ov-card" data-instance="${i.id}">
    <div class="ov-top">${glyph(st, true)}<div class="ov-id"><b class="ov-name">${i.name || 'Unnamed instance'}</b><div class="mono muted ov-host">${i.host}</div></div></div>
    <div class="ink2 ov-line">${statusLine(st)}${i.status === 'running' && running ? html` · <span class="muted">${plural(running, 'pipeline')} running</span>` : ''}</div>
    <div class="between"><span class="muted ov-teams">${teams.length ? teams.join(', ') : 'No teams yet'}</span>${open}</div>
  </article>`;
}

const andList = (items) => (items.length <= 1 ? items : [...items.slice(0, -1).flatMap((x, n) => (n ? [', ', x] : [x])), ' and ', items[items.length - 1]]);

async function renderUser(ctx) {
  const orgName = ctx.org.name || 'this org';
  document.title = `Instances · ${brand.product}`;
  const show = live(ctx, async () => {
    const [{ instances }, mine] = await Promise.all([
      api.get(p`/api/orgs/${ctx.orgId}/instances`),
      api.get(p`/api/orgs/${ctx.orgId}/teams/mine`).catch(() => null),
    ]);
    const list = instances.filter((i) => i.status !== 'deleting');
    const granting = (mine?.teams || []).filter((t) => t.instanceIds?.length);
    const teamNames = granting.map((t) => html`<b>${t.name || 'Unnamed team'}</b>`);
    let banner = '';
    if (list.length && granting.length) {
      banner = html`<div class="banner blue">${icon('info')}<div class="grow">You see the instances your ${granting.length === 1 ? 'team uses' : 'teams use'}: ${andList(teamNames)}. Ask an admin of ${orgName} if you need another.</div></div>`;
    } else if (list.length) {
      banner = html`<div class="banner blue">${icon('info')}<div class="grow">You see the instances your teams use. Ask an admin of ${orgName} if you need another.</div></div>`;
    }
    const running = list.reduce((n, i) => n + (i.status === 'running' ? i.pipelines?.running || 0 : 0), 0);
    const empty = html`<div class="card ov-empty"><span class="g slate lg">${icon('server')}</span>
      <h2>No instances for you yet</h2>
      <p class="ink2">${(mine?.teams || []).length
        ? "You see the instances your teams use, and they don't have one yet."
        : "You see the instances your teams use, and you're not in a team yet."} Ask an admin of ${orgName} if you need one.</p>
      <div><a class="btn" href="${p`/o/${ctx.orgId}/teams`}">${icon('team')}Your teams</a></div></div>`;
    return {
      busy: list.some(isBusy),
      markup: html`<div class="page">
        <div class="head"><div><h1>Instances</h1>
          <p>${plural(list.length, 'instance')} in ${orgName}${running ? html` · <b>${plural(running, 'pipeline')} running</b>` : ''}</p></div></div>
        ${banner}
        ${list.length ? html`<div class="grid g2 ov-cards">${list.map(instanceCard)}</div>` : empty}
      </div>`,
    };
  });
  await show();
}

// ---- tenant admins ----------------------------------------------------------------------------

const ROLE_WORD = { tenant_admin: 'an admin', tenant_user: 'a member' };
const METHODS_WORD = { 'email-otp': 'email code', passkey: 'passkey', google: 'Google', microsoft: 'Microsoft', sso: 'SSO' };

/** Plain-language sentence for an org audit entry; unknown actions show the raw action. */
function auditText(e, n) {
  const d = (e.details && typeof e.details === 'object' ? e.details : {});
  const inst = () => html`<b>${n.instance(e.targetId)}</b>`;
  const who = (id) => html`<b>${n.person(id)}</b>`;
  const team = (id) => n.team(id);
  switch (e.action) {
    case 'org.created': return html`Created the org${d.name ? html` <b>${d.name}</b>` : ''}`;
    case 'org.renamed': return d.name ? html`Renamed the org to <b>${d.name}</b>` : 'Renamed the org';
    case 'org.tier_changed': return 'Changed the plan';
    case 'org.key_rotated': return 'Rotated the org data key';
    case 'org.policy_updated': return 'Changed the sign-in policy';
    case 'org.audit_viewed': return 'Looked at the audit log';
    case 'member.role_changed': return html`Made ${who(e.targetId)} ${d.to === 'tenant_admin' ? 'an admin' : 'a member'}`;
    case 'member.removed': return e.actorId && e.actorId === e.targetId ? 'Left the org' : html`Removed ${who(e.targetId)} from the org`;
    case 'invitation.created': return d.email ? html`Invited <b>${d.email}</b>${d.role ? ` as ${ROLE_WORD[d.role] || d.role}` : ''}` : 'Sent an invitation';
    case 'invitation.canceled': return 'Canceled an invitation';
    case 'invitation.resent': return d.email ? html`Resent the invitation to <b>${d.email}</b>` : 'Resent an invitation';
    case 'team.created': return d.name ? html`Created the team <b>${d.name}</b>` : 'Created a team';
    case 'team.renamed': return d.name ? html`Renamed a team to <b>${d.name}</b>` : 'Renamed a team';
    case 'team.deleted': return 'Deleted a team';
    case 'team.member_added': return html`Added ${who(d.userId)} to ${team(e.targetId)}`;
    case 'team.member_removed': return html`Removed ${who(d.userId)} from ${team(e.targetId)}`;
    case 'instance.create_started': return html`Started creating ${inst()}`;
    case 'instance.created': return html`${inst()} is ready`;
    case 'instance.create_failed': return html`Setting up ${inst()} failed`;
    case 'instance.renamed': return html`Renamed ${inst()}`;
    case 'instance.provider_settings_set': return html`Changed the hosting settings of ${inst()}`;
    case 'instance.teams_changed': return html`Changed which teams use ${inst()}`;
    case 'instance.upgrade_started': return d.direction === 'downgrade' ? html`Started moving ${inst()} back to ${d.to}` : html`Started upgrading ${inst()}${d.to ? ` to ${d.to}` : ''}`;
    case 'instance.upgraded': return html`Upgraded ${inst()}`;
    case 'instance.upgrade_rolled_back': return html`The upgrade of ${inst()} was rolled back`;
    case 'instance.auto_update_set': return d.mode === 'off' ? html`Turned automatic updates of ${inst()} off`
      : html`Set automatic updates of ${inst()} to ${d.mode === 'minor' ? 'micro and minor releases' : 'micro releases'}`;
    case 'instance.suspended': return html`${inst()} fell asleep`;
    case 'instance.delete_started': return html`Started deleting ${inst()}`;
    case 'instance.deleted': return html`Deleted ${inst()}`;
    case 'instance.policy_updated': return html`Changed the sign-in policy of ${inst()}`;
    case 'instance.stopped': return html`Stopped ${inst()}`;
    case 'instance.stop_lifted': return html`Started ${inst()} again`;
    case 'instance.op_restarted': return html`Retried an operation on ${inst()}`;
    case 'instance.rotate_started': return html`Started renewing the credentials of ${inst()}`;
    case 'instance.secrets_rotated': return html`Renewed the credentials of ${inst()}`;
    case 'auth.signed_in': return 'Signed in';
    case 'auth.sign_in_failed': return 'A sign-in failed';
    case 'auth.signed_out': return 'Signed out';
    case 'auth.passkey_added': return 'Added a passkey';
    case 'auth.session_revoked': return 'Ended a session';
    case 'auth.other_sessions_revoked': return 'Signed out on other devices';
    case 'domain.added': return d.domain ? html`Added the domain <b>${d.domain}</b>` : 'Added a domain';
    case 'domain.verified': return d.domain ? html`Verified the domain <b>${d.domain}</b>` : 'Verified a domain';
    case 'domain.verify_failed': return "A domain couldn't be verified";
    case 'domain.removed': return d.domain ? html`Removed the domain <b>${d.domain}</b>` : 'Removed a domain';
    case 'sso.registered': return d.domain ? html`Set up single sign-on for <b>${d.domain}</b>` : 'Set up single sign-on';
    case 'sso.removed': return 'Removed a single sign-on connection';
    case 'confirmation.started': return 'Asked for an email confirmation';
    case 'confirmation.completed': return 'Confirmed a protected action by email';
    case 'user.renamed': return 'Changed their name';
    case 'user.exported': return 'Downloaded their data';
    case 'user.deleted': return 'Deleted their account';
    default: return html`<span class="mono">${e.action}</span>`;
  }
}

function actorName(e, n) {
  if (e.actorScope === 'system' || (!e.actorId && e.actorScope !== 'platform')) return 'System';
  if (e.actorScope === 'platform') return e.actorId ? 'Worca support' : 'Worca';
  const name = n.person(e.actorId);
  return name === 'someone' ? 'Someone' : name === 'a member' ? 'A member' : name;
}

/** Lookups for audit sentences, built from the members and instances lists. */
function namer(members, instances) {
  const people = new Map(), teams = new Map(), insts = new Map();
  for (const m of members || []) {
    people.set(m.userId, m.name || m.email || null);
    for (const t of m.teams || []) if (t.name) teams.set(t.id, t.name);
  }
  for (const i of instances || []) insts.set(i.id, i.name);
  return {
    person: (id) => (id && people.get(id)) || (id && people.has(id) ? 'a member' : 'someone'),
    team: (id) => (teams.has(id) ? html`<b>${teams.get(id)}</b>` : 'a team'),
    instance: (id) => insts.get(id) || 'an instance',
  };
}

function signInSummary(s) {
  const methods = s.allowedMethods || [];
  let v;
  if (s.ssoProviders && methods.length === 1 && methods[0] === 'sso') v = 'SSO only';
  else if (!methods.length) v = 'Any method';
  else if (methods.length <= 2) v = methods.map((m) => METHODS_WORD[m] || SIGN_IN_METHOD[m] || m).join(' + ').replace(/^./, (c) => c.toUpperCase());
  else v = `${methods.length} methods`;
  const sub = [];
  if (s.requiredDomain) sub.push(html`Only <b>@${s.requiredDomain}</b>`);
  else sub.push('Any email address');
  if (s.instanceOverrides) sub.push(html`<b>${s.instanceOverrides}</b> stricter on instances`);
  return { v, sub: sub.flatMap((x, n) => (n ? [' · ', x] : [x])) };
}

function needsYou(ctx, sum, instances, invitations, orgPath) {
  const items = [];
  const instPath = (id) => p`/o/${ctx.orgId}/instances/${id}`;
  for (const i of instances.filter((x) => x.status === 'failed')) {
    items.push(html`<a class="row click" href="${instPath(i.id)}"><span class="g red">${icon('alert')}</span><div class="t"><b>${i.name || 'An instance'} didn't finish setting up</b><span>Delete it, or look at what happened</span></div><div class="r">${icon('chev')}</div></a>`);
  }
  for (const i of instances.filter((x) => x.status === 'stopped')) {
    items.push(html`<a class="row click" href="${instPath(i.id)}"><span class="g red">${icon('stop')}</span><div class="t"><b>${i.name || 'An instance'} was stopped by the platform</b><span>Contact Worca support to have it started again</span></div><div class="r">${icon('chev')}</div></a>`);
  }
  for (const d of sum.instances.degraded || []) {
    const since = d.healthSince ? `Health degraded since ${relTime(d.healthSince)}` : 'Health degraded';
    const beat = d.lastHeartbeatAt ? ` · last heartbeat ${relTime(d.lastHeartbeatAt)}` : '';
    items.push(html`<a class="row click" href="${instPath(d.id)}"><span class="g amber">${icon('alert')}</span><div class="t"><b>${d.name || 'An instance'} reports a problem</b><span>${since}${beat}</span></div><div class="r">${icon('chev')}</div></a>`);
  }
  for (const u of sum.instances.upgradesAvailable || []) {
    items.push(html`<a class="row click" href="${instPath(u.id)}"><span class="g violet">${icon('arrowUp')}</span><div class="t"><b>${u.name || 'An instance'} can upgrade to ${u.availableVersion}</b><span>Upgrades never happen on their own. Pick a quiet moment.</span></div><div class="r">${icon('chev')}</div></a>`);
  }
  const membersPath = `${orgPath}/members`;
  const soon = (invitations || []).filter((v) => !v.expired && Date.parse(v.expiresAt) - Date.now() <= 2 * DAY_MS);
  if (soon.length) {
    for (const v of soon) {
      items.push(html`<a class="row click" href="${membersPath}"><span class="g blue">${icon('mail')}</span><div class="t"><b>Invitation to ${v.email || 'someone'} expires ${relTime(v.expiresAt)}</b><span>Resend it or let it lapse</span></div><div class="r">${icon('chev')}</div></a>`);
    }
  } else if (!invitations && sum.invitations.expiringWithin48h) {
    const n = sum.invitations.expiringWithin48h;
    items.push(html`<a class="row click" href="${membersPath}"><span class="g blue">${icon('mail')}</span><div class="t"><b>${plural(n, 'invitation')} ${n === 1 ? 'expires' : 'expire'} within 2 days</b><span>Resend or let them lapse</span></div><div class="r">${icon('chev')}</div></a>`);
  }
  const lim = sum.instances.limit;
  if (lim && sum.instances.total >= lim) {
    items.push(html`<a class="row click" href="${orgPath}/settings"><span class="g slate">${icon('server')}</span><div class="t"><b>Every instance your plan allows is in use</b><span>${sum.instances.total} of ${lim} · delete one, or ask Worca support for a bigger plan</span></div><div class="r">${icon('chev')}</div></a>`);
  }
  const mlim = sum.members.limit;
  if (mlim && sum.members.count + sum.invitations.open >= mlim) {
    items.push(html`<a class="row click" href="${membersPath}"><span class="g slate">${icon('users')}</span><div class="t"><b>Your plan has no room for more members</b><span>${sum.members.count} of ${mlim} seats taken${sum.invitations.open ? `, ${plural(sum.invitations.open, 'invitation')} open` : ''}</span></div><div class="r">${icon('chev')}</div></a>`);
  }
  return items;
}

/**
 * First-time setup (D71): 1) the first team, with the admin in it, 2) the first instance in it.
 * Shown while either is missing; buttons only, so the 30-second re-render can't eat typing.
 */
function setupCard(ctx, teams, instances) {
  const orgPath = p`/o/${ctx.orgId}`;
  const hasTeam = teams.length > 0;
  const step = (state, title, line, action) => html`<li class="step${state === 'waiting' ? ' wait' : ''}" data-state="${state}">
    ${state === 'done' ? html`<span class="g green">${icon('check')}</span>` : state === 'current' ? html`<span class="g violet">${icon('chev')}</span>` : html`<span class="g slate"><span class="dot ov-dot"></span></span>`}
    <div class="t"><b>${title}</b><span>${line}</span>${action ? html`<div class="ov-step-act">${action}</div>` : ''}</div></li>`;
  const first = teams[0];
  return html`<div class="card" id="setup"><div class="card-head"><h2>Get started</h2><span class="sub">Step ${hasTeam ? 2 : 1} of 2</span></div>
    <p class="ink2 ov-setup-p">${TEAMS_FIRST}</p>
    <ol class="steps ov-steps" aria-label="Setup">
      ${hasTeam
        ? step('done', 'Create the first team', html`${teams.length === 1 ? html`<a href="${p`/o/${ctx.orgId}/teams/${first.id}`}">${first.name || 'Unnamed team'}</a> is ready` : `${plural(teams.length, 'team')} ready`}. Add people to it on its page.`)
        : step('current', 'Create the first team', 'For example the people who work on the same projects. You are added to it.', html`<button type="button" class="btn primary sm" data-first-team>${icon('team')}Create a team</button>`)}
      ${hasTeam && !instances.length
        ? step('current', 'Create the first instance in it', "A Worca of its own, for the team's members. Ready in a few minutes.", newInstanceAction(ctx, teams, { small: true }))
        : step('waiting', 'Create the first instance in it', "A Worca of its own, for the team's members. Ready in a few minutes.")}
    </ol>
    <div class="ov-setup-more"><a class="linkbtn ov-link" href="${orgPath}/teams">All teams</a></div></div>`;
}

async function renderAdmin(ctx) {
  const orgPath = p`/o/${ctx.orgId}`;
  const orgName = ctx.org.name || 'Your org';
  bindFirstTeam(ctx);
  const show = live(ctx, async () => {
    const soft = (promise) => promise.catch(() => null);
    const [sum, instRes, auditRes, membersRes, invRes, org, teamsRes] = await Promise.all([
      api.get(p`/api/orgs/${ctx.orgId}/summary`),
      api.get(p`/api/orgs/${ctx.orgId}/instances`),
      soft(api.get(p`/api/orgs/${ctx.orgId}/audit?limit=5`)),
      soft(api.get(p`/api/orgs/${ctx.orgId}/members`)),
      soft(api.get(p`/api/orgs/${ctx.orgId}/invitations`)),
      soft(api.get(p`/api/orgs/${ctx.orgId}`)),
      soft(api.get(p`/api/orgs/${ctx.orgId}/teams`)),
    ]);
    const teams = teamsRes?.teams || [];
    const instances = instRes.instances.filter((i) => i.status !== 'deleting');
    const n = namer(membersRes?.members, instRes.instances);
    const by = sum.instances.byStatus || {};
    const latest = (sum.instances.upgradesAvailable || []).map((u) => u.availableVersion).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    const items = needsYou(ctx, sum, instances, invRes?.invitations ?? null, orgPath);
    const signIn = signInSummary(sum.signIn);
    const tier = org?.tier?.name;
    const lim = sum.instances.limit;
    const asleep = by.suspended || 0;
    const busyCount = (by.creating || 0) + (by.upgrading || 0);

    const tiles = html`<div class="grid g4">
      <a class="tile ov-tile" href="${orgPath}/instances"><div class="k">${icon('server')}Instances</div>
        <div class="v">${sum.instances.total}${lim ? html`<span class="ov-of"> / ${lim}</span>` : ''}</div>
        <div class="s"><b>${by.running || 0}</b> running · <b>${asleep}</b> asleep${busyCount ? html` · <b>${busyCount}</b> busy` : ''}</div></a>
      <a class="tile ov-tile" href="${orgPath}/instances"><div class="k">${icon('arrowUp')}Upgrades</div>
        <div class="v">${(sum.instances.upgradesAvailable || []).length}</div>
        <div class="s">${latest ? html`Latest Worca is <b>${latest}</b>` : 'Every instance is up to date'}</div></a>
      <a class="tile ov-tile" href="${orgPath}/members"><div class="k">${icon('users')}Members</div>
        <div class="v">${sum.members.count}${sum.members.limit ? html`<span class="ov-of"> / ${sum.members.limit}</span>` : ''}</div>
        <div class="s"><b>${sum.invitations.open}</b> ${sum.invitations.open === 1 ? 'invitation' : 'invitations'} open${sum.invitations.expiringWithin48h ? html` · <b>${sum.invitations.expiringWithin48h}</b> expiring` : ''}</div></a>
      <a class="tile ov-tile" href="${orgPath}/security"><div class="k">${icon('shield')}Sign-in</div>
        <div class="v ov-text">${signIn.v}</div>
        <div class="s">${signIn.sub}</div></a>
    </div>`;

    const needs = html`<div class="card"><div class="card-head"><h2>Needs you</h2><span class="sub">${items.length ? plural(items.length, 'item') : ''}</span></div>
      ${items.length ? html`<div class="rows ov-needs">${items}</div>`
        : html`<div class="empty ov-calm"><span class="g green">${icon('check')}</span><span>Nothing needs you right now.</span></div>`}</div>`;

    const entries = auditRes?.entries;
    const activity = html`<div class="card"><div class="card-head"><h2>Recent activity</h2><a class="linkbtn ov-link" href="${orgPath}/audit">Audit log</a></div>
      ${!entries ? html`<div class="empty">Couldn't load the recent activity.</div>`
        : !entries.length ? html`<div class="empty">Nothing happened yet.</div>`
        : html`<div class="list ov-activity">${entries.map((e) => html`<div class="row"><div class="t"><b>${auditText(e, n)}</b><span>${actorName(e, n)} · <time datetime="${new Date(e.at).toISOString()}" title="${dateTime(e.at)}">${relTime(e.at)}</time></span></div></div>`)}</div>`}</div>`;

    const instCard = html`<div class="card"><div class="card-head"><h2>Instances</h2>${instances.length ? html`<a class="linkbtn ov-link" href="${orgPath}/instances">All instances</a>` : ''}</div>
      ${instances.length
        ? html`<div class="rows">${instances.slice(0, 6).map((i) => html`<a class="row click" href="${p`/o/${ctx.orgId}/instances/${i.id}`}">${glyph(shownStatus(i))}<div class="t"><b>${i.name || 'Unnamed instance'}</b><span class="mono">${i.host}</span></div><div class="r">${teamPills(i)}${statusPill(shownStatus(i))}${icon('chev')}</div></a>`)}</div>
          ${instances.length > 6 ? html`<div class="ov-more"><a class="linkbtn ov-link" href="${orgPath}/instances">${plural(instances.length - 6, 'more instance')}</a></div>` : ''}`
        : html`<div class="empty ov-calm"><span>No instances yet. An instance is a Worca of your own, in one of your teams.</span>
            ${newInstanceAction(ctx, teams, { small: true, primary: false })}</div>`}</div>`;

    return {
      busy: instances.some(isBusy),
      markup: html`<div class="page">
        <div class="head"><div><h1>Overview</h1><p>${orgName} at a glance${tier ? html` · ${tier} plan` : ''}. Things that need you come first.</p></div>
          <div class="acts">${newInstanceAction(ctx, teams)}</div></div>
        ${!teams.length || !instRes.instances.length ? setupCard(ctx, teams, instances) : ''}
        ${tiles}
        <div class="grid g-main">${needs}${activity}</div>
        ${instCard}
      </div>`,
    };
  });
  await show();
}

export default [
  {
    path: '/o/:orgId',
    nav: 'overview',
    title: 'Overview',
    async render(ctx) {
      if (ctx.org.role === 'tenant_admin') return renderAdmin(ctx);
      return renderUser(ctx);
    },
  },
];
