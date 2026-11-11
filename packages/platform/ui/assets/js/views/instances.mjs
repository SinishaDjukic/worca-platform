// Org instances: the list (tenant admins), the create form, and the instance detail with its live
// operation progress (tenant admins; tenant users see a read-only detail of instances their teams
// grant). docs/ui.md "Org workspace", docs/instance-lifecycle.md, routes in src/control/instances/routes.ts
// and src/control/tenancy/policy-routes.ts.
import {
  api, html, icon, p, busy, toast, navigate, plural, relTime, dateShort, dateTime, errorText, $, $$,
  glyph, statusPill, shownStatus, statusLine, STATUS, openModal, closeModal, copyText, protectedAction,
  ApiError, SIGN_IN_METHOD, isOrgAdmin, setHtml, COMPUTE_SERVICES, serviceSize, fieldError, clearFieldErrors, alertBox, showAlert, watchOp,
  brand,
} from '../core.mjs';
import { bindEditor, editorMarkup, EGRESS_NOTE, policyDetails, policyLine, readEditor, samePolicy, showEgressRefusal } from '../egress.mjs';
import { gitModal, gitRow } from '../git.mjs';
import { fieldsLine, hasFields, providerFields, readProviderFields, showFieldProblems } from '../provider-fields.mjs';

const METHODS = ['email-otp', 'passkey', 'google', 'microsoft', 'sso'];
/** States that change on their own soon: poll every 5 s instead of every 30 s. */
const MOVING = new Set(['creating', 'upgrading', 'deleting']);
/** States in which the instance can't be opened. */
const CLOSED = new Set(['creating', 'deleting', 'stopped']);
const FAST_MS = 5_000;
const SLOW_MS = 30_000;

const orgBase = (orgId) => p`/o/${orgId}`;
const instHref = (orgId, id) => p`/o/${orgId}/instances/${id}`;
const moving = (inst) => MOVING.has(inst.status) || inst.op?.status === 'running';
const nameOf = (inst) => inst.name || 'Unnamed instance';
const teamNames = (inst) => (inst.teams || []).map((t) => t.name).filter(Boolean);
const methodList = (methods) => methods.map((m) => SIGN_IN_METHOD[m] || m);
const joinWords = (list) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} or ${list.at(-1)}`);
const upgradeAvailable = (inst) => !!(inst.availableVersion && inst.availableVersion !== inst.version);
/** D26: a tenant admin may move a running instance to any published version, with nothing else under way. */
const canChangeVersion = (inst) => inst.status === 'running' && !inst.upgradingTo && inst.op?.status !== 'running';

/** Polls `tick` every 5 s while `fast()` says something is moving, every 30 s otherwise. */
function livePoll(ctx, fast, tick) {
  let last = Date.now();
  let running = false;
  ctx.poll(async () => {
    if (running || Date.now() - last < (fast() ? FAST_MS : SLOW_MS) - 500) return;
    running = true;
    last = Date.now();
    try { await tick(); } catch { /* the next tick tries again */ } finally { running = false; }
  }, FAST_MS);
}

// ---- teams first (D71) ----------------------------------------------------------------------------
// An instance is created within a team and always keeps one. With no team yet, every "new
// instance" action becomes "create a team first", which then continues to the instance.

export const LAST_TEAM = 'An instance always keeps at least one team. Give it another team first, or delete the instance.';
export const TEAMS_FIRST = "Instances belong to teams: people reach an instance through a team they're in.";
const SUGGESTED_TEAM = 'Core';
const teamHref = (orgId, id) => p`/o/${orgId}/teams/${id}`;
const newInstanceHref = (orgId, teamId) => (teamId ? p`/o/${orgId}/instances/new?team=${teamId}` : p`/o/${orgId}/instances/new`);

/**
 * Asks for the first team's name (suggested), creates it with the admin in it, then continues to
 * the new instance in that team.
 */
export function firstTeamModal(ctx) {
  const m = openModal(html`<h2>Create a team first</h2>
    <p>${TEAMS_FIRST} Create the first team, then the instance in it.</p>
    <form class="form" id="ft-form" novalidate>
      <div class="field"><label for="ft-name">Team name</label><input class="inp" id="ft-name" maxlength="100" autocomplete="off" required value="${SUGGESTED_TEAM}">
        <span class="hint">You're added to it, so you can open its instances. Add more people later.</span></div>
      <div class="acts"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" id="ft-go">Create team and continue</button></div>
    </form>`);
  const inp = $('#ft-name', m);
  inp.select();
  $('#ft-form', m).addEventListener('submit', (e) => {
    e.preventDefault();
    const name = inp.value.trim();
    if (!name) return void fieldError(inp, 'Give the team a name.');
    busy($('#ft-go', m), async () => {
      let id;
      try {
        id = await createTeamWithMe(ctx, name);
      } catch (x) {
        if (x instanceof ApiError && x.code === 'invalid_body') return void fieldError(inp, 'Use 1 to 100 characters.');
        throw x;
      }
      closeModal();
      toast(`Team ${name} created`);
      navigate(newInstanceHref(ctx.orgId, id));
    });
  });
}

/** Creates a team and adds the signed-in admin to it; returns its id. */
async function createTeamWithMe(ctx, name) {
  const { id } = await api.post(p`/api/orgs/${ctx.orgId}/teams`, { name });
  try {
    await api.post(p`/api/orgs/${ctx.orgId}/teams/${id}/members`, { userId: ctx.me.user.id });
  } catch (e) {
    if (!(e instanceof ApiError && e.code === 'already_member')) toast(`Team ${name} created, but you couldn't be added to it. Add yourself on the team's page.`, 'error');
  }
  return id;
}

/** The "New instance" action, or "Create a team first" while the org has no team. */
export function newInstanceAction(ctx, teams, { small = false, primary = true } = {}) {
  const cls = `btn${primary ? ' primary' : ''}${small ? ' sm' : ''}`;
  if (!teams.length) return html`<button type="button" class="${cls}" data-first-team>${icon('team')}Create a team first</button>`;
  return html`<a class="${cls}" href="${newInstanceHref(ctx.orgId, teams.length === 1 ? teams[0].id : '')}">${icon('plus')}New instance</a>`;
}

/** Wires every [data-first-team] button of the page, also after re-renders (delegated). */
export function bindFirstTeam(ctx) {
  const onClick = (e) => {
    const b = e.target.closest('[data-first-team]');
    if (b && ctx.el.contains(b)) firstTeamModal(ctx);
  };
  ctx.el.addEventListener('click', onClick);
  ctx.onLeave(() => ctx.el.removeEventListener('click', onClick));
}

/** An instance's teams as pills, for rows that are links themselves. */
export function teamPills(inst) {
  const teams = (inst.teams || []).filter((t) => t.name);
  return html`${teams.map((t) => html`<span class="pill line inst-teampill">${icon('team')}${t.name}</span>`)}`;
}

/** An instance's teams as links to them (the hierarchy: teams, then their instances). */
export function teamLinks(orgId, inst, empty = 'No team') {
  const teams = (inst.teams || []).filter((t) => t.name);
  if (!teams.length) return html`<span class="muted">${empty}</span>`;
  return html`<span class="inst-teams">${teams.map((t) => html`<a class="pill line inst-teampill" href="${teamHref(orgId, t.id)}">${icon('team')}${t.name}</a>`)}</span>`;
}

/** x.y.z below the running version: the version picker moving an instance back. */
const olderThan = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] || 0) < (pb[i] || 0);
  return false;
};
const movingBack = (i) => !!(i.upgradingTo && i.version && olderThan(i.upgradingTo, i.version));

// ---- operations and their phases (src/control/instances/progress.ts OP_PHASES) ------------------

const OP_LABEL = {
  create: 'Creating', upgrade: 'Upgrading', wake: 'Waking up', lift: 'Starting again',
  suspend: 'Going to sleep', stop: 'Stopping', delete: 'Deleting', reconfigure: 'Applying settings', rotate: 'Renewing credentials',
  refresh: 'Updating components',
};
/** " Write to <abuse address> if you think this is a mistake.", or the abuse form, or nothing. */
function abuseContact() {
  if (brand.abuseEmail) return html` Write to <a href="mailto:${brand.abuseEmail}">${brand.abuseEmail}</a> if you think this is a mistake.`;
  if (brand.abuseUrl) return html` <a href="${brand.abuseUrl}">Tell us</a> if you think this is a mistake.`;
  return '';
}

const PHASE_TEXT = {
  create: {
    reserving: ['Reserving the address', (i) => i.host],
    compute: ['Creating its compute', () => 'Its own machine and storage'],
    network: [brand.instanceDomain ? `Connecting it to ${brand.instanceDomain}` : 'Connecting it to the network', () => 'Private tunnel, no public ports'],
    starting: ['Starting Worca', () => 'Pulling the image'],
    waiting: ['Waiting for Worca to report in', () => 'Its first heartbeat'],
    ready: ['Ready', () => 'Your teams can open it now'],
  },
  upgrade: {
    preparing: [(i) => (movingBack(i) ? 'Preparing the version change' : 'Preparing the upgrade'), (i) => (i.upgradingTo ? `From ${i.version || '?'} to ${i.upgradingTo}` : '')],
    deploying: ['Deploying the new version', () => 'Restarts for about a minute'],
    waiting: ['Waiting for the new version to report in', () => 'Its next heartbeat'],
    rolling_back: ['Rolling back', () => 'The new version did not come up; going back to the old one'],
    ready: [(i) => (movingBack(i) ? 'Version changed' : 'Upgraded'), (i) => (i.version ? `Runs ${i.version}` : '')],
  },
  wake: {
    starting: ['Starting', () => 'It was asleep'],
    waiting: ['Waiting for Worca to report in', () => 'Usually a few seconds'],
    ready: ['Running', () => ''],
  },
  lift: {
    starting: ['Starting', () => 'The platform lifted the stop'],
    waiting: ['Waiting for Worca to report in', () => ''],
    ready: ['Running', () => ''],
  },
  suspend: { stopping: ['Going to sleep', () => 'Nobody used it for a while'], suspended: ['Asleep', () => 'Wakes when someone opens it'] },
  stop: { stopping: ['Stopping', () => ''], stopped: ['Stopped', () => 'Stopped by the platform'] },
  reconfigure: {
    preparing: ['Preparing', () => 'Remote access and outbound network in Worca'],
    applying: ['Saving the settings', () => ''],
    restarting: ['Restarting Worca', () => 'About a minute; active runs pause and resume'],
    ready: ['Done', (i) => remoteLine(i.remoteAccess)],
  },
  rotate: {
    preparing: ['Preparing', () => 'The platform renews the credentials it connects with'],
    renewing: ['Renewing its credentials', () => 'Your data, settings and stored keys stay as they are'],
    restarting: ['Restarting Worca', () => 'About a minute; active runs pause and resume'],
    waiting: ['Waiting for Worca to report in', () => 'With its new credentials'],
    ready: ['Done', () => ''],
  },
  refresh: {
    preparing: ['Preparing', () => 'A newer tunnel connector for the same Worca version'],
    deploying: ['Deploying the connector', () => 'Worca keeps running; open pages reconnect'],
    waiting: ['Waiting for the connector to report in', () => 'To Cloudflare'],
    ready: ['Done', (i) => (i.version ? `Runs ${i.version}` : '')],
  },
  delete: {
    closing: ['Closing access', () => 'Nobody can open it any more'],
    compute: ['Removing its compute and data', () => ''],
    network: ['Removing its address', () => ''],
    cleanup: ['Cleaning up', () => ''],
    deleted: ['Deleted', () => ''],
  },
};
const phaseText = (kind, phase, inst) => {
  const t = PHASE_TEXT[kind]?.[phase];
  return t ? [typeof t[0] === 'function' ? t[0](inst) : t[0], t[1](inst)] : [phase.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), ''];
};

/** Show the step list while an operation runs, when it failed, or for a few minutes after it ended. */
function showSteps(inst) {
  const op = inst.op;
  if (!op || !(op.phases || []).length) return false;
  if (op.status !== 'done') return true;
  return MOVING.has(inst.status) || (op.finishedAt && Date.now() - op.finishedAt < 10 * 60_000 && op.kind !== 'suspend');
}

function stepList(inst) {
  const op = inst.op;
  let phases = [...op.phases];
  let at = phases.indexOf(op.phase);
  if (at < 0) {
    // A phase outside the happy path (an upgrade rolling back): it replaces the remaining ones.
    const cut = Math.max(phases.indexOf('waiting'), 1);
    phases = [...phases.slice(0, cut), op.phase];
    at = phases.length - 1;
  }
  const done = op.status === 'done' && at === phases.length - 1;
  return html`<ol class="steps inst-steps" aria-label="${OP_LABEL[op.kind] || op.kind} progress">${phases.map((ph, k) => {
    const [title, line] = phaseText(op.kind, ph, inst);
    let mark, cls = '', state;
    if (k < at || (k === at && done)) { mark = html`<span class="g green">${icon('check')}</span>`; state = 'done'; }
    else if (k === at && op.status === 'failed') { mark = html`<span class="g red">${icon('alert')}</span>`; state = 'failed'; }
    else if (k === at) { mark = html`<span class="g violet spin">${icon('loader')}</span>`; state = 'current'; }
    else { mark = html`<span class="g slate"><span class="dot inst-dot"></span></span>`; cls = 'wait'; state = 'waiting'; }
    const since = state === 'current' && op.phaseStartedAt ? `since ${relTime(op.phaseStartedAt).replace(/ ago$/, '')}` : '';
    const detail = state === 'failed' ? 'Did not finish' : [line, since].filter(Boolean).join(' · ');
    // The current step keeps failing: say why, and that it is being retried.
    const problem = state === 'current' && op.problem ? problemLine(op.problem, op.problemSource) : '';
    return html`<li class="step ${cls}" data-phase="${ph}" data-state="${state}"${state === 'current' ? html` aria-current="step"` : ''}>${mark}<div class="t"><b>${title}</b>${detail ? html`<span>${detail}</span>` : ''}${problem ? html`<span class="step-problem" role="status">${problem} Retrying${op.problem === 'provider_limit' ? '; if it gives up, delete this instance and create it again later' : ''}.</span>` : ''}</div></li>`;
  })}</ol>`;
}

// ---- small pieces ---------------------------------------------------------------------------------

function healthText(inst) {
  if (!inst.health) return { tone: 'slate', label: 'No report yet', line: '' };
  if (inst.health === 'ok') return { tone: 'green', label: 'Healthy', line: inst.healthSince ? `since ${relTime(inst.healthSince).replace(/ ago$/, '')}` : '' };
  return { tone: 'amber', label: 'Reports a problem', line: inst.healthSince ? `since ${relTime(inst.healthSince).replace(/ ago$/, '')}` : '' };
}

const ERROR_TEXT = {
  no_heartbeat: "Worca didn't report in within 10 minutes, so setup stopped.",
  unknown_version: 'The upgrade did not start: that version is not published.',
  upgrade_timeout: 'The new version did not report in, so the upgrade was rolled back.',
  wake_timeout: 'It did not wake up in time. Opening it tries again.',
  lift_timeout: 'It did not start in time after the stop was lifted.',
};
// A provider step that keeps failing (op.problem while it retries) or that ended a create
// (inst.errorReason), in plain words. The server sends only these codes, never the provider's text.
const PROVIDER = { compute: 'Our hosting provider', network: 'Our network provider' };
const PROBLEM_TEXT = {
  provider_limit: (who) => `${who} is refusing to create more machines right now: the platform's account has reached a limit.`,
  provider_auth: () => "The platform can't sign in to its hosting provider. This is on the platform's side, not yours.",
  provider_unavailable: (who) => `${who} isn't answering right now.`,
  provider_slow: (who) => `${who} is taking longer than usual.`,
  image_missing: () => "The Worca version to install couldn't be downloaded.",
  platform_error: () => "A step failed on the platform's side.",
};
function problemLine(code, source) {
  const f = PROBLEM_TEXT[code];
  return f ? f(PROVIDER[source] || 'Our hosting provider') : '';
}

function errorLine(code, reason, source) {
  if (!code) return '';
  if (ERROR_TEXT[code]) return ERROR_TEXT[code];
  if (code === 'create_failed') {
    const why = problemLine(reason, source);
    return why ? `Setup stopped. ${why}` : 'Setup did not finish. We have been notified.';
  }
  return 'The last operation did not finish.';
}

/** The pipeline counts from the last heartbeat, known statuses first. */
function pipelineTiles(pipes) {
  const order = ['running', 'waiting', 'paused', 'queued', 'done', 'completed', 'failed'];
  const keys = Object.keys(pipes || {}).sort((a, b) => ((order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)) || a.localeCompare(b));
  if (!keys.length) keys.push('running');
  return keys.map((k) => html`<div class="mini${k === 'failed' && pipes?.[k] ? ' inst-mini-bad' : ''}"><b>${pipes?.[k] ?? 0}</b><span>${k.replace(/_/g, ' ')}</span></div>`);
}

function openLink(inst, { primary = true, small = false } = {}) {
  const label = inst.status === 'suspended' ? 'Wake and open' : 'Open';
  if (CLOSED.has(inst.status) || !inst.url) {
    return html`<button class="btn${small ? ' sm' : ''}" disabled title="Not available while ${(STATUS[shownStatus(inst)]?.label || inst.status).toLowerCase()}">${icon('ext')}${label}</button>`;
  }
  return html`<a class="btn${primary ? ' primary' : ''}${small ? ' sm' : ''}" href="${inst.url}" target="_blank" rel="noopener" aria-label="${label} ${nameOf(inst)} in a new tab">${icon('ext')}${label}</a>`;
}

const policyLabel = (pol) => {
  if (!pol) return '';
  if (!pol.requiredMethods.length) return pol.orgAllowedMethods.length ? `Org default: ${joinWords(methodList(pol.orgAllowedMethods))}` : 'Org default: any sign-in method';
  return `Only ${joinWords(methodList(pol.requiredMethods))}`;
};

// ---- list -----------------------------------------------------------------------------------------

const FILTERS = [
  ['all', 'All'],
  ['running', 'Running'],
  ['suspended', 'Asleep'],
  ['moving', 'In progress'],
  ['attention', 'Needs attention'],
];
const needsAttention = (i) => shownStatus(i) === 'degraded' || i.status === 'stopped' || upgradeAvailable(i) || (i.error && i.status === 'creating') || i.op?.status === 'failed';
function matches(inst, status, team) {
  if (team && !(inst.teamIds || []).includes(team)) return false;
  if (status === 'all') return true;
  if (status === 'moving') return moving(inst);
  if (status === 'attention') return needsAttention(inst);
  return inst.status === status;
}

function listRow(orgId, i) {
  const st = shownStatus(i);
  const h = healthText(i);
  return html`<tr class="click" data-href="${instHref(orgId, i.id)}" data-instance="${i.id}">
    <td class="inst-g">${glyph(st)}</td>
    <td class="inst-name"><a href="${instHref(orgId, i.id)}">${nameOf(i)}</a><div class="mono muted">${i.host || ''}</div></td>
    <td>${statusPill(st)}${moving(i) && i.op?.status === 'running' ? html`<div class="muted inst-sub">${phaseText(i.op.kind, i.op.phase, i)[0]}</div>` : ''}</td>
    <td><span class="mono">${i.version || '—'}</span>${i.versionWithdrawn ? html` <span class="pill amber" title="Withdrawn by the platform">withdrawn</span>` : upgradeAvailable(i) ? html` <span class="pill violet">${i.availableVersion} available</span>` : ''}</td>
    <td><span class="inst-health"><span class="dot inst-dot-${h.tone}"></span>${h.label}</span></td>
    <td class="ink2">${teamLinks(orgId, i)}</td>
    <td class="muted" title="${i.lastHeartbeatAt ? dateTime(i.lastHeartbeatAt) : ''}">${i.lastHeartbeatAt ? relTime(i.lastHeartbeatAt) : 'Never'}</td>
  </tr>`;
}

const list = {
  path: '/o/:orgId/instances',
  nav: 'instances',
  title: 'Instances',
  adminOnly: true,
  async render(ctx) {
    const orgId = ctx.orgId;
    const [{ instances: first }, teamsRes] = await Promise.all([
      api.get(p`/api/orgs/${orgId}/instances`),
      api.get(p`/api/orgs/${orgId}/teams`).catch(() => ({ teams: [] })),
    ]);
    if (!ctx.alive()) return;
    let instances = first || [];
    const teams = teamsRes.teams || [];
    let status = FILTERS.some(([k]) => k === ctx.query.get('status')) ? ctx.query.get('status') : 'all';
    let team = teams.some((t) => t.id === ctx.query.get('team')) ? ctx.query.get('team') : '';

    ctx.set(html`<div class="page">
      <div class="head"><div><h1>Instances</h1><p>Each instance is its own Worca at its own address, in one or more teams. People reach one through a team they're in.</p></div>
        <div class="acts">${newInstanceAction(ctx, teams)}</div></div>
      <div id="inst-body"></div></div>`);
    bindFirstTeam(ctx);

    const syncUrl = () => {
      const q = new URLSearchParams();
      if (status !== 'all') q.set('status', status);
      if (team) q.set('team', team);
      history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}`);
    };
    const draw = () => {
      const body = $('#inst-body', ctx.el);
      if (!body) return;
      if (!instances.length) {
        setHtml(body, html`<div class="card"><div class="empty inst-empty"><span class="g slate lg">${icon('server')}</span>
          <b>No instances yet</b><span>${teams.length ? "Create the first one in a team. It's ready in a few minutes." : TEAMS_FIRST}</span>
          ${newInstanceAction(ctx, teams)}</div></div>`);
        return;
      }
      const rows = instances.filter((i) => matches(i, status, team));
      const count = (k) => instances.filter((i) => matches(i, k, team)).length;
      setHtml(body, html`<div class="stack">
        <div class="inst-filters">
          <div class="seg" role="group" aria-label="Filter by status">${FILTERS.map(([k, l]) => html`<button type="button" data-status="${k}" class="${status === k ? 'on' : ''}" aria-pressed="${status === k ? 'true' : 'false'}">${l}${k !== 'all' && count(k) ? html` <span class="inst-count">${count(k)}</span>` : ''}</button>`)}</div>
          ${teams.length ? html`<div class="inst-team"><label class="inst-sr" for="inst-team">Team</label><select class="inp" id="inst-team">
            <option value="">All teams</option>${teams.map((t) => html`<option value="${t.id}" ${t.id === team ? 'selected' : ''}>${t.name || 'Unnamed team'}</option>`)}</select></div>` : ''}
        </div>
        <div class="card inst-tablecard"><div class="tablewrap"><table class="inst-table">
          <thead><tr><th><span class="inst-sr">Status</span></th><th>Instance</th><th>Status</th><th>Version</th><th>Health</th><th>Teams</th><th>Last heartbeat</th></tr></thead>
          <tbody>${rows.length ? rows.map((i) => listRow(orgId, i)) : html`<tr><td colspan="7"><div class="empty">No instances match these filters. <button type="button" class="linkbtn" id="inst-clear">Show all</button></div></td></tr>`}</tbody>
        </table></div></div></div>`);
      for (const b of $$('[data-status]', body)) b.addEventListener('click', () => { status = b.dataset.status; syncUrl(); draw(); });
      $('#inst-team', body)?.addEventListener('change', (e) => { team = e.target.value; syncUrl(); draw(); });
      $('#inst-clear', body)?.addEventListener('click', () => { status = 'all'; team = ''; syncUrl(); draw(); });
      for (const tr of $$('tr[data-href]', body)) {
        tr.addEventListener('click', (e) => { if (!e.target.closest('a,button')) navigate(tr.dataset.href); });
      }
    };
    draw();

    let seen = JSON.stringify(instances);
    livePoll(ctx, () => instances.some(moving), async () => {
      const { instances: next } = await api.get(p`/api/orgs/${orgId}/instances`);
      if (!ctx.alive()) return;
      const s = JSON.stringify(next || []);
      if (s === seen) return;
      seen = s;
      instances = next || [];
      if (!document.activeElement || !$('#inst-body', ctx.el)?.contains(document.activeElement) || document.activeElement.tagName !== 'SELECT') draw();
    });
  },
};

// ---- create ---------------------------------------------------------------------------------------

const create = {
  path: '/o/:orgId/instances/new',
  nav: 'instance-new',
  title: 'New instance',
  adminOnly: true,
  async render(ctx) {
    const orgId = ctx.orgId;
    const [teamsRes, summary, orgPolicy] = await Promise.all([
      api.get(p`/api/orgs/${orgId}/teams`),
      api.get(p`/api/orgs/${orgId}/summary`),
      api.get(p`/api/orgs/${orgId}/policy`).catch(() => ({ allowedMethods: [] })),
    ]);
    if (!ctx.alive()) return;
    let teams = teamsRes.teams || [];
    const total = summary.instances?.total ?? 0;
    const limit = summary.instances?.limit ?? null;
    const full = limit !== null && total >= limit;
    const sizes = summary.instances?.sizes || [];
    const defaultSize = summary.instances?.defaultSize || sizes[0]?.id;
    // The compute provider's own instance settings (docs/providers.md "Settings"); most have none.
    const pfields = summary.instances?.providerFields || [];
    const orgAllowed = orgPolicy.allowedMethods || [];
    const offered = orgAllowed.length ? orgAllowed : METHODS;
    const orgName = ctx.org?.name || 'this org';
    const crumb = html`<nav class="crumb inst-crumb" aria-label="Breadcrumb"><a href="${orgBase(orgId) + '/instances'}">Instances</a>${icon('chev')}<span>New instance</span></nav>`;

    // D71: no team yet, so the first step is the team; it then comes back here with ?team=.
    if (!teams.length) {
      ctx.set(html`<div class="page narrow">
        <div>${crumb}<div class="head"><div><h1>New instance</h1><p>A Worca of its own, at its own address. Ready in a few minutes.</p></div></div></div>
        <div class="card"><div class="empty inst-empty" id="c-team-first"><span class="g slate lg">${icon('team')}</span>
          <b>Create a team first</b><span>${TEAMS_FIRST}</span>
          <button type="button" class="btn primary" data-first-team>${icon('plus')}Create a team</button></div></div></div>`);
      bindFirstTeam(ctx);
      return;
    }

    // Pre-selected when coming from a team, or when there is only one.
    const asked = ctx.query.get('team');
    let chosen = teams.some((t) => t.id === asked) ? asked : teams.length === 1 ? teams[0].id : '';
    const teamOptions = () => html`${chosen ? '' : html`<option value="" selected disabled>Pick a team</option>`}${teams.map((t) => html`<option value="${t.id}" ${t.id === chosen ? 'selected' : ''}>${t.name || 'Unnamed team'} · ${plural(t.members ?? 0, 'person', 'people')}</option>`)}`;

    ctx.set(html`<div class="page narrow">
      <div>${crumb}
        <div class="head"><div><h1>New instance</h1><p>A Worca of its own, at its own address. Ready in a few minutes.</p></div></div></div>
      <div class="card"><form class="form" id="create-form" novalidate>
        <div class="field"><label for="c-team">Team</label><select class="inp" id="c-team" name="team" required ${full ? 'disabled' : ''}>${teamOptions()}</select>
          <span class="hint" id="c-teams-hint">Its members can open the instance. Org admins can share it with more teams later, on the instance page, and can always manage it.</span></div>
        <div class="field"><label for="c-name">Instance name</label><input class="inp" id="c-name" name="name" maxlength="100" required autocomplete="off" placeholder="For example Payments backend" ${full ? 'disabled' : ''}>
          <span class="hint" id="c-name-hint">Shown to members of the instance's teams and to ${orgName}'s admins.</span></div>
        ${sizes.length > 1 ? html`<fieldset class="field inst-fieldset" id="c-size"><legend>Compute size</legend>
          <div class="checks">${sizes.map((s) => html`<label class="check"><input type="radio" name="size" value="${s.id}" ${s.id === defaultSize ? 'checked' : ''} ${full ? 'disabled' : ''}><span class="t"><b>${s.name}</b><span>${sizeFacts(s)}</span></span></label>`)}</div>
          <span class="hint" id="c-size-hint">Usage is billed, not the size. You can change it later on the instance page.</span></fieldset>` : ''}
        ${hasFields(pfields) ? html`<fieldset class="field inst-fieldset" id="c-provider"><legend>Hosting settings</legend>
          ${providerFields(pfields, { prefix: 'c-pf', disabled: full })}</fieldset>` : ''}
        <fieldset class="field inst-fieldset"><legend>Sign-in <span class="opt">optional</span></legend>
          <div class="checks">
            <label class="check"><input type="radio" name="pol" value="org" checked><span class="t"><b>Same as the org</b><span>${orgAllowed.length ? joinWords(methodList(orgAllowed)) : 'Any sign-in method'}</span></span></label>
            <label class="check"><input type="radio" name="pol" value="only"><span class="t"><b>Stricter: only some methods</b><span>People who signed in another way sign in again first</span></span></label>
          </div>
          <div class="checks inst-methods" id="c-methods" hidden>${offered.map((m) => html`<label class="check"><input type="checkbox" name="method" value="${m}"><span class="t"><b>${SIGN_IN_METHOD[m] || m}</b></span></label>`)}</div>
          <span class="hint" id="c-pol-hint">An instance can only be stricter than the org.</span></fieldset>
        ${full
          ? html`<div class="banner amber" id="c-limit">${icon('alert')}<div class="grow"><b>Your plan is full.</b> It includes ${plural(limit, 'instance')} and ${total === 1 ? 'it is' : 'all are'} in use. Delete one, or ask Worca support for a larger plan.</div></div>`
          : html`<div class="banner blue" id="c-limit">${icon('info')}<div class="grow">${limit === null ? html`This will be instance <b>${total + 1}</b>.` : html`Your plan includes ${plural(limit, 'instance')}. This will be <b>${total + 1} of ${limit}</b>.`}</div></div>`}
        <div class="banner red" id="c-err" role="alert" hidden>${icon('err')}<div class="grow" id="c-err-text"></div></div>
        <div class="flex inst-form-acts"><a class="btn" href="${orgBase(orgId) + '/instances'}">Cancel</a><button class="btn primary" type="submit" id="c-go" ${full ? 'disabled' : ''}>Create instance</button></div>
      </form></div></div>`);

    const form = $('#create-form', ctx.el);
    const methods = $('#c-methods', form);
    const teamSel = $('#c-team', form);
    teamSel.addEventListener('change', () => { chosen = teamSel.value; });
    for (const r of $$('input[name=pol]', form)) r.addEventListener('change', () => { methods.hidden = form.pol.value !== 'only'; });
    // Problems with the form as a whole; a problem with one field goes under that field (fieldError).
    const showErr = (text) => { $('#c-err-text', form).textContent = text; $('#c-err', form).hidden = !text; };
    const reloadTeams = async () => {
      teams = (await api.get(p`/api/orgs/${orgId}/teams`).catch(() => ({ teams }))).teams || [];
      if (!teams.some((t) => t.id === chosen)) chosen = teams.length === 1 ? teams[0].id : '';
      setHtml(teamSel, teamOptions());
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      showErr('');
      clearFieldErrors(form);
      const nameInp = $('#c-name', form);
      if (!chosen) return void fieldError(teamSel, 'Pick the team it belongs to.');
      const name = nameInp.value.trim();
      if (!name) return void fieldError(nameInp, 'Give it a name.');
      const body = { name, teamId: chosen };
      const size = $('input[name=size]:checked', form)?.value;
      if (size) body.size = size;
      if (hasFields(pfields)) body.providerSettings = readProviderFields(pfields, form, 'c-pf');
      if (form.pol.value === 'only') {
        const requiredMethods = $$('input[name=method]:checked', form).map((x) => x.value);
        if (!requiredMethods.length) return void fieldError($$('input[name=method]', form), 'Pick at least one sign-in method, or keep the org default.');
        body.policy = { requiredMethods };
      }
      busy($('#c-go', form), async () => {
        try {
          const inst = await api.post(p`/api/orgs/${orgId}/instances`, body);
          toast(`Creating ${nameOf(inst)}`);
          watchOp({ url: p`/api/orgs/${orgId}/instances/${inst.id}`, href: instHref(orgId, inst.id), kind: 'create', ok: `${nameOf(inst)} is ready`, fail: `${nameOf(inst)} couldn't be set up` });
          navigate(instHref(orgId, inst.id));
        } catch (err) {
          if (!(err instanceof ApiError)) throw err;
          if (err.code === 'not_narrowing') return void fieldError($$('input[name=method]', form), "The org's sign-in policy doesn't allow one of these methods. An instance can only be stricter than the org.");
          if (err.code === 'team_not_found' || err.code === 'team_required') {
            await reloadTeams();
            if (!teams.length) return ctx.refresh(); // the last team went: start with a team again
            return void fieldError(teamSel, 'That team no longer exists. The list is up to date now; pick again.');
          }
          if (err.code === 'invalid_body') return void fieldError(nameInp, 'Give it a name of up to 100 characters.');
          if (err.code === 'invalid_provider_settings' && showFieldProblems(err.body?.problems, form, 'c-pf')) return;
          if (err.code === 'size_not_allowed') return void fieldError($$('input[name=size]', form), "Your plan doesn't include this size any more. Reload the page to see the sizes it includes.");
          if (err.code === 'tier_limit') {
            $('#c-go', form).disabled = true;
            return showErr('Your plan has no room for another instance. Delete one, or ask Worca support for a larger plan.');
          }
          throw err;
        }
      });
    });
  },
};

// ---- detail ---------------------------------------------------------------------------------------

function statusCard(inst, admin) {
  const st = shownStatus(inst);
  const s = STATUS[st] || { label: st, line: '' };
  const op = inst.op;
  const running = op && op.status === 'running';
  let title = running && OP_LABEL[op.kind] && !MOVING.has(inst.status) ? OP_LABEL[op.kind] : s.label;
  let line = s.line;
  if (st === 'degraded') line = 'Worca reports a problem in its last heartbeat. Pipelines keep running.';
  if (st === 'failed') { title = 'Setup stopped'; line = 'Nothing more is being set up.'; }
  if (inst.status === 'creating' && !inst.error) line = 'You can leave this page; we email the admins when it is ready.';
  const h = healthText(inst);
  return html`<div class="card stack inst-status" id="inst-status">
    <div class="inst-status-top">${glyph(running && !MOVING.has(inst.status) ? 'creating' : st, true)}<div class="inst-status-t"><b id="inst-state">${title}</b><div class="ink2">${line}</div></div></div>
    ${showSteps(inst) ? stepList(inst) : ''}
    ${inst.status !== 'creating' ? html`<div class="grid g3 inst-minis">${pipelineTiles(inst.pipelines)}<div class="mini"><b class="inst-beat">${inst.lastHeartbeatAt ? relTime(inst.lastHeartbeatAt) : 'never'}</b><span>last heartbeat</span></div></div>` : ''}
    ${upgradeAvailable(inst) && inst.status === 'running' && !inst.versionWithdrawn ? html`<div class="banner violet" id="inst-upgrade">${icon('arrowUp')}<div class="grow"><b>Worca ${inst.availableVersion} is available.</b> This instance runs ${inst.version || 'an older version'}. Upgrading restarts it for about a minute; running pipelines are interrupted and can be resumed afterwards.</div>${admin ? html`<button class="btn sm" id="upgrade">Upgrade to ${inst.availableVersion}</button>` : ''}</div>` : ''}
    <dl class="kv inst-kv">
      <dt>Address</dt><dd><span class="mono">${inst.host || '—'}</span>${inst.url ? html` <button type="button" class="btn ghost sm inst-copy" id="copy-url" aria-label="Copy the address">${icon('copy')}Copy</button>` : ''}</dd>
      <dt>Health</dt><dd><span class="inst-health"><span class="dot inst-dot-${h.tone}"></span>${h.label}</span>${h.line ? html` <span class="muted">${h.line}</span>` : ''}</dd>
      <dt>Version</dt><dd><span class="mono" id="inst-version">${inst.version || '—'}</span>${inst.releaseCandidate ? html` <span class="pill amber" id="inst-rc" title="A release candidate: it stays until an admin picks another version">release candidate</span>` : ''}${inst.upgradingTo ? html` <span class="muted">→ <span class="mono">${inst.upgradingTo}</span></span>` : ''}${admin && canChangeVersion(inst) ? html` <button type="button" class="btn ghost sm inst-copy" id="change-version">${icon('refresh')}Change version</button>` : ''}</dd>
      ${computeRows(inst)}
    </dl>
  </div>`;
}

/** Region and resources as the compute provider last reported them (null until the first check). */
function computeRows(inst) {
  const c = inst.compute;
  if (inst.status === 'creating' && !c) return '';
  if (!c) return html`<dt>Region</dt><dd class="muted" id="inst-region">Not checked yet</dd>`;
  const where = c.regionLabel || c.region;
  const area = where ? where.replace(/ \(.*\)$/, '') : null;
  const note = c.eu === false ? html`<span class="fact-warn" id="inst-region-note">This instance runs in ${area}. New instances run in the EU; to move it, create a new instance and move your work.</span>` : '';
  return html`<dt>Region</dt><dd id="inst-region">${where || html`<span class="muted">Unknown</span>`}${note}</dd>
    <dt>Resources</dt><dd><span class="fact-rows" id="inst-resources">${COMPUTE_SERVICES.map(([k, label]) => html`<span>${label} ${serviceSize(c.services?.[k])}</span>`)}</span></dd>`;
}

function banners(inst, admin) {
  const out = [];
  // D77: the platform withdrew the version it runs. It keeps running; the admins choose when to move.
  if (inst.versionWithdrawn && inst.status !== 'deleting') {
    const to = upgradeAvailable(inst) ? inst.availableVersion : null;
    out.push(html`<div class="banner amber" id="inst-withdrawn">${icon('alert')}<div class="grow"><b>Worca ${inst.version} was withdrawn by the platform.</b> ${inst.versionWithdrawn.reason ? html`Reason: ${inst.versionWithdrawn.reason} ` : ''}This instance keeps running as before.${to ? html` We recommend moving it to ${to}; that restarts it for about a minute.` : ''}${admin ? '' : ' Your org admins can change its version.'}</div>${admin && canChangeVersion(inst) ? html`<button class="btn sm" id="withdrawn-move">${to ? `Move to ${to}` : 'Change version'}</button>` : ''}</div>`);
  }
  if (inst.status === 'stopped') {
    out.push(html`<div class="banner inst-red" id="inst-stopped">${icon('stop')}<div class="grow"><b>Stopped by the platform.</b> ${inst.stoppedReason ? html`Reason: ${inst.stoppedReason}. ` : ''}Nobody can open it until Worca support lifts the stop.${abuseContact()}${admin ? ' You can still delete it.' : ''}</div></div>`);
  }
  if (inst.error && (inst.status === 'creating' || inst.op?.status === 'failed')) {
    out.push(html`<div class="banner inst-red" id="inst-error">${icon('alert')}<div class="grow"><b>${errorLine(inst.error, inst.errorReason, inst.errorSource)}</b>${inst.status === 'creating' && admin ? (inst.errorReason === 'provider_limit' ? ' Delete it and create it again later.' : ' Delete it and create it again.') : ''}</div></div>`);
  } else if (inst.error && inst.status === 'running') {
    out.push(html`<div class="banner amber" id="inst-error">${icon('alert')}<div class="grow">${errorLine(inst.error, inst.errorReason, inst.errorSource)}</div></div>`);
  }
  return out;
}

function accessSection(ctx, inst, admin, policy) {
  const teams = teamNames(inst);
  const teamLine = teams.length ? teams.join(', ') : 'No team yet: only admins can manage it, nobody can open it. Give it a team.';
  return html`<div><div class="label">Access</div><div class="rows">
    ${admin
      ? html`<button type="button" class="row click inst-rowbtn" id="edit-teams">${icon('team')}<div class="t"><b>Teams</b><span>${teamLine}</span></div><div class="r">Change ${icon('chev')}</div></button>
        <button type="button" class="row click inst-rowbtn" id="edit-policy" ${policy ? '' : 'disabled'}>${icon('shield')}<div class="t"><b>Sign-in for this instance</b><span id="policy-line">${policy ? policyLabel(policy) : 'Not available'}</span></div><div class="r">Change ${icon('chev')}</div></button>`
      : html`<div class="row">${icon('team')}<div class="t"><b>Teams</b><span>${teamLine}</span></div></div>`}
  </div></div>`;
}

/**
 * Automatic updates (D26 as amended, D75): micro releases, and minor ones on top. Tenant admins
 * switch them (PUT …/auto-update, one mode: off, micro or minor); members see the state. Minor
 * needs micro: its switch is off and disabled while micro is off.
 */
function autoUpdateRow(inst, admin) {
  const micro = inst.autoUpdate === 'micro' || inst.autoUpdate === 'minor';
  const minor = inst.autoUpdate === 'minor';
  const line = 'Install micro releases (x.y.Z) automatically while the instance is idle';
  const minorLine = micro
    ? 'Also install minor releases (x.Y.0). They can change how Worca stores its data; a failed one is rolled back'
    : 'Needs micro releases on';
  const failed = inst.releaseCandidate
    ? html`<span class="muted" id="auto-update-rc">Paused while it runs the release candidate ${inst.version}. Change version moves it to a release.</span>`
    : inst.autoUpdateFailedVersion
      ? html`<span class="muted" id="auto-update-failed">The automatic update to ${inst.autoUpdateFailedVersion} was rolled back; that version is skipped.</span>`
      : '';
  if (!admin) {
    return html`<div class="row" id="auto-update-row">${icon('refresh')}<div class="t"><b>Automatic updates</b><span>${line}</span>${failed}</div><div class="r" id="auto-update-state">${micro ? 'On' : 'Off'}</div></div>
      <div class="row" id="auto-update-minor-row">${icon('refresh')}<div class="t"><b>Minor releases too</b><span>${minorLine}</span></div><div class="r" id="auto-update-minor-state">${minor ? 'On' : 'Off'}</div></div>`;
  }
  return html`<label class="row" id="auto-update-row" for="auto-update">${icon('refresh')}<div class="t"><b>Automatic updates</b><span>${line}</span>${failed}</div>
    <div class="r"><span class="switch"><input type="checkbox" id="auto-update" ${micro ? 'checked' : ''}><i></i></span></div></label>
    <label class="row" id="auto-update-minor-row" for="auto-update-minor">${icon('refresh')}<div class="t"><b>Minor releases too</b><span>${minorLine}</span></div>
    <div class="r"><span class="switch"><input type="checkbox" id="auto-update-minor" ${minor ? 'checked' : ''} ${micro ? '' : 'disabled'}><i></i></span></div></label>`;
}

// ---- remote access in Worca (D72) -------------------------------------------------------------

/** "Terminal and actions off" and the like, from the instance's remoteAccess. */
function remoteLine(ra) {
  const t = !!ra?.terminal, a = !!ra?.actions;
  if (t && a) return 'Terminal and actions on';
  if (t) return 'Terminal on, actions off';
  if (a) return 'Actions on, terminal off';
  return 'Terminal and actions off';
}
const REMOTE_WARNING = 'Either one gives everyone who can open this instance a shell or commands that run as the Worca server, with access to its settings and environment. Agents stay isolated either way.';

/** Tenant admins change it (POST …/remote-access); members see the state. */
function remoteRow(inst, admin) {
  const ra = inst.remoteAccess || {};
  const pending = ra.pending && inst.op?.status !== 'running'
    ? html`<span class="muted" id="remote-pending">${inst.status === 'running' ? 'Not applied yet: save again to retry.' : 'Applies when the instance next starts.'}</span>`
    : '';
  const line = html`<span id="remote-line">${remoteLine(ra)}</span>`;
  if (!admin) return html`<div class="row" id="remote-row">${icon('lock')}<div class="t"><b>Remote access in Worca</b>${line}${pending}</div></div>`;
  return html`<button type="button" class="row click inst-rowbtn" id="edit-remote">${icon('lock')}<div class="t"><b>Remote access in Worca</b>${line}${pending}</div><div class="r">Change ${icon('chev')}</div></button>`;
}

// ---- compute size (D78) ---------------------------------------------------------------------------

const gb = (mb) => `${+(mb / 1024).toFixed(1)} GB`;
/** "2 vCPU · 4 GB · 4 agents at once" for a size from the API. */
export const sizeFacts = (s) => `${s.vcpu} vCPU · ${gb(s.memoryMb)} · ${plural(s.maxParallel, 'agent')} at once`;

/** The instance's compute size; tenant admins open the dialog, members read it. */
function sizeRow(inst, admin) {
  const s = inst.size;
  if (!s) return '';
  const pending = s.pending && inst.op?.status !== 'running'
    ? html`<span class="muted" id="size-pending">${inst.status === 'running' ? (admin ? 'Not applied yet: save again to retry.' : 'Not applied yet.') : 'Applies when the instance next starts.'}</span>`
    : '';
  const body = html`${icon('server')}<div class="t"><b>Compute size</b><span id="size-line">${s.name} · ${sizeFacts(s)}</span>${pending}</div>`;
  if (!admin || inst.status === 'creating' || inst.status === 'deleting') return html`<div class="row" id="size-row">${body}</div>`;
  return html`<button type="button" class="row click inst-rowbtn" id="edit-size">${body}<div class="r">Change ${icon('chev')}</div></button>`;
}

/** The compute provider's instance settings (docs/providers.md "Settings"); only when it declares some. */
function providerRow(inst, admin, fields) {
  if (!hasFields(fields)) return '';
  const body = html`${icon('server')}<div class="t"><b>Hosting settings</b><span id="pf-line">${fieldsLine(fields, inst.providerSettings || {})}</span></div>`;
  if (!admin || inst.status === 'deleting') return html`<div class="row" id="pf-row">${body}</div>`;
  return html`<button type="button" class="row click inst-rowbtn" id="edit-provider">${body}<div class="r">Change ${icon('chev')}</div></button>`;
}

// ---- outbound network (D73) ---------------------------------------------------------------------

/** The effective policy and where it comes from; tenant admins open the dialog, members read it. */
function egressRow(inst, admin, eg) {
  if (!eg) return '';
  const src = eg.inherited ? 'Same as the org' : 'Own policy for this instance';
  const pending = eg.pending && inst.op?.status !== 'running'
    ? html`<span class="muted" id="egress-pending">${inst.status === 'running' ? (admin ? 'Not applied yet: save again to retry.' : 'Not applied yet.') : 'Applies when the instance next starts.'}</span>`
    : '';
  const body = html`${icon('globe')}<div class="t"><b>Outbound network</b><span id="egress-line">${policyLine(eg.effective)} · ${src}</span>${policyDetails(eg.effective)}${pending}</div>`;
  if (!admin) return html`<div class="row" id="egress-row">${body}</div>`;
  return html`<button type="button" class="row click inst-rowbtn" id="edit-egress">${body}<div class="r">Change ${icon('chev')}</div></button>`;
}

function runsSection(inst, admin, eg, git, pfields) {
  const next = inst.nextScheduledAt ? inst.nextScheduledAt * 1000 : null;
  const sleep = inst.suspendable === null || inst.suspendable === undefined
    ? 'Not reported yet'
    : inst.suspendable ? 'Sleeps after a while without visits; wakes when someone opens it' : 'Stays awake: pipelines are running';
  return html`<div><div class="label">How it runs</div><div class="rows">
    <div class="row">${icon('moon')}<div class="t"><b>Sleep when idle</b><span>${sleep}</span></div></div>
    ${autoUpdateRow(inst, admin)}
    ${sizeRow(inst, admin)}
    ${remoteRow(inst, admin)}
    ${egressRow(inst, admin, eg)}
    ${gitRow(inst, admin, git)}
    ${providerRow(inst, admin, pfields)}
    <div class="row">${icon('history')}<div class="t"><b>Next scheduled run</b><span>${next ? html`${dateTime(next)} (${relTime(next)}), woken shortly before` : 'None'}</span></div></div>
    <div class="row">${icon('plus')}<div class="t"><b>Created</b><span>${dateShort(inst.createdAt)}</span></div></div>
  </div></div>`;
}

function detailMarkup(ctx, inst, admin, policy, eg, git, pfields) {
  const orgId = ctx.orgId;
  return html`<div class="page narrow">
    <div><nav class="crumb inst-crumb" aria-label="Breadcrumb"><a href="${admin ? orgBase(orgId) + '/instances' : orgBase(orgId)}">Instances</a>${icon('chev')}<span>${nameOf(inst)}</span></nav>
      <div class="head"><div class="inst-head-t"><h1 id="inst-name">${nameOf(inst)}</h1><p class="mono inst-host">${inst.url && !CLOSED.has(inst.status) ? html`<a href="${inst.url}" target="_blank" rel="noopener">${inst.url}</a>` : inst.url || inst.host || ''} · created ${dateShort(inst.createdAt)}</p></div>
        <div class="acts">${admin ? html`<button type="button" class="btn" id="rename">Rename</button>` : ''}${openLink(inst)}</div></div></div>
    ${banners(inst, admin)}
    ${statusCard(inst, admin)}
    <div class="card stack inst-sections">${accessSection(ctx, inst, admin, policy)}${runsSection(inst, admin, eg, git, pfields)}</div>
    ${admin ? html`<div class="card danger-zone" id="danger"><div class="card-head"><h2>Delete this instance</h2></div>
      <div class="between"><span class="ink2 inst-danger-t">Deletes its data, its address and its history for good. You confirm by typing its name, with your passkey, and through a link we email you.</span>
      <button type="button" class="btn danger" id="del" ${inst.status === 'deleting' ? 'disabled' : ''}>${icon('trash')}Delete instance</button></div></div>` : ''}
  </div>`;
}

const detail = {
  path: '/o/:orgId/instances/:id',
  // Tenant users reach instances from the org home ("Instances" there is the overview entry).
  nav: (params) => (isOrgAdmin(params.orgId) ? 'instances' : 'overview'),
  title: 'Instance',
  async render(ctx) {
    const orgId = ctx.orgId;
    const id = ctx.params.id;
    const admin = isOrgAdmin(orgId);
    const path = p`/api/orgs/${orgId}/instances/${id}`;
    const loadPolicy = () => (admin ? api.get(`${path}/policy`).catch(() => null) : Promise.resolve(null));
    const loadEgress = () => api.get(`${path}/egress`).catch(() => null);
    const loadGit = () => api.get(`${path}/git`).catch(() => null);
    // The provider's instance settings fields come with the org summary (admins only; they change on deploys, not here).
    const loadFields = () => (admin ? api.get(p`/api/orgs/${orgId}/summary`).then((s) => s.instances?.providerFields || []).catch(() => []) : Promise.resolve([]));
    let [inst, policy, egress, git, pfields] = await Promise.all([api.get(path), loadPolicy(), loadEgress(), loadGit(), loadFields()]);
    if (!ctx.alive()) return;
    let seen = '';

    const draw = () => {
      seen = JSON.stringify([inst, policy, egress, git]);
      document.title = `${nameOf(inst)} · ${brand.product}`;
      ctx.set(detailMarkup(ctx, inst, admin, policy, egress, git, pfields));
      bind();
    };
    const reload = async ({ withPolicy = false } = {}) => {
      try {
        const [next, pol, eg, gt] = await Promise.all([api.get(path), withPolicy ? loadPolicy() : Promise.resolve(policy), loadEgress(), loadGit()]);
        if (!ctx.alive()) return;
        inst = next;
        policy = pol;
        egress = eg;
        git = gt;
        if (JSON.stringify([inst, policy, egress, git]) !== seen) draw();
      } catch (e) {
        if (e instanceof ApiError && e.status === 404 && ctx.alive()) {
          toast(`${nameOf(inst)} was deleted`, 'info');
          navigate(admin ? orgBase(orgId) + '/instances' : orgBase(orgId));
          return;
        }
        throw e;
      }
    };

    function bind() {
      const el = ctx.el;
      $('#copy-url', el)?.addEventListener('click', () => copyText(inst.url));
      if (!admin) return;
      $('#rename', el)?.addEventListener('click', () => renameModal());
      $('#upgrade', el)?.addEventListener('click', () => versionModal());
      $('#withdrawn-move', el)?.addEventListener('click', () => versionModal());
      $('#change-version', el)?.addEventListener('click', () => versionModal());
      $('#edit-teams', el)?.addEventListener('click', () => teamsModal());
      $('#auto-update', el)?.addEventListener('change', (e) => setAutoUpdate(e.currentTarget));
      $('#auto-update-minor', el)?.addEventListener('change', (e) => setAutoUpdate(e.currentTarget));
      $('#edit-remote', el)?.addEventListener('click', () => remoteModal());
      $('#edit-size', el)?.addEventListener('click', (e) => busy(e.currentTarget, () => sizeModal()));
      $('#edit-egress', el)?.addEventListener('click', () => egressModal());
      $('#edit-git', el)?.addEventListener('click', () => git && gitModal({ inst, git, path: `${path}/git`, href: instHref(orgId, inst.id), name: nameOf(inst), reload, alive: ctx.alive }));
      $('#edit-policy', el)?.addEventListener('click', () => policyModal());
      $('#edit-provider', el)?.addEventListener('click', () => providerModal());
      $('#del', el)?.addEventListener('click', (e) => busy(e.currentTarget, deleteFlow));
    }

    /** The provider's instance settings; stored now, used from the instance's next operation on. */
    function providerModal() {
      const m = openModal(html`<h2>Hosting settings</h2>
        <p>Settings of the hosting provider for ${nameOf(inst)}. They are saved now and used from its next start, upgrade or settings change on.</p>
        <form class="form" id="pf-form" novalidate>${providerFields(pfields, { values: inst.providerSettings || {}, prefix: 'pf' })}
        ${alertBox('pf-err')}
        <div class="acts"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" id="pf-go">Save</button></div></form>`);
      $('#pf-form', m).addEventListener('submit', (e) => {
        e.preventDefault();
        clearFieldErrors(m);
        showAlert($('#pf-err', m), '');
        busy($('#pf-go', m), async () => {
          try {
            await api.put(`${path}/provider-settings`, { values: readProviderFields(pfields, m, 'pf') });
          } catch (x) {
            if (x instanceof ApiError && x.code === 'invalid_provider_settings' && showFieldProblems(x.body?.problems, m, 'pf')) return;
            showAlert($('#pf-err', m), errorText(x));
            return;
          }
          closeModal();
          toast('Saved; used from the next operation on');
          await reload();
        });
      });
    }

    function renameModal() {
      const m = openModal(html`<h2>Rename instance</h2>
        <form class="form" id="rn-form"><div class="field"><label for="rn-name">Instance name</label><input class="inp" id="rn-name" maxlength="100" required autocomplete="off" value="${inst.name || ''}">
          <span class="hint">Its address stays the same.</span></div>
        <div class="acts"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" id="rn-go">Save</button></div></form>`);
      const inp = $('#rn-name', m);
      inp.select();
      $('#rn-form', m).addEventListener('submit', (e) => {
        e.preventDefault();
        const name = inp.value.trim();
        if (!name) return void fieldError(inp, 'Give it a name.');
        busy($('#rn-go', m), async () => {
          try {
            await api.patch(path, { name });
          } catch (x) {
            if (x instanceof ApiError && x.code === 'invalid_body') return void fieldError(inp, 'Use 1 to 100 characters.');
            throw x;
          }
          closeModal();
          toast('Renamed');
          await reload();
        });
      });
    }

    /**
     * Moves the instance to a published version (D26), the latest selected first. An older pick is a
     * downgrade, with a warning. Opened from the upgrade banner and from "Change version".
     */
    async function versionModal() {
      let list;
      try {
        list = await api.get(`${path}/versions`);
      } catch (e) {
        toast(errorText(e), 'error');
        return;
      }
      if (!ctx.alive()) return;
      const versions = list.versions || [];
      const pick = versions.find((v) => v.latest) || versions[0];
      const label = (v) => [v.version, v.rc ? 'release candidate' : '', v.latest ? 'latest' : '', v.current ? 'current' : '', v.direction === 'refresh' ? 'component update' : ''].filter(Boolean).join(' · ');
      const m = openModal(html`<h2>Change the Worca version</h2>
        <p>${nameOf(inst)} runs ${list.current ? html`<span class="mono">${list.current}</span>` : 'an unknown version'}. It restarts with the version you pick; its address and data stay. Pipelines running at that moment are interrupted and can be resumed afterwards. Pick a quiet moment.</p>
        <div class="field"><label for="up-version">Version</label><select class="inp" id="up-version">${versions.map((v) => html`<option value="${v.version}" ${v === pick ? 'selected' : ''}>${label(v)}</option>`)}</select></div>
        <div class="banner violet" id="up-refresh" hidden>${icon('info')}<div class="grow">Same version, newer tunnel connector. Only the connector restarts: Worca keeps running and no pipeline is interrupted; open pages reconnect within seconds.</div></div>
        <div class="banner amber" id="up-rc" hidden>${icon('alert')}<div class="grow">A release candidate is for trying the next release before it is out. The instance stays on it: automatic updates leave it alone, also once the release is out, until you pick another version here.</div></div>
        <div class="banner amber" id="up-older" hidden>${icon('alert')}<div class="grow">This is an older version than the instance runs. Data written by a newer version may not be readable by an older one; use this to step back from a bad release.</div></div>
        ${alertBox('up-err')}
        <div class="acts"><button type="button" class="btn" data-close>Not now</button><button type="button" class="btn primary" id="up-go"></button></div>`);
      const sel = $('#up-version', m);
      const go = $('#up-go', m);
      const chosen = () => versions.find((v) => v.version === sel.value);
      const sync = () => {
        const v = chosen();
        const older = v?.direction === 'downgrade';
        $('#up-older', m).hidden = !older;
        $('#up-refresh', m).hidden = v?.direction !== 'refresh';
        $('#up-rc', m).hidden = !v?.rc || v.direction === 'current' || v.direction === 'refresh';
        go.disabled = !v || v.direction === 'current';
        setHtml(go, !v || v.direction === 'current' ? html`Already on ${v?.version || 'it'}` : v.direction === 'refresh' ? html`Update components` : older || v.rc ? html`Change to ${v.version}` : html`${icon('arrowUp')}Upgrade to ${v.version}`);
      };
      sel.addEventListener('change', sync);
      sync();
      go.addEventListener('click', (e) => busy(e.currentTarget, async () => {
        const v = chosen();
        if (!v) return;
        const to = v.version;
        try {
          await api.post(`${path}/upgrade`, { version: to });
        } catch (x) {
          const text = {
            instance_not_running: 'Version changes start only while the instance is running and nothing else is under way.',
            already_on_version: `It already runs ${to}.`,
            unknown_version: `Worca ${to} isn't published.`,
            invalid_version: `Worca ${to} isn't a version we can install.`,
            release_candidates_off: 'Release candidates are off for this org.',
          }[x?.code];
          if (text) { showAlert($('#up-err', m), text); await reload().catch(() => {}); return; }
          throw x;
        }
        closeModal();
        if (v.direction === 'refresh') {
          toast('Updating components');
          watchOp({ url: path, href: instHref(orgId, inst.id), kind: 'refresh', ok: `${nameOf(inst)}'s components are up to date`, fail: `${nameOf(inst)}'s components couldn't be updated` });
          await reload();
          return;
        }
        toast(v.direction === 'downgrade' ? `Changing to ${to}` : `Upgrading to ${to}`);
        watchOp({ url: path, href: instHref(orgId, inst.id), kind: 'upgrade', ok: `${nameOf(inst)} is on ${to}`, fail: `${nameOf(inst)} couldn't move to ${to}` });
        await reload();
      }));
    }

    /** D75: the two switches are one mode. Micro off turns minor off too. */
    async function setAutoUpdate(box) {
      const microOn = $('#auto-update')?.checked;
      const mode = !microOn ? 'off' : $('#auto-update-minor')?.checked ? 'minor' : 'micro';
      box.disabled = true;
      try {
        await api.put(`${path}/auto-update`, { mode }); // the switch shows the new state
        await reload();
      } catch (x) {
        box.checked = !box.checked;
        toast(errorText(x), 'error');
      } finally {
        box.disabled = false;
      }
    }

    /**
     * D78: the sizes the org's plan allows (and the current one, should the plan no longer include
     * it). A running instance restarts Worca to apply it; others get it on their next start.
     */
    async function sizeModal({ alert = '' } = {}) {
      const summary = await api.get(p`/api/orgs/${orgId}/summary`);
      const allowed = summary.instances?.sizes || [];
      const cur = inst.size || {};
      const options = allowed.some((s) => s.id === cur.id) ? allowed : [cur, ...allowed];
      const running = inst.status === 'running';
      const m = openModal(html`<h2>Compute size</h2>
        <p>How much CPU and memory Worca on ${nameOf(inst)} may use, and how many agents and scripts it runs at once. Usage is billed, not the size, so a larger size only costs more while Worca uses it.</p>
        <fieldset class="field inst-fieldset"><legend class="pc-sr">Size</legend><div class="checks" id="sz-options">
          ${options.map((s) => html`<label class="check"><input type="radio" name="sz" value="${s.id}" ${s.id === cur.id ? 'checked' : ''}><span class="t"><b>${s.name}${s.id === cur.id ? html` <span class="muted">current</span>` : ''}</b><span>${sizeFacts(s)}${allowed.some((a) => a.id === s.id) ? '' : ' · no longer in your plan'}</span></span></label>`)}
        </div></fieldset>
        ${allowed.length <= 1 ? html`<p class="hint" id="sz-plan">Your plan includes one size. Ask Worca support for a larger plan.</p>` : ''}
        <div class="banner blue">${icon('info')}<div class="grow">${running ? 'Saving restarts Worca: active runs pause and resume.' : 'It applies when the instance next starts.'}</div></div>
        ${alertBox('sz-err')}
        <div class="acts"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="sz-go" disabled>${running ? 'Save and restart Worca' : 'Save'}</button></div>`);
      showAlert($('#sz-err', m), alert);
      const go = $('#sz-go', m);
      const picked = () => $('input[name=sz]:checked', m)?.value;
      const retry = () => picked() === cur.id && cur.pending && running;
      const sync = () => { go.disabled = picked() === cur.id && !retry(); };
      for (const r of $$('input[name=sz]', m)) r.addEventListener('change', sync);
      sync();
      go.addEventListener('click', (e) => busy(e.currentTarget, async () => {
        const size = picked();
        if (!size) return;
        showAlert($('#sz-err', m), '');
        let res;
        try {
          res = await api.post(`${path}/size`, { size });
        } catch (x) {
          const text = (x instanceof ApiError && SIZE_REFUSED[x.code]) || errorText(x);
          await reload().catch(() => {});
          if (!ctx.alive()) return;
          if (x?.code === 'size_changed' || x?.code === 'size_not_allowed') return void sizeModal({ alert: text });
          showAlert($('#sz-err', m), text);
          return;
        }
        closeModal();
        const name = res.size?.name || size;
        if (res.result === 'applying') watchOp({ url: path, href: instHref(orgId, inst.id), kind: 'reconfigure', ok: `${nameOf(inst)} is on ${name}`, fail: `${nameOf(inst)} couldn't be moved to ${name}` });
        toast(res.result === 'applying' ? 'Saved; Worca is restarting' : res.result === 'saved' ? 'Saved; applies when the instance next starts' : 'Nothing changed');
        await reload();
      }));
    }

    /**
     * D72: two switches, then a confirmation step in the same dialog before anything is saved.
     * Turning one on may ask for a passkey first (protectedAction steps up on mfa_required).
     */
    function remoteModal({ alert = '' } = {}) {
      const ra = inst.remoteAccess || {};
      const running = inst.status === 'running';
      const m = openModal(html`<h2>Remote access in Worca</h2>
        <div id="ra-pick">
          <p>Hosted Worca turns these off. Turn one on only if everyone who can open ${nameOf(inst)} should have it.</p>
          <div class="rows">
            <label class="row" for="ra-terminal">${icon('laptop')}<div class="t"><b>Terminal</b><span>A shell in the browser, in the Worca container</span></div>
              <div class="r"><span class="switch"><input type="checkbox" id="ra-terminal" ${ra.terminal ? 'checked' : ''}><i></i></span></div></label>
            <label class="row" for="ra-actions">${icon('play')}<div class="t"><b>Actions</b><span>Run and stop actions and stacks; open an editor, terminal or file manager</span></div>
              <div class="r"><span class="switch"><input type="checkbox" id="ra-actions" ${ra.actions ? 'checked' : ''}><i></i></span></div></label>
          </div>
          <div class="banner amber" id="ra-warning">${icon('alert')}<div class="grow">${REMOTE_WARNING} ${running ? 'Saving restarts Worca: active runs pause and resume.' : 'It applies when the instance next starts.'}</div></div>
          ${alertBox('ra-err-pick')}
          <div class="acts"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="ra-next" disabled>Continue</button></div>
        </div>
        <div id="ra-confirm" hidden>
          <p id="ra-summary"></p>
          ${alertBox('ra-err')}
          <div class="acts"><button type="button" class="btn" id="ra-back">Back</button><button type="button" class="btn primary" id="ra-go"></button></div>
        </div>`);
      const t = $('#ra-terminal', m), a = $('#ra-actions', m), next = $('#ra-next', m);
      showAlert($('#ra-err-pick', m), alert);
      const changed = () => t.checked !== !!ra.terminal || a.checked !== !!ra.actions;
      // The same values still pending on a running instance: saving applies them again.
      const retry = () => !changed() && ra.pending && running;
      const sync = () => { next.disabled = !changed() && !retry(); };
      t.addEventListener('change', sync);
      a.addEventListener('change', sync);
      sync();
      next.addEventListener('click', () => {
        const want = { terminal: t.checked, actions: a.checked };
        const on = [want.terminal && 'the terminal', want.actions && 'actions'].filter(Boolean);
        setHtml($('#ra-summary', m), html`${on.length ? html`<b>${joinWords(on).replace(/ or /, ' and ')}</b> will be on for everyone who can open ${nameOf(inst)}, running as the Worca server.` : html`The terminal and actions will be off on ${nameOf(inst)}.`}
          ${running ? ' Worca restarts now; active runs pause and resume.' : ' Nothing restarts now; it applies when the instance next starts.'}`);
        setHtml($('#ra-go', m), running ? 'Save and restart Worca' : 'Save');
        $('#ra-pick', m).hidden = true;
        $('#ra-confirm', m).hidden = false;
        $('#ra-go', m).focus();
      });
      $('#ra-back', m).addEventListener('click', () => { $('#ra-confirm', m).hidden = true; $('#ra-pick', m).hidden = false; });
      $('#ra-go', m).addEventListener('click', (e) => busy(e.currentTarget, async () => {
        const want = { terminal: t.checked, actions: a.checked };
        showAlert($('#ra-err', m), '');
        let res;
        try {
          res = await protectedAction({
            title: 'Change remote access in Worca', typed: false, danger: false,
            call: () => api.raw('POST', `${path}/remote-access`, want),
          });
        } catch (x) {
          // Refused: said in the dialog (opened again when a passkey step replaced it, or with the
          // current settings when someone else changed them).
          const text = (x instanceof ApiError && REMOTE_REFUSED[x.code]) || errorText(x);
          await reload().catch(() => {});
          if (!ctx.alive()) return;
          if (x?.code === 'remote_access_changed' || !m.isConnected) return void remoteModal({ alert: text });
          showAlert($('#ra-err', m), text);
          return;
        }
        if (!res) return;
        if (m.isConnected) closeModal(); // not the "check your email" dialog that may have replaced it
        const result = res.body?.result;
        if (result === 'applying') watchOp({ url: path, href: instHref(orgId, inst.id), kind: 'reconfigure', ok: `Remote access on ${nameOf(inst)} changed`, fail: `Remote access on ${nameOf(inst)} couldn't be changed` });
        toast(result === 'applying' ? 'Saved; Worca is restarting' : result === 'saved' ? 'Saved; applies when the instance next starts' : 'Nothing changed');
        await reload();
      }));
    }

    /**
     * D73: "Same as the org" or an own policy (the shared editor), then a confirmation step in the
     * same dialog. Loosening may ask for a passkey first (protectedAction steps up on mfa_required).
     */
    function egressModal({ alert = '' } = {}) {
      const eg = egress;
      if (!eg) return;
      const running = inst.status === 'running';
      const m = openModal(html`<h2>Outbound network</h2>
        <div id="ie-pick">
          <p>What Worca's agents on ${nameOf(inst)} may reach on the internet.</p>
          <div class="banner blue">${icon('info')}<div class="grow">${EGRESS_NOTE}</div></div>
          <fieldset class="field eg-fieldset"><legend>Policy</legend><div class="checks">
            <label class="check"><input type="radio" name="ie-src" value="org" ${eg.inherited ? 'checked' : ''}><span class="t"><b>Same as the org</b><span>${policyLine(eg.org.policy)}</span></span></label>
            <label class="check"><input type="radio" name="ie-src" value="own" ${eg.inherited ? '' : 'checked'}><span class="t"><b>Own policy for this instance</b><span>Replaces the org's policy as a whole</span></span></label>
          </div></fieldset>
          <div id="ie-own">${editorMarkup('ie', eg.override || eg.org.policy, eg.platformHosts)}</div>
          ${alertBox('ie-err-pick')}
          <div class="acts"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="ie-next" disabled>Continue</button></div>
        </div>
        <div id="ie-confirm" hidden>
          <p id="ie-summary"></p>
          ${alertBox('ie-err')}
          <div class="acts"><button type="button" class="btn" id="ie-back">Back</button><button type="button" class="btn primary" id="ie-go"></button></div>
        </div>`, { wide: true });
      const next = $('#ie-next', m);
      const own = () => $('input[name="ie-src"]:checked', m)?.value === 'own';
      const want = () => (own() ? readEditor(m, 'ie') : null);
      const changed = () => !samePolicy(want(), eg.override);
      // Unchanged but not applied on a running instance: saving applies it again.
      const retry = () => !changed() && eg.pending && running;
      const sync = () => {
        $('#ie-own', m).hidden = !own();
        next.disabled = !changed() && !retry();
      };
      for (const r of $$('input[name="ie-src"]', m)) r.addEventListener('change', sync);
      bindEditor(m, 'ie', sync);
      showAlert($('#ie-err-pick', m), alert);
      const back = () => { $('#ie-confirm', m).hidden = true; $('#ie-pick', m).hidden = false; };
      next.addEventListener('click', () => {
        clearFieldErrors(m);
        const w = want();
        const effective = w || eg.org.policy;
        const restarts = running && (!samePolicy(effective, eg.effective) || eg.pending);
        setHtml($('#ie-summary', m), html`${w ? html`${nameOf(inst)} gets its own policy: <b>${policyLine(w)}</b>.` : html`${nameOf(inst)} follows the org's policy again: <b>${policyLine(eg.org.policy)}</b>.`}
          ${restarts ? ' Worca restarts now; active runs pause and resume.' : running ? " Worca's policy stays the same, so nothing restarts." : ' Nothing restarts now; it applies when the instance next starts.'}`);
        setHtml($('#ie-go', m), restarts ? 'Save and restart Worca' : 'Save');
        $('#ie-pick', m).hidden = true;
        $('#ie-confirm', m).hidden = false;
        $('#ie-go', m).focus();
      });
      $('#ie-back', m).addEventListener('click', back);
      $('#ie-go', m).addEventListener('click', (e) => busy(e.currentTarget, async () => {
        showAlert($('#ie-err', m), '');
        let res;
        try {
          res = await protectedAction({
            title: 'Change the outbound network policy', typed: false, danger: false,
            call: () => api.raw('PUT', `${path}/egress`, { policy: want(), version: eg.version }),
          });
        } catch (x) {
          if (m.isConnected && showEgressRefusal(m, 'ie', x)) { back(); return; }
          const text = (x instanceof ApiError && EGRESS_REFUSED[x.code]) || errorText(x);
          await reload().catch(() => {});
          if (!ctx.alive()) return;
          if (x?.code === 'egress_changed' || !m.isConnected) return void egressModal({ alert: text });
          showAlert($('#ie-err', m), text);
          return;
        }
        if (!res) return;
        if (m.isConnected) closeModal();
        const result = res.body?.result;
        if (result === 'applying') watchOp({ url: path, href: instHref(orgId, inst.id), kind: 'reconfigure', ok: `The outbound network policy is applied on ${nameOf(inst)}`, fail: `The outbound network policy couldn't be applied on ${nameOf(inst)}` });
        toast({ applying: 'Saved; Worca is restarting', saved: 'Saved; applies when the instance next starts', stored: 'Saved', unchanged: 'Nothing changed' }[result] || 'Saved');
        await reload();
      }));
      sync();
    }

    const EGRESS_REFUSED = {
      egress_changed: 'Someone changed the outbound network policy meanwhile (here or for the org). This is the current one; check it and try again.',
      instance_busy: 'Something else is under way on this instance. Try again when it has finished.',
    };

    const SIZE_REFUSED = {
      size_changed: 'Someone changed the size meanwhile. This is the current one; check it and try again.',
      size_not_allowed: "Your plan doesn't include that size. These are the sizes it includes now.",
      instance_busy: 'Something else is under way on this instance. Try again when it has finished.',
    };
    const REMOTE_REFUSED = {
      remote_access_changed: 'Someone changed remote access meanwhile. These are the current settings; check them and try again.',
      instance_busy: 'Something else is under way on this instance. Try again when it has finished.',
    };

    async function teamsModal({ alert = '' } = {}) {
      let teams;
      try {
        teams = (await api.get(p`/api/orgs/${orgId}/teams`)).teams || [];
      } catch (e) {
        toast(errorText(e), 'error');
        return;
      }
      const granted = new Set(inst.teamIds || []);
      const m = openModal(html`<h2>Who can use ${nameOf(inst)}</h2>
        ${teams.length
          ? html`<fieldset class="field inst-fieldset"><legend class="inst-sr">Teams</legend><div class="checks">${teams.map((t) => html`<label class="check"><input type="checkbox" name="team" value="${t.id}" ${granted.has(t.id) ? 'checked' : ''}><span class="t"><b>${t.name || 'Unnamed team'}</b><span>${plural(t.members ?? 0, 'person', 'people')}</span></span></label>`)}</div></fieldset>
            <p class="hint">An instance always keeps at least one team. People who lose access are signed out of the instance within a minute.</p>`
          : html`<p>There are no teams yet. <a href="${orgBase(orgId) + '/teams'}">Create one</a> first.</p>`}
        ${alertBox('tm-err')}
        <div class="acts"><button type="button" class="btn" data-close>Cancel</button>${teams.length ? html`<button type="button" class="btn primary" id="tm-go">Save</button>` : ''}</div>`, { wide: false });
      for (const a of $$('a', m)) a.addEventListener('click', () => closeModal());
      showAlert($('#tm-err', m), alert);
      $('#tm-go', m)?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
        const teamIds = $$('input[name=team]:checked', m).map((x) => x.value);
        const lastTeam = () => void fieldError($$('input[name=team]', m), LAST_TEAM);
        if (!teamIds.length) return lastTeam(); // D71
        let res;
        try {
          res = await api.put(`${path}/teams`, { teamIds });
        } catch (x) {
          if (x instanceof ApiError && x.code === 'unknown_team') { await reload().catch(() => {}); return void teamsModal({ alert: 'One of the teams no longer exists. The list is up to date now; pick again.' }); }
          if (x instanceof ApiError && x.code === 'last_team') return lastTeam();
          throw x;
        }
        closeModal();
        toast(res.droppedUsers ? `Access updated · ${plural(res.droppedUsers, 'person', 'people')} signed out of it` : 'Access updated');
        await reload();
      }));
    }

    /** The instance's sign-in rule. A refusal opens it again with the choice kept and the problem shown. */
    function policyModal({ pick = null, methodsErr = '', alert = '' } = {}) {
      const orgAllowed = policy.orgAllowedMethods || [];
      const offered = orgAllowed.length ? orgAllowed : METHODS;
      const current = new Set(pick ?? policy.requiredMethods ?? []);
      const stricter = current.size > 0;
      const m = openModal(html`<h2>Sign-in for ${nameOf(inst)}</h2>
        <p>Stricter than the org if you like. People signed in another way are asked to sign in again before they get in.</p>
        <fieldset class="inst-fieldset"><legend class="inst-sr">Sign-in rule</legend><div class="checks">
          <label class="check"><input type="radio" name="pp" value="org" ${stricter ? '' : 'checked'}><span class="t"><b>Same as the org</b><span>${orgAllowed.length ? joinWords(methodList(orgAllowed)) : 'Any sign-in method'}</span></span></label>
          <label class="check"><input type="radio" name="pp" value="only" ${stricter ? 'checked' : ''}><span class="t"><b>Stricter: only some methods</b></span></label>
        </div></fieldset>
        <fieldset class="field inst-fieldset inst-methods" id="pp-methods" ${stricter ? '' : 'hidden'}><legend class="inst-sr">Allowed methods</legend><div class="checks">${offered.map((x) => html`<label class="check"><input type="checkbox" name="pm" value="${x}" ${current.has(x) ? 'checked' : ''}><span class="t"><b>${SIGN_IN_METHOD[x] || x}</b></span></label>`)}</div></fieldset>
        ${alertBox('pp-err')}
        <div class="acts"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="pp-go">Save</button></div>`);
      const box = $('#pp-methods', m);
      for (const r of $$('input[name=pp]', m)) r.addEventListener('change', () => { box.hidden = $('input[name=pp]:checked', m).value !== 'only'; });
      showAlert($('#pp-err', m), alert);
      if (methodsErr) fieldError($$('input[name=pm]', m), methodsErr);
      $('#pp-go', m).addEventListener('click', (e) => busy(e.currentTarget, async () => {
        const only = $('input[name=pp]:checked', m).value === 'only';
        const requiredMethods = only ? $$('input[name=pm]:checked', m).map((x) => x.value) : [];
        if (only && !requiredMethods.length) return void fieldError($$('input[name=pm]', m), 'Pick at least one method, or keep the org default.');
        showAlert($('#pp-err', m), '');
        let res;
        try {
          res = await protectedAction({
            title: 'Change sign-in for this instance',
            consequence: html`${nameOf(inst)} will accept ${requiredMethods.length ? html`only <b>${joinWords(methodList(requiredMethods))}</b>` : "the org's sign-in methods"}.`,
            name: inst.name,
            nameLabel: 'the instance name',
            typed: false,
            danger: false,
            actionLabel: 'Change sign-in',
            call: (confirmName) => api.raw('PUT', `${path}/policy`, confirmName === undefined ? { requiredMethods } : { requiredMethods, confirmName }),
          });
        } catch (x) {
          const field = x instanceof ApiError && x.code === 'not_narrowing' ? "The org's sign-in policy doesn't allow one of these methods. An instance can only be stricter than the org." : '';
          const text = field ? '' : x instanceof ApiError && x.code === 'confirm_name_mismatch' ? "That name didn't match. Nothing was changed." : errorText(x);
          if (!m.isConnected) return void policyModal({ pick: requiredMethods, methodsErr: field, alert: text });
          if (field) fieldError($$('input[name=pm]', m), field);
          else showAlert($('#pp-err', m), text);
          return;
        }
        if (!res) return;
        if (m.isConnected) closeModal(); // not the "check your email" dialog that may have replaced it
        if (res.status === 200) toast('Sign-in rule saved');
        await reload({ withPolicy: true });
      }));
    }

    async function deleteFlow() {
      const teams = teamNames(inst);
      try {
        await protectedAction({
          title: 'Delete instance',
          consequence: html`<b>${nameOf(inst)}</b> (${inst.host}) and all its data are deleted for good.${teams.length ? ` ${joinWords(teams).replace(/ or /, ' and ')} lose access right away.` : ''}`,
          name: inst.name,
          nameLabel: 'the instance name',
          actionLabel: 'Delete instance',
          call: (confirmName) => api.raw('POST', `${path}/delete`, { confirmName }),
        });
      } catch (x) {
        const text = { confirm_name_mismatch: "That name didn't match. Nothing was deleted.", already_deleting: 'It is already being deleted.' }[x?.code];
        if (text) { toast(text, 'error'); await reload(); return; }
        throw x;
      }
    }

    draw();
    livePoll(ctx, () => moving(inst), () => reload());
  },
};

export default [list, create, detail];
