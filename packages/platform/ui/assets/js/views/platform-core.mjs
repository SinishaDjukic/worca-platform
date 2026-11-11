// Platform console, the watching part (docs/ui.md "Platform console", prototype docs/prototypes/platform.js):
// /platform overview, /platform/orgs[/:id], /platform/instances[/:id], /platform/ops, /platform/releases.
// main.mjs wraps these views in the platform guard and the passkey gate (D24).
// D15: metadata only. Names, statuses, counts, versions and provider ids; never instance contents,
// and nothing here opens an instance or signs in as anyone.
import {
  $, $$, api, busy, closeModal, copyText, dateShort, dateTime, errorText, glyph, hasRole, html, icon, navigate, openModal,
  p, plural, protectedAction, relTime, setHtml, shownStatus, STATUS, statusPill, toast, COMPUTE_SERVICES, serviceSize, gbOf,
  fieldError, alertBox, showAlert, watchOp, clearFieldErrors, features,
} from '../core.mjs';
import { MODE_LABEL, policyDetails } from '../egress.mjs';
import { hasFields, providerFields, readProviderFields, showFieldProblems } from '../provider-fields.mjs';

// ---- capabilities (docs/internal-apis.md "cap x"): support < admin < superadmin ----------------
const CAP_ROLES = {
  'platform.view': ['support', 'admin', 'superadmin'],
  'tenants.manage': ['admin', 'superadmin'],
  'instances.stop': ['admin', 'superadmin'],
  'instances.rotate': ['admin', 'superadmin'],
  'waitlist.manage': ['admin', 'superadmin'],
  'system.settings': ['superadmin'],
  'newsletter.view': ['admin', 'superadmin'],
};
const can = (cap) => hasRole(...(CAP_ROLES[cap] || []));

// Thresholds of GET /stats (instances/crons.ts STALE_AFTER_MS, platform-routes STUCK_CREATING_MS);
// the overview reads the live values, the lists use these.
const SILENT_MS = 5 * 60_000;
const STUCK_CREATING_MS = 10 * 60_000;

// ---- small helpers ---------------------------------------------------------------------------------
const short = (id) => String(id || '').slice(0, 8);
const dur = (ms) => {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  const a = Math.max(0, ms);
  if (a < 60e3) return `${Math.max(1, Math.round(a / 1e3))} s`;
  if (a < 3600e3) return `${Math.round(a / 60e3)} min`;
  if (a < 86400e3) {
    const h = Math.floor(a / 3600e3), m = Math.round((a % 3600e3) / 60e3);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  return plural(Math.round(a / 86400e3), 'day');
};
const isSilent = (i, after = SILENT_MS) => i.status === 'running' && (!i.lastHeartbeatAt || Date.now() - i.lastHeartbeatAt > after);
const isStuckCreating = (i, after = STUCK_CREATING_MS) => i.status === 'creating' && Date.now() - i.createdAt > after;
const needsLook = (i) => (i.health && i.health !== 'ok') || isSilent(i) || i.status === 'failed' || isStuckCreating(i);
const orgPath = (id) => p`/platform/orgs/${id}`;
const instPath = (id) => p`/platform/instances/${id}`;

const TIER_TONE = { free: 'line', starter: 'line', team: 'blue', business: 'violet' };
const tierPill = (tier) => html`<span class="pill ${TIER_TONE[tier] || 'slate'}">${tier || '—'}</span>`;
const orgStatusPill = (s) => html`<span class="pill ${s === 'active' ? 'green' : s === 'deleting' ? 'slate' : 'amber'}">${s ? s[0].toUpperCase() + s.slice(1) : '—'}</span>`;

/** D72, read-only: only the org's tenant admins turn worca's terminal and actions on. */
const remoteText = (ra) => {
  if (!ra) return '—';
  const on = [ra.terminal && 'terminal', ra.actions && 'actions'].filter(Boolean);
  return `${on.length ? `${on.join(' and ')} on` : 'off'}${ra.pending ? ' (not applied yet)' : ''}`;
};
/** D73, read-only: the outbound network policy, as only the org's tenant admins set it. */
const egressText = (p) => (p ? html`${MODE_LABEL[p.mode] || p.mode}${policyDetails(p)}` : '—');
const KIND_LABEL = { create: 'Create', upgrade: 'Upgrade', wake: 'Wake', lift: 'Lift a stop', suspend: 'Sleep', stop: 'Stop', delete: 'Delete', reconfigure: 'Settings', rotate: 'Renew credentials', refresh: 'Update components' };
const PHASE_LABEL = {
  reserving: 'Reserve the address', compute: 'Compute', network: 'Tunnel and DNS', starting: 'Starting Worca', waiting: 'Waiting for a heartbeat',
  ready: 'Ready', preparing: 'Preparing', deploying: 'Deploying', rolling_back: 'Rolling back', stopping: 'Stopping', stopped: 'Stopped',
  suspended: 'Asleep', closing: 'Closing access', cleanup: 'Clean-up', deleted: 'Deleted', applying: 'Applying', restarting: 'Restarting',
  renewing: 'New credentials',
};
const kindLabel = (k) => KIND_LABEL[k] || k || '—';
const phaseLabel = (ph) => PHASE_LABEL[ph] || (ph ? String(ph).replace(/_/g, ' ') : '—');

/** D15 notice on the detail views. */
const privacy = () => html`<div class="banner violet">${icon('lock')}<div class="grow">You see status and counts only. What runs inside an instance stays private, and no platform role can open one.</div></div>`;

/** A mono id with a copy button. */
const copyId = (value) => (value
  ? html`<span class="pc-id"><span class="mono">${value}</span><button class="btn ghost sm pc-copy" type="button" data-copy="${value}" aria-label="Copy ${value}" title="Copy">${icon('copy')}</button></span>`
  : html`<span class="muted">—</span>`);
function bindCopy(root) {
  for (const b of $$('[data-copy]', root)) b.addEventListener('click', (e) => { e.stopPropagation(); copyText(b.dataset.copy); });
}
/** Table rows with data-href navigate on click; the real link inside them serves the keyboard. */
function bindRowLinks(root) {
  for (const tr of $$('tr[data-href]', root)) {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a,button,input,select,label')) return;
      navigate(tr.dataset.href);
    });
  }
}
/** Sets the widths of `[data-w]` bar segments (no inline styles under the CSP). */
function sizeBars(root) {
  for (const el of $$('[data-w]', root)) el.style.width = `${el.dataset.w}%`;
}

const heartbeat = (i) => {
  if (i.status === 'suspended') return html`<span class="muted">asleep</span>`;
  if (!i.lastHeartbeatAt) return html`<span class="${isSilent(i) ? 'pc-warn' : 'muted'}">never</span>`;
  return html`<span class="${isSilent(i) ? 'pc-warn' : 'muted'}" title="${dateTime(i.lastHeartbeatAt)}">${relTime(i.lastHeartbeatAt)}</span>`;
};
const healthText = (i) => (isSilent(i) ? html`<span class="pill amber">Silent</span>`
  : i.health && i.health !== 'ok' ? html`<span class="pill amber">${i.health}</span>`
    : i.health === 'ok' ? html`<span class="pill green">ok</span>` : html`<span class="muted">—</span>`);
const abuseFlag = (i) => html`${i.stoppedForAbuse ? html`<span class="pill red">${icon('stop')}Stopped for abuse</span>` : ''}${sizeFlag(i)}`;
/** D78: a size other than standard, and a size the org's tier no longer allows. */
const SIZE_NAME = { standard: 'Standard', large: 'Large', xl: 'XL' };
/** A size's memory: binary MB (4096 → 4 GB); gbOf is for the provider's decimal reports (4000 MB → 4 GB). */
const sizeGb = (mb) => `${+(mb / 1024).toFixed(1)} GB`;
const sizeFlag = (i) => html`${i.size && i.size !== 'standard' ? html` <span class="pill line" data-size="${i.size}">${SIZE_NAME[i.size] || i.size}</span>` : ''}${i.aboveTier ? html` <span class="pill amber" title="The org's tier no longer includes this size; it keeps it until a tenant admin moves it">above plan</span>` : ''}`;
const versionCell = (i) => html`<span class="mono">${i.version || '—'}</span>${i.availableVersion && i.availableVersion !== i.version ? html`<div class="pc-sub">${i.availableVersion} available</div>` : ''}`;

const head = (title, sub, acts = '') => html`<div class="head"><div><h1>${title}</h1>${sub ? html`<p>${sub}</p>` : ''}</div>${acts ? html`<div class="acts">${acts}</div>` : ''}</div>`;
const crumb = (href, label, current, mono = false) => html`<div class="crumb"><a class="pc-crumb" href="${href}">${label}</a>${icon('chev')}<span class="${mono ? 'mono' : ''}">${current}</span></div>`;

/** Tabs as links in a segmented control (URL state). */
const tabs = (items, active, label) => html`<nav class="seg pc-tabs" aria-label="${label}">${items.map(([key, text, href]) => html`<a href="${href}" class="${key === active ? 'on' : ''}"${key === active ? html` aria-current="page"` : ''}>${text}</a>`)}</nav>`;

// ==== Overview ====================================================================================
async function overview(ctx) {
  const [stats, stuck, failed, list, orgsRes, rel, prov] = await Promise.all([
    api.get('/api/platform/stats'),
    api.get('/api/platform/ops?state=stuck'),
    api.get('/api/platform/ops?state=failed&limit=50'),
    api.get('/api/platform/instances?limit=500'),
    api.get('/api/platform/orgs?limit=500'),
    api.get('/api/platform/releases'),
    api.get('/api/platform/system/providers').catch(() => null),
  ]);
  if (!ctx.alive()) return;
  const th = stats.thresholds || {};
  const silentAfter = th.silentAfterMs || SILENT_MS;
  const stuckAfter = th.stuckCreatingAfterMs || STUCK_CREATING_MS;
  const orgName = new Map(orgsRes.orgs.map((o) => [o.id, o.name]));
  const byId = new Map(list.instances.map((i) => [i.id, i]));
  const who = (instanceId, orgId) => {
    const i = byId.get(instanceId);
    const org = orgName.get(orgId ?? i?.orgId);
    return [org || 'Unnamed org', i?.name || short(instanceId)].join(' · ');
  };

  // What needs someone, oldest problem first within each kind.
  const items = [];
  const stuckIds = new Set();
  for (const o of stuck.ops) {
    stuckIds.add(o.instanceId);
    items.push(html`<a class="row click" href="${instPath(o.instanceId)}"><span class="g amber spin">${icon('loader')}</span><div class="t">
      <b>${kindLabel(o.kind)} stuck at "${phaseLabel(o.phase)}" for ${dur(o.inPhaseMs)}</b>
      <span>${who(o.instanceId, o.orgId)} · ${o.step ? `step ${o.step} · ` : ''}attempt ${o.attempts}</span></div><div class="r">${icon('chev')}</div></a>`);
  }
  const weekAgo = Date.now() - 7 * 86400e3;
  const recentFailed = failed.ops.filter((o) => (o.finishedAt || o.updatedAt) >= weekAgo);
  for (const o of recentFailed.slice(0, 5)) {
    items.push(html`<a class="row click" href="${instPath(o.instanceId)}"><span class="g red">${icon('alert')}</span><div class="t">
      <b>${kindLabel(o.kind)} failed at "${phaseLabel(o.phase)}"</b>
      <span>${who(o.instanceId, o.orgId)} · ${relTime(o.finishedAt || o.updatedAt)}${o.lastError ? ` · ${o.lastError}` : ''}</span></div><div class="r">${icon('chev')}</div></a>`);
  }
  if (recentFailed.length > 5) items.push(html`<a class="row click" href="/platform/ops?state=failed"><span class="g red">${icon('alert')}</span><div class="t"><b>${plural(recentFailed.length - 5, 'more failed operation')}</b><span>This week</span></div><div class="r">${icon('chev')}</div></a>`);
  for (const i of list.instances.filter((x) => isStuckCreating(x, stuckAfter) && !stuckIds.has(x.id))) {
    items.push(html`<a class="row click" href="${instPath(i.id)}"><span class="g violet spin">${icon('loader')}</span><div class="t">
      <b>Creating for ${dur(Date.now() - i.createdAt)}</b><span>${who(i.id)}</span></div><div class="r">${icon('chev')}</div></a>`);
  }
  for (const i of list.instances.filter((x) => isSilent(x, silentAfter)).sort((a, b) => (a.lastHeartbeatAt || 0) - (b.lastHeartbeatAt || 0))) {
    items.push(html`<a class="row click" href="${instPath(i.id)}"><span class="g amber">${icon('activity')}</span><div class="t">
      <b>${i.lastHeartbeatAt ? `No heartbeat for ${dur(Date.now() - i.lastHeartbeatAt)}` : 'No heartbeat yet'}</b><span>${who(i.id)} · status still running</span></div><div class="r">${icon('chev')}</div></a>`);
  }
  for (const i of list.instances.filter((x) => x.status === 'running' && x.health === 'degraded' && !isSilent(x, silentAfter))) {
    items.push(html`<a class="row click" href="${instPath(i.id)}"><span class="g amber">${icon('alert')}</span><div class="t">
      <b>Reports degraded health</b><span>${who(i.id)}</span></div><div class="r">${icon('chev')}</div></a>`);
  }
  // D78: the compute provider's account limit (Railway: services per workspace, three per
  // instance); ask the provider before it runs out.
  const cap = stats.capacity;
  const provName = stats.computeProvider?.displayName || 'Compute provider';
  if (cap && cap.limit && cap.used >= cap.limit * 0.8) {
    items.push(html`<div class="row" id="pc-capacity-warn"><span class="g amber">${icon('server')}</span><div class="t">
      <b>${provName} capacity: ${cap.used} of ${cap.limit} ${cap.unit} in use</b><span>Ask ${provName} to raise the account's limit before new instances fail to create.</span></div></div>`);
  }
  if (features.accessRequests && stats.accessRequestsPending && hasRole('superadmin')) {
    items.push(html`<a class="row click" href="/platform/access-requests"><span class="g blue">${icon('mail')}</span><div class="t">
      <b>${plural(stats.accessRequestsPending, 'access request')} waiting for a decision</b><span>Access requests</span></div><div class="r">${icon('chev')}</div></a>`);
  }
  if (stats.waitlist && can('waitlist.manage')) {
    items.push(html`<a class="row click" href="/platform/registration"><span class="g blue">${icon('users')}</span><div class="t">
      <b>${plural(stats.waitlist, 'account')} waiting for approval</b><span>Registration</span></div><div class="r">${icon('chev')}</div></a>`);
  }

  const s = stats.instances;
  const total = Object.values(s.byStatus).reduce((a, b) => a + b, 0);
  const statusLine = Object.entries(s.byStatus).sort((a, b) => b[1] - a[1])
    .map(([k, n], idx) => html`${idx ? ' · ' : ''}<b>${n}</b> ${(STATUS[k]?.label || k).toLowerCase()}`);
  const look = s.silent + s.degraded + s.stuckCreating;

  // Version adoption against the latest release.
  const versions = Object.entries(s.byVersion).map(([v, n]) => ({ v, n }));
  if (!versions.some((x) => x.v === rel.latest)) versions.push({ v: rel.latest, n: 0 });
  versions.sort((a, b) => (a.v === rel.latest ? -1 : b.v === rel.latest ? 1 : b.n - a.n));
  const vTotal = versions.reduce((a, x) => a + x.n, 0);
  const tone = (k) => `pc-v${Math.min(k, 3)}`;

  const provOk = prov && prov.compute?.ok && prov.cloudflare?.tunnels?.ok && prov.cloudflare?.dnsRecords?.ok;
  const provPill = !prov ? ''
    : provOk ? html`<span class="pill green"><span class="dot pc-dot-green"></span>Providers up</span>`
      : html`<span class="pill amber">${icon('alert')}A provider is failing</span>`;

  ctx.set(html`<div class="page">
    ${head('Overview', 'The platform right now. What needs someone comes first.', provPill)}
    <div class="grid g4">
      <a class="tile pc-tile" href="/platform/orgs"><div class="k">${icon('building')}Orgs${stats.orgs.createdLast7Days ? html`<span class="delta">+${stats.orgs.createdLast7Days} this week</span>` : ''}</div>
        <div class="v">${stats.orgs.total}</div>
        <div class="s"><b>${stats.users.total}</b> accounts${stats.users.pending ? html` · <b>${stats.users.pending}</b> pending` : ''}${stats.users.disabled ? html` · <b>${stats.users.disabled}</b> disabled` : ''}</div></a>
      <a class="tile pc-tile" href="/platform/instances"><div class="k">${icon('server')}Instances</div><div class="v">${total}</div>
        <div class="s">${total ? statusLine : 'None yet'}</div>
        ${stats.capacity ? html`<div class="s" id="pc-capacity"><b>${stats.capacity.used}</b> of ${stats.capacity.limit} ${provName} ${stats.capacity.unit}</div>` : ''}</a>
      <a class="tile pc-tile" href="/platform/instances?f=look"><div class="k">${icon('alert')}Need a look</div><div class="v ${look ? 'pc-warn' : ''}">${look}</div>
        <div class="s"><b>${s.silent}</b> silent · <b>${s.degraded}</b> degraded · <b>${s.stuckCreating}</b> stuck</div></a>
      <div class="tile"><div class="k">${icon('ticket')}Waiting to join</div><div class="v">${stats.waitlist}</div>
        <div class="s"><b>${stats.openRegistrationCodes}</b> ${stats.openRegistrationCodes === 1 ? 'code' : 'codes'} open</div></div>
    </div>
    <div class="grid g-main">
      <section class="card" aria-labelledby="pc-look"><div class="card-head"><h2 id="pc-look">Needs a look</h2>${stuck.ops.length || failed.ops.length ? html`<a class="pc-link" href="/platform/ops">Operations</a>` : ''}</div>
        ${items.length ? html`<div class="rows pc-look">${items}</div>`
          : html`<div class="empty pc-calm"><span class="g green lg">${icon('check')}</span><span>Nothing needs a look.</span></div>`}
        <p class="hint pc-note">Silent: running, no heartbeat for ${dur(silentAfter)}. Stuck: creating for over ${dur(stuckAfter)}, or an operation in one phase for 15 min.</p></section>
      <section class="card" aria-labelledby="pc-vers"><div class="card-head"><h2 id="pc-vers">Worca versions</h2><a class="pc-link" href="/platform/releases">Releases</a></div>
        ${vTotal ? html`<div class="bar pc-vbar" role="img" aria-label="Instances by Worca version">${versions.filter((x) => x.n).map((x, k) => html`<i class="${tone(k)}" data-w="${((x.n / vTotal) * 100).toFixed(2)}"></i>`)}</div>` : ''}
        <div class="list">${versions.map((x, k) => html`<div class="row"><span class="dot ${tone(k)}"></span><div class="t"><b class="mono pc-ver">${x.v}${x.v === rel.latest ? html` <span class="pill green pc-latest">latest</span>` : ''}</b></div><div class="r mono">${plural(x.n, 'instance')}</div></div>`)}</div>
        <p class="hint pc-note">Tenants upgrade on their own; nothing is forced.</p></section>
    </div>
  </div>`);
  sizeBars(ctx.el);
}

// ==== Orgs ========================================================================================
async function orgsList(ctx) {
  const { orgs } = await api.get('/api/platform/orgs?limit=500');
  if (!ctx.alive()) return;
  const q0 = ctx.query.get('q') || '';
  ctx.set(html`<div class="page">
    ${head('Orgs', `Every tenant on the platform, newest first. ${plural(orgs.length, 'org')}.`)}
    <div class="pc-search"><label class="pc-sr" for="pc-q">Search orgs</label>
      <span class="pc-search-box">${icon('search')}<input class="inp" id="pc-q" type="search" placeholder="Search by name or id" value="${q0}" autocomplete="off"></span></div>
    <div class="card pc-tablecard"><div class="tablewrap"><table>
      <thead><tr><th>Org</th>${features.tiers ? html`<th>Tier</th>` : ''}<th>Status</th><th class="num">Members</th><th class="num">Instances</th><th>Created</th></tr></thead>
      <tbody id="pc-orgs"></tbody></table></div></div>
  </div>`);
  const body = $('#pc-orgs', ctx.el);
  const draw = (q) => {
    const needle = q.trim().toLowerCase();
    const rows = orgs.filter((o) => !needle || (o.name || '').toLowerCase().includes(needle) || o.id.toLowerCase().includes(needle));
    setHtml(body, rows.length ? rows.map((o) => html`<tr class="click" data-href="${orgPath(o.id)}">
      <td><a class="pc-name" href="${orgPath(o.id)}">${o.name || html`<span class="muted">Name unavailable</span>`}</a><div class="pc-sub mono">${o.id}</div></td>
      ${features.tiers ? html`<td>${tierPill(o.tier)}</td>` : ''}<td>${orgStatusPill(o.status)}</td>
      <td class="num">${o.members}</td><td class="num">${o.instances}</td>
      <td class="muted pc-nowrap" title="${dateTime(o.createdAt)}">${dateShort(o.createdAt)}</td></tr>`)
      : html`<tr><td colspan="${features.tiers ? 6 : 5}" class="empty">${orgs.length ? 'No org matches.' : 'No orgs yet.'}</td></tr>`);
    bindRowLinks(body);
  };
  draw(q0);
  $('#pc-q', ctx.el).addEventListener('input', (e) => {
    draw(e.target.value);
    history.replaceState(null, '', e.target.value ? `/platform/orgs?q=${encodeURIComponent(e.target.value)}` : '/platform/orgs');
  });
}

function tierSummary(t, sizes = []) {
  const names = (t.sizes || []).map((id) => sizes.find((x) => x.id === id)?.name || SIZE_NAME[id] || id);
  return `${plural(t.instances_per_org, 'instance')} · ${plural(t.members, 'member')} · ${names.join(', ') || 'Standard'}`;
}

async function changeTier(ctx, org, { pick = org.tier, gone = '' } = {}) {
  const { tiers, computeSizes } = await api.get('/api/platform/tiers');
  const m = openModal(html`
    <h2>Tier of ${org.name || short(org.id)}</h2>
    <fieldset class="field pc-fieldset"><legend class="pc-sr">Tier</legend><div class="checks">
      ${tiers.map((t) => html`<label class="check"><input type="radio" name="pc-tier" value="${t.id}" ${t.id === pick ? 'checked' : ''}><span class="t"><b>${t.name} <span class="muted mono">${t.id}</span></b><span>${tierSummary(t, computeSizes)}</span></span></label>`)}
    </div></fieldset>
    <p class="hint">Lowering a tier never stops or resizes running instances; it only blocks new ones over the limit, and instances keep a size the tier no longer includes until a tenant admin moves them. The org's audit log records the change.</p>
    <div class="acts"><button class="btn" data-close>Cancel</button><button class="btn primary" id="pc-tier-go">Save tier</button></div>`);
  const tierGone = 'That tier no longer exists. The list is up to date now; pick another.';
  if (gone) fieldError($$('input[name=pc-tier]', m), tierGone);
  $('#pc-tier-go', m).addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const tier = $('input[name=pc-tier]:checked', m)?.value;
    if (!tier) return;
    if (tier === org.tier) return closeModal();
    try {
      const res = await protectedAction({ title: 'Change tier', typed: false, call: () => api.raw('PUT', p`/api/platform/orgs/${org.id}/tier`, { tier }) });
      if (!res) return;
    } catch (err) {
      // In the dialog (opened again with a fresh list when a passkey step replaced it).
      if (err.code === 'unknown_tier') return void (m.isConnected ? fieldError($$('input[name=pc-tier]', m), tierGone) : changeTier(ctx, org, { pick: tier, gone: tier }));
      throw err;
    }
    if (m.isConnected) closeModal();
    toast(`${org.name || 'The org'} is on ${tiers.find((t) => t.id === tier)?.name || tier}`);
    ctx.refresh();
  }));
}

async function orgDetail(ctx) {
  let org;
  try {
    org = await api.get(p`/api/platform/orgs/${ctx.params.id}`);
  } catch (e) {
    if (e.code !== 'not_found') throw e;
    return ctx.set(html`<div class="page">${crumb('/platform/orgs', 'Orgs', 'Not found')}${head('Org not found', 'No org has this id. It may have been deleted.')}</div>`);
  }
  if (!ctx.alive()) return;
  const name = org.name || 'Name unavailable';
  ctx.set(html`<div class="page">
    <div>${crumb('/platform/orgs', 'Orgs', name)}
      ${head(name, html`<span class="mono pc-idline">${org.id}</span> · since ${dateShort(org.createdAt)}`,
        features.tiers && can('tenants.manage') ? html`<button class="btn" id="pc-tier">${icon('tag')}Change tier</button>` : '')}</div>
    ${privacy()}
    <div class="grid g4">
      ${features.tiers ? html`<div class="mini" id="pc-org-tier"><b>${org.tierName || org.tier}</b><span>tier${org.tierSizes?.length ? ` · ${org.tierSizes.map((x) => SIZE_NAME[x] || x).join(', ')}` : ''}</span></div>` : ''}
      <div class="mini"><b>${org.members}${org.memberLimit ? html`<span class="muted"> / ${org.memberLimit}</span>` : ''}</b><span>${org.members === 1 ? 'member' : 'members'}</span></div>
      <div class="mini" id="pc-org-instances"><b>${org.instances.length}${org.instanceLimit ? html`<span class="muted"> / ${org.instanceLimit}</span>` : ''}</b><span>${org.instances.length === 1 ? 'instance' : 'instances'}</span></div>
      <div class="mini"><b class="pc-status">${org.status}</b><span>status</span></div>
    </div>
    <section class="card" aria-labelledby="pc-rc-h"><div class="card-head"><h2 id="pc-rc-h">Release candidates</h2></div>
      <div class="rows"><div class="row pc-wrap" id="pc-org-rc"><div class="t"><b>${org.releaseCandidates ? html`<span class="pill amber">On</span>` : html`<span class="pill slate">Off</span>`}</b>
        <span>${org.releaseCandidates ? 'Its tenant admins can pin instances to a release candidate by hand. Pinned instances stay on it until an admin picks a release.' : 'Its tenant admins see releases only.'}</span></div>
        ${can('tenants.manage') ? html`<button class="btn sm" id="pc-rc-toggle">${org.releaseCandidates ? 'Turn off' : 'Turn on'}</button>` : ''}</div></div></section>
    <section class="card" aria-labelledby="pc-egress-h"><div class="card-head"><h2 id="pc-egress-h">Outbound network</h2><span class="sub">org default, read-only</span></div>
      <div id="pc-org-egress">${egressText(org.egress)}</div></section>
    <section class="card" aria-labelledby="pc-admins"><div class="card-head"><h2 id="pc-admins">Tenant admins</h2><span class="sub">longest-standing first</span></div>
      ${org.admins.length ? html`<div class="rows">${org.admins.map((a, k) => html`<div class="row"><span class="av">${icon('user')}</span><div class="t"><b class="mono pc-email">${a.email || 'Address unavailable'}</b><span>Admin since ${dateShort(a.since)}${k === 0 ? ' · first admin' : ''}</span></div></div>`)}</div>`
        : html`<div class="empty">No tenant admins.</div>`}</section>
    <section class="card pc-tablecard" aria-labelledby="pc-oinst"><div class="card-head pc-cardhead"><h2 id="pc-oinst">Instances</h2>${org.instances.length ? html`<a class="pc-link" href="/platform/instances?org=${encodeURIComponent(org.id)}">In the instance list</a>` : ''}</div>
      <div class="tablewrap"><table>
        <thead><tr><th><span class="pc-sr">Status</span></th><th>Instance</th><th>Status</th><th>Version</th><th>Health</th><th>Last heartbeat</th><th><span class="pc-sr">Flags</span></th></tr></thead>
        <tbody>${org.instances.length ? org.instances.map((i) => html`<tr class="click" data-href="${instPath(i.id)}">
          <td class="pc-glyph">${glyph(shownStatus(i))}</td>
          <td><a class="pc-name" href="${instPath(i.id)}">${i.name || 'Unnamed'}</a><div class="pc-sub mono">${i.id}</div></td>
          <td>${statusPill(i.status)}</td><td>${versionCell(i)}</td><td>${healthText(i)}</td><td class="pc-nowrap">${heartbeat(i)}</td><td>${abuseFlag(i)}</td></tr>`)
          : html`<tr><td colspan="7" class="empty">This org has no instances.</td></tr>`}</tbody></table></div></section>
  </div>`);
  bindRowLinks(ctx.el);
  $('#pc-tier', ctx.el)?.addEventListener('click', (e) => busy(e.currentTarget, () => changeTier(ctx, org)));
  $('#pc-rc-toggle', ctx.el)?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const enabled = !org.releaseCandidates;
    const res = await protectedAction({ title: enabled ? 'Turn on release candidates' : 'Turn off release candidates', typed: false, danger: false,
      call: () => api.raw('PUT', p`/api/platform/orgs/${org.id}/release-candidates`, { enabled }) });
    if (!res) return;
    toast(enabled ? 'Release candidates on' : 'Release candidates off');
    ctx.refresh();
  }));
}

// ==== Instances ===================================================================================
const FILTERS = [
  ['all', 'All'], ['running', 'Running'], ['suspended', 'Asleep'], ['look', 'Need a look'], ['outdated', 'Outdated'], ['stopped', 'Stopped'],
];

async function instancesList(ctx) {
  const f = FILTERS.some(([k]) => k === ctx.query.get('f')) ? ctx.query.get('f') : 'all';
  const orgId = ctx.query.get('org') || '';
  const [list, orgsRes, latest] = await Promise.all([
    api.get(`/api/platform/instances?limit=500${orgId ? `&orgId=${encodeURIComponent(orgId)}` : ''}`),
    api.get('/api/platform/orgs?limit=500'),
    api.get('/api/platform/worca-version'),
  ]);
  if (!ctx.alive()) return;
  const orgName = new Map(orgsRes.orgs.map((o) => [o.id, o.name]));
  const outdated = (i) => !!i.version && i.version !== latest.version;
  const match = (i) => f === 'all' || (f === 'look' ? needsLook(i) : f === 'outdated' ? outdated(i) : i.status === f);
  const rows = list.instances.filter(match);
  const href = (k, o = orgId) => {
    const qs = new URLSearchParams();
    if (k !== 'all') qs.set('f', k);
    if (o) qs.set('org', o);
    const s = qs.toString();
    return `/platform/instances${s ? `?${s}` : ''}`;
  };
  const counts = Object.fromEntries(FILTERS.map(([k]) => [k, list.instances.filter((i) => k === 'all' || (k === 'look' ? needsLook(i) : k === 'outdated' ? outdated(i) : i.status === k)).length]));

  ctx.set(html`<div class="page">
    ${head('Instances', orgId ? `Instances of ${orgName.get(orgId) || 'one org'}.` : `All ${plural(list.instances.length, 'instance')}, newest first. Open one for its operation, providers and gate.`)}
    <div class="pc-filters">
      ${tabs(FILTERS.map(([k, l]) => [k, html`${l}${counts[k] ? html` <span class="pc-n">${counts[k]}</span>` : ''}`, href(k)]), f, 'Filter by status')}
      <div class="pc-orgsel"><label class="pc-sr" for="pc-org">Org</label>
        <select class="inp" id="pc-org"><option value="">All orgs</option>${orgsRes.orgs.map((o) => html`<option value="${o.id}" ${o.id === orgId ? 'selected' : ''}>${o.name || o.id}</option>`)}</select></div>
    </div>
    ${f === 'outdated' ? html`<p class="hint pc-tight">Not on the latest version, <span class="mono">${latest.version}</span>.</p>` : f === 'look' ? html`<p class="hint pc-tight">Degraded, silent (no heartbeat for ${dur(SILENT_MS)}), failed, or creating for over ${dur(STUCK_CREATING_MS)}.</p>` : ''}
    <div class="card pc-tablecard"><div class="tablewrap"><table>
      <thead><tr><th><span class="pc-sr">Status</span></th><th>Instance</th><th>Org</th><th>Version</th><th>Health</th><th>Last heartbeat</th><th><span class="pc-sr">Flags</span></th></tr></thead>
      <tbody>${rows.length ? rows.map((i) => html`<tr class="click" data-href="${instPath(i.id)}">
        <td class="pc-glyph">${glyph(shownStatus(i))}</td>
        <td><a class="pc-name" href="${instPath(i.id)}">${i.name || 'Unnamed'}</a><div class="pc-sub mono" title="${i.id}">${short(i.id)}</div></td>
        <td><a class="pc-org" href="${orgPath(i.orgId)}">${orgName.get(i.orgId) || short(i.orgId)}</a></td>
        <td>${versionCell(i)}</td><td>${healthText(i)}</td><td class="pc-nowrap">${heartbeat(i)}</td><td>${abuseFlag(i)}</td></tr>`)
        : html`<tr><td colspan="7" class="empty">${list.instances.length ? 'No instance matches this filter.' : 'No instances yet.'}</td></tr>`}</tbody></table></div></div>
  </div>`);
  bindRowLinks(ctx.el);
  $('#pc-org', ctx.el).addEventListener('change', (e) => navigate(href(f, e.target.value)));
}

const TUNNEL_TONE = { healthy: 'green', degraded: 'amber', down: 'red', inactive: 'slate' };
/** ServiceStatus.state (providers/types.ts): the provider's own status word is shown next to it. */
const DEPLOY_TONE = { running: 'green', starting: 'violet', stopped: 'slate', failed: 'red' };
const STATUS_LINE = {
  running: 'Heartbeats arrive; it serves its org.',
  suspended: 'Asleep. Wakes when someone in the org opens it.',
  creating: 'Being set up.',
  upgrading: 'Moving to a new Worca version.',
  stopped: 'Stopped by the platform. Only staff can lift it; the tenant may delete it.',
  deleting: 'Being removed.',
  failed: 'Setup did not finish.',
};

function opCard(op, inst) {
  if (!op) return html`<section class="card" aria-labelledby="pc-op"><div class="card-head"><h2 id="pc-op">Operation</h2></div><div class="empty">No operation recorded yet.</div></section>`;
  const phases = op.phases && op.phases.length ? [...op.phases] : [op.phase];
  if (!phases.includes(op.phase)) phases.splice(Math.max(phases.length - 1, 0), 0, op.phase); // rolling_back
  const at = phases.indexOf(op.phase);
  const state = (k) => (op.status === 'done' ? 'done' : k < at ? 'done' : k === at ? (op.status === 'failed' ? 'failed' : 'now') : 'wait');
  const statusPillOp = op.status === 'done' ? html`<span class="pill green">Done</span>` : op.status === 'failed' ? html`<span class="pill red">Failed</span>` : op.stuck ? html`<span class="pill amber">Stuck</span>` : html`<span class="pill violet">Running</span>`;
  const canRestart = can('instances.stop') && op.status !== 'done' && op.workflowId && (op.status === 'failed' || op.stuck);
  return html`<section class="card" aria-labelledby="pc-op"><div class="card-head"><h2 id="pc-op">${kindLabel(op.kind)} operation</h2>${statusPillOp}</div>
    <div class="steps">${phases.map((ph, k) => {
      const st = state(k);
      const g = st === 'done' ? html`<span class="g green">${icon('check')}</span>` : st === 'now' ? html`<span class="g ${op.stuck ? 'amber' : 'violet'} spin">${icon('loader')}</span>`
        : st === 'failed' ? html`<span class="g red">${icon('alert')}</span>` : html`<span class="g slate"><span class="dot pc-dot-slate"></span></span>`;
      const sub = st === 'now' || st === 'failed' ? `${op.step ? `step ${op.step} · ` : ''}${op.status === 'running' ? `for ${dur(op.inPhaseMs)}` : `after ${dur(op.inPhaseMs)}`}${op.attempts ? ` · attempt ${op.attempts}` : ''}` : '';
      return html`<div class="step ${st === 'wait' ? 'wait' : ''}">${g}<div class="t"><b>${phaseLabel(ph)}</b>${sub ? html`<span class="mono">${sub}</span>` : ''}</div></div>`;
    })}</div>
    ${op.lastError ? html`<div class="banner amber pc-gap">${icon('alert')}<div class="grow"><b>Last error.</b> <span class="mono pc-err">${op.lastError}</span></div></div>` : ''}
    <dl class="kv pc-gap"><dt>Started</dt><dd title="${dateTime(op.startedAt)}">${relTime(op.startedAt)}</dd>
      ${op.finishedAt ? html`<dt>Finished</dt><dd title="${dateTime(op.finishedAt)}">${relTime(op.finishedAt)}</dd>` : ''}
      ${op.outcome ? html`<dt>Outcome</dt><dd class="mono">${op.outcome}</dd>` : ''}
      <dt>Operation</dt><dd>${copyId(op.opId)}</dd><dt>Workflow</dt><dd>${copyId(op.workflowId)}</dd></dl>
    ${canRestart ? html`<div class="between pc-gap"><span class="hint">Restarting runs the operation again; finished steps are skipped.</span><button class="btn" id="pc-restart" data-op="${op.opId}">${icon('refresh')}Restart operation</button></div>` : ''}
  </section>`;
}

function providersCard(i) {
  const pv = i.providers;
  const prov = i.computeProvider?.displayName || 'Compute';
  const services = pv?.services ? Object.entries(pv.services) : [];
  const errs = pv?.errors ? Object.entries(pv.errors).filter(([, v]) => v) : [];
  const tunnel = pv?.tunnel;
  return html`<section class="card" aria-labelledby="pc-prov"><div class="card-head"><h2 id="pc-prov">Providers</h2>${pv?.checkedAt ? html`<span class="sub" title="${dateTime(pv.checkedAt)}">checked ${relTime(pv.checkedAt)}</span>` : ''}</div>
    ${!pv || !pv.checkedAt ? html`<div class="empty">Not checked yet. The provider poll runs every 5 minutes.</div>` : html`
    <div class="rows">
      <div class="row"><span class="g ${TUNNEL_TONE[tunnel] || 'slate'}">${icon(tunnel === 'healthy' ? 'check' : 'globe')}</span><div class="t"><b>Cloudflare tunnel</b><span class="mono">${tunnel || 'unknown'}${pv.tunnelCheckedAt ? ` · ${relTime(pv.tunnelCheckedAt)}` : ''}</span></div></div>
      ${services.length ? services.map(([name, s]) => {
        // The provider's own word may still say it runs after a stop (Railway's SUCCESS does): `state` doesn't.
        const halted = s?.state === 'stopped' && s?.stopped === true;
        return html`<div class="row"><span class="g ${DEPLOY_TONE[s?.state] || 'slate'}">${icon(s?.state === 'running' ? 'check' : 'server')}</span><div class="t"><b>${prov} · ${name}</b><span class="mono">${s?.status || 'no deployment'}${halted ? ' · stopped' : ''}${s?.statusUpdatedAt ? ` · since ${relTime(s.statusUpdatedAt)}` : ''}</span></div></div>`;
      })
        : html`<div class="row"><span class="g slate">${icon('server')}</span><div class="t"><b>${prov} deployments</b><span>unknown${pv.servicesCheckedAt ? ` · ${relTime(pv.servicesCheckedAt)}` : ''}</span></div></div>`}
    </div>
    ${errs.length ? html`<div class="banner amber pc-gap">${icon('alert')}<div class="grow">${errs.map(([k, v]) => html`<div><b>${k === 'compute' ? prov : k === 'edge' ? 'Cloudflare' : k}:</b> <span class="mono pc-err">${v}</span></div>`)}<div class="muted pc-small">The last known state is shown.</div></div></div>` : ''}
    <p class="hint pc-note">Checked every 5 minutes.</p>`}
  </section>`;
}

function gateRows(g) {
  if (!g) return html`<dt>Gate</dt><dd class="muted">Unavailable</dd>`;
  return html`<dt>Gate status</dt><dd class="mono">${g.status}${g.waking ? ' · waking' : ''}</dd>
    <dt>Gate sessions</dt><dd class="mono">${g.sessions}</dd>
    <dt>Last visit</dt><dd title="${dateTime(g.lastVisit)}">${g.lastVisit ? relTime(g.lastVisit) : 'never'}</dd>
    <dt>Can sleep</dt><dd>${g.suspendable === null || g.suspendable === undefined ? '—' : g.suspendable ? 'Yes' : 'No, work in progress'}</dd>
    <dt>Next scheduled</dt><dd>${g.nextScheduledAt ? dateTime(g.nextScheduledAt * 1000) : '—'}</dd>
    <dt>Next alarm</dt><dd>${g.alarmAt ? dateTime(g.alarmAt) : '—'}</dd>`;
}

const ref = (label, value) => html`<div class="pc-ref"><span class="pc-ref-k">${label}</span>${copyId(value)}</div>`;

function instanceMarkup(i) {
  const st = isSilent(i) ? 'degraded' : shownStatus(i);
  const label = isSilent(i) ? 'Silent' : STATUS[st]?.label || i.status;
  const line = isSilent(i) ? (i.lastHeartbeatAt ? `No heartbeat for ${dur(Date.now() - i.lastHeartbeatAt)}; the status still says running.` : 'No heartbeat yet.')
    : st === 'degraded' ? `Worca reports ${i.health} health${i.healthSince ? ` since ${relTime(i.healthSince)}` : ''}.` : STATUS_LINE[i.status] || '';
  const stopped = i.status === 'stopped';
  const liftRunning = i.op && i.op.kind === 'lift' && i.op.status === 'running';
  const rotating = i.pendingOp === 'rotate' || (i.op && i.op.kind === 'rotate' && i.op.status === 'running');
  const rotate = can('instances.rotate') && ['running', 'suspended', 'stopped'].includes(i.status)
    ? html`<button class="btn" id="pc-rotate" ${rotating || i.pendingOp ? 'disabled' : ''}>${icon('key')}${rotating ? 'Renewing credentials' : 'Renew credentials'}</button>`
    : '';
  const acts = html`${rotate}${can('instances.stop')
    ? (stopped ? html`<button class="btn" id="pc-lift" ${liftRunning ? 'disabled' : ''}>${icon('play')}${liftRunning ? 'Lifting' : 'Lift the stop'}</button>`
      : ['running', 'suspended', 'upgrading'].includes(i.status) ? html`<button class="btn danger" id="pc-stop">${icon('stop')}Stop for abuse</button>` : '')
    : ''}`;
  const pipes = i.pipelines && typeof i.pipelines === 'object' ? Object.entries(i.pipelines) : [];
  const cr = i.computeRef, er = i.edgeRef;
  return html`<div class="page">
    <div>${crumb('/platform/instances', 'Instances', i.name || short(i.id))}
      <div class="head"><div><h1>${i.name || 'Unnamed instance'}</h1>
        <p class="pc-instsub"><a class="pc-org" href="${orgPath(i.orgId)}">${i.orgName || 'Unnamed org'}</a>${copyId(i.id)}</p>
        ${i.url ? html`<p class="pc-insturl"><a class="mono" href="${i.url}" target="_blank" rel="noopener noreferrer">${i.url}</a><button class="btn ghost sm pc-copy" type="button" data-copy="${i.url}" aria-label="Copy the instance address" title="Copy">${icon('copy')}</button></p>` : ''}</div>
        ${acts ? html`<div class="acts">${acts}</div>` : ''}</div></div>
    ${privacy()}
    <div class="split">
      <div class="stack pc-col">
        <section class="card stack" aria-label="Status">
          <div class="pc-state">${glyph(st, true)}<div><b class="pc-state-l">${label}</b><div class="ink2">${line}</div></div></div>
          ${i.stoppedReason ? html`<div class="banner amber">${icon('alert')}<div class="grow"><b>Stop reason.</b> ${i.stoppedReason}<div class="muted pc-small">Sent to the org's admins.</div></div></div>` : ''}
          <div><div class="label">Pipelines</div>
            ${pipes.length ? html`<div class="grid g4">${pipes.map(([k, n]) => html`<div class="mini"><b class="${k === 'failed' && n ? 'pc-bad' : ''}">${n}</b><span>${k}</span></div>`)}</div>`
              : html`<p class="hint pc-tight">No pipeline counts in the last heartbeat.</p>`}</div>
        </section>
        ${opCard(i.op, i)}
        ${providersCard(i)}
      </div>
      <div class="stack pc-col">
        <section class="card" aria-labelledby="pc-det"><div class="card-head"><h2 id="pc-det">Details</h2></div>
          <dl class="kv"><dt>Status</dt><dd>${statusPill(i.status)} ${abuseFlag(i)}</dd>
            <dt>Version</dt><dd>${versionCell(i)}</dd>
            <dt>Automatic updates</dt><dd id="pc-auto-update">${i.autoUpdate === 'minor' ? 'micro and minor' : i.autoUpdate === 'micro' ? 'micro' : 'off'}${i.autoUpdateFailedVersion ? html` <span class="muted">(skips ${i.autoUpdateFailedVersion}: rolled back)</span>` : ''}</dd>
            <dt>Compute size</dt><dd id="pc-size">${i.computeSize ? html`${i.computeSize.name} <span class="muted">· ${i.computeSize.vcpu} vCPU · ${sizeGb(i.computeSize.memoryMb)} · ${plural(i.computeSize.maxParallel, 'agent')} at once</span>${i.computeSize.pending ? html`<div class="muted pc-small">not applied yet</div>` : ''}${i.aboveTier ? html` <span class="pill amber">above plan</span>` : ''}` : '—'}</dd>
            <dt>Remote access</dt><dd id="pc-remote">${remoteText(i.remoteAccess)}</dd>
            <dt>Outbound network</dt><dd id="pc-egress">${i.egress ? html`${egressText(i.egress.effective)}<div class="muted pc-small">${i.egress.inherited ? "The org's policy" : 'Own policy'}${i.egress.pending ? ' · not applied yet' : ''}</div>` : '—'}</dd>
            <dt>Health</dt><dd>${healthText(i)}</dd>
            <dt>Last heartbeat</dt><dd title="${dateTime(i.lastHeartbeatAt)}">${i.lastHeartbeatAt ? relTime(i.lastHeartbeatAt) : 'never'}</dd>
            <dt>Created</dt><dd>${dateTime(i.createdAt)}</dd>
            <dt>Credentials renewed</dt><dd id="pc-rotated" title="${dateTime(i.secretsRotatedAt)}">${i.secretsRotatedAt ? relTime(i.secretsRotatedAt) : 'never'}</dd>
            ${computeRows(i.compute)}
            ${gateRows(i.gate)}</dl></section>
        <section class="card" aria-labelledby="pc-refs"><div class="card-head"><h2 id="pc-refs">Provider references</h2></div>
          <div class="pc-reflist">
            ${ref(`${provOf(i)} project`, cr?.projectId)}
            ${ref(`${provOf(i)} environment`, cr?.environmentId)}
            ${cr && cr.services ? Object.entries(cr.services).map(([name, s]) => html`${ref(`${name} service`, s.serviceId)}${s.deploymentId ? ref(`${name} deployment`, s.deploymentId) : ''}`) : ''}
            ${ref('Cloudflare tunnel', er?.tunnelId)}
            ${(er?.dnsRecordIds || []).map((d, k) => ref(`DNS record ${k + 1}`, d))}
          </div><p class="hint pc-note">Ids only. Tokens and secrets never leave the control plane.</p></section>
      </div>
    </div>
  </div>`;
}

const provOf = (i) => i.computeProvider?.displayName || 'Compute';

/**
 * Region and per-service resources as the compute provider last reported them (compute facts), not
 * the tier's intended size. Instances created before the EU placement fix run in US West.
 */
function computeRows(c) {
  if (!c) return html`<dt>Region</dt><dd class="muted" id="pc-region">Not checked yet</dd><dt>Resources</dt><dd class="muted">Not checked yet</dd>`;
  const region = c.region
    ? html`${c.regionLabel || c.region}${c.regionLabel && c.regionLabel !== c.region ? html` · <span class="mono">${c.region}</span>` : ''}`
    : html`<span class="muted">Unknown</span>`;
  const note = c.eu === false ? html`<div class="fact-warn" id="pc-region-note">Created before EU placement; recreate the instance to move it to the EU</div>` : '';
  const rows = COMPUTE_SERVICES.map(([k, label]) => {
    const s = c.services?.[k];
    const used = s && s.volumeMb && s.volumeUsedMb !== null && s.volumeUsedMb !== undefined ? html` <span class="muted pc-small">(${gbOf(s.volumeUsedMb)} used)</span>` : '';
    return html`<dt>${label}</dt><dd class="pc-svc" data-svc="${k}">${serviceSize(s)}${used}</dd>`;
  });
  return html`<dt>Region</dt><dd id="pc-region">${region}${note}</dd>
    ${rows}
    <dt></dt><dd class="muted pc-small">Limits are ceilings, as the provider reports them. <span title="${dateTime(c.checkedAt)}">Checked ${relTime(c.checkedAt)}.</span></dd>`;
}

async function instanceDetail(ctx) {
  const load = () => api.get(p`/api/platform/instances/${ctx.params.id}`);
  let inst;
  try {
    inst = await load();
  } catch (e) {
    if (e.code !== 'not_found') throw e;
    return ctx.set(html`<div class="page">${crumb('/platform/instances', 'Instances', 'Not found')}${head('Instance not found', 'No instance has this id. It may have been deleted.')}</div>`);
  }
  if (!ctx.alive()) return;
  const busyNow = (i) => ['creating', 'upgrading', 'deleting'].includes(i.status) || (i.op && i.op.status === 'running');
  let timer = null;
  const paint = (i) => {
    inst = i;
    ctx.set(instanceMarkup(i));
    bindCopy(ctx.el);
    $('#pc-stop', ctx.el)?.addEventListener('click', () => stopForAbuse(i, refreshNow));
    $('#pc-lift', ctx.el)?.addEventListener('click', () => liftStop(i, refreshNow));
    $('#pc-rotate', ctx.el)?.addEventListener('click', () => rotateSecrets(i, refreshNow));
    $('#pc-restart', ctx.el)?.addEventListener('click', (e) => restartOp(e.currentTarget.dataset.op, refreshNow));
    schedule();
  };
  const refreshNow = async () => {
    try {
      const i = await load();
      if (ctx.alive()) paint(i);
    } catch { /* keep the last state; the next poll tries again */ }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!ctx.alive()) return;
      if (document.hidden || $('#scrim')) return schedule(); // don't repaint under a dialog
      await refreshNow();
    }, busyNow(inst) ? 5000 : 30000);
  };
  ctx.onLeave(() => clearTimeout(timer));
  paint(inst);
}

function stopForAbuse(i, done) {
  const m = openModal(html`
    <h2 class="danger">Stop ${i.name || 'this instance'} for abuse</h2>
    <p>The instance stops at once and its people see "stopped by the platform". The org's admins get an email with your reason. They can delete it, but only staff can start it again.</p>
    <div class="field"><label for="pc-why">Reason <span class="opt">sent to the org's admins</span></label>
      <textarea class="inp" id="pc-why" rows="3" maxlength="1000" required></textarea>
      <div class="hint">Say what was seen and which rule it breaks.</div></div>
    <div class="acts"><button class="btn" data-close>Cancel</button><button class="btn danger" id="pc-stop-go" disabled>${icon('stop')}Stop instance</button></div>`);
  const why = $('#pc-why', m), go = $('#pc-stop-go', m);
  why.focus();
  why.addEventListener('input', () => { go.disabled = !why.value.trim(); });
  go.addEventListener('click', () => busy(go, async () => {
    const reason = why.value.trim();
    try {
      const res = await protectedAction({ title: 'Stop for abuse', typed: false, call: () => api.raw('POST', p`/api/platform/instances/${i.id}/stop`, { reason }) });
      if (!res) return;
    } catch (e) {
      if (e.code === 'instance_not_stoppable') { closeModal(); toast("It can't be stopped now: it isn't running, asleep or upgrading.", 'error'); return done(); }
      throw e;
    }
    closeModal();
    toast(`${i.name || 'Instance'} stopped; the org's admins were emailed`);
    done();
  }));
}

function liftStop(i, done) {
  const m = openModal(html`
    <h2>Lift the stop?</h2>
    <p>${i.name || 'The instance'} starts again and its people can open it. The org's admins are told.</p>
    <div class="acts"><button class="btn" data-close>Cancel</button><button class="btn primary" id="pc-lift-go">${icon('play')}Lift and start</button></div>`);
  const go = $('#pc-lift-go', m);
  go.addEventListener('click', () => busy(go, async () => {
    try {
      const res = await protectedAction({ title: 'Lift the stop', typed: false, call: () => api.raw('POST', p`/api/platform/instances/${i.id}/lift`) });
      if (!res) return;
    } catch (e) {
      if (e.code === 'instance_not_stopped') { closeModal(); toast("It isn't stopped any more, or a lift is already under way.", 'error'); return done(); }
      throw e;
    }
    closeModal();
    toast('Stop lifted; the instance is starting');
    watchOp({ url: p`/api/platform/instances/${i.id}`, href: p`/platform/instances/${i.id}`, kind: 'lift', ok: `${i.name || 'The instance'} is running again`, fail: `${i.name || 'The instance'} didn't start again` });
    done();
  }));
}

function rotateSecrets(i, done) {
  const running = i.status === 'running';
  const m = openModal(html`
    <h2>Renew the credentials of ${i.name || 'this instance'}?</h2>
    <p>It gets a new tunnel token, broker secret and heartbeat credential; the old ones stop working.
      ${running ? 'It restarts for about a minute; active runs pause and resume. The org\'s admins get an email.' : 'It is not running, so nothing restarts: it starts with the new values next time.'}</p>
    <p class="hint">The keys people stored on its key page stay as they are.</p>
    <div class="acts"><button class="btn" data-close>Cancel</button><button class="btn primary" id="pc-rotate-go">${icon('key')}Renew credentials</button></div>`);
  const go = $('#pc-rotate-go', m);
  go.addEventListener('click', () => busy(go, async () => {
    try {
      const res = await protectedAction({ title: 'Renew credentials', typed: false, danger: false, call: () => api.raw('POST', p`/api/platform/instances/${i.id}/rotate`) });
      if (!res) return;
    } catch (e) {
      if (e.code === 'instance_busy') { closeModal(); toast('Something else is under way on it; try again once it is done.', 'error'); return done(); }
      throw e;
    }
    closeModal();
    toast('Renewing its credentials');
    watchOp({ url: p`/api/platform/instances/${i.id}`, href: p`/platform/instances/${i.id}`, kind: 'rotate', ok: `${i.name || 'The instance'} has new credentials`, fail: `${i.name || 'The instance'}'s credentials couldn't be renewed` });
    done();
  }));
}

/** D74, e.g. after a provider breach: every instance that is free now, spread over up to 10 minutes. */
async function rotateAll(done) {
  const res = await protectedAction({
    title: 'Renew every instance\'s credentials',
    consequence: 'Every running instance restarts for about a minute, spread over up to 10 minutes, and the admins of each org get an email. Sleeping and stopped instances get the new values for their next start. Instances busy with something else are listed so you can renew them later.',
    name: 'all instances',
    actionLabel: 'Renew all',
    call: (typed) => api.raw('POST', '/api/platform/instances/rotate', { confirm: typed }),
  });
  if (!res) return;
  const { started, skipped } = res.body;
  toast(`Renewing ${plural(started.length, 'instance')}${skipped.length ? `; ${plural(skipped.length, 'instance')} skipped` : ''}`);
  if (skipped.length) {
    openModal(html`<h2>Not renewed</h2>
      <p>These were being created, upgraded or deleted, or had something else under way. Renew each from its page once it is free.</p>
      <div class="rows">${skipped.map((s) => html`<div class="row"><div class="t"><a class="mono" href="${instPath(s.id)}">${short(s.id)}</a><span>${s.status}${s.pendingOp ? ` · ${kindLabel(s.pendingOp)}` : ''}</span></div></div>`)}</div>
      <div class="acts"><button class="btn primary" data-close>Done</button></div>`);
  }
  done();
}

const RESTART_ERRORS = {
  op_finished: 'That operation already finished.',
  no_workflow: 'That operation has no Workflow to restart.',
  not_found: 'That operation no longer exists.',
};
function restartOp(opId, done) {
  const m = openModal(html`
    <h2>Restart this operation?</h2>
    <p>It runs again from the top. Steps that finished return their saved results, so only the stuck or failed step and the ones after it run. Both audit logs record the restart.</p>
    <div class="acts"><button class="btn" data-close>Cancel</button><button class="btn primary" id="pc-rs-go">${icon('refresh')}Restart</button></div>`);
  const go = $('#pc-rs-go', m);
  go.addEventListener('click', () => busy(go, async () => {
    try {
      const res = await protectedAction({ title: 'Restart operation', typed: false, call: () => api.raw('POST', p`/api/platform/ops/${opId}/restart`) });
      if (!res) return;
    } catch (e) {
      if (RESTART_ERRORS[e.code]) { closeModal(); toast(RESTART_ERRORS[e.code], 'error'); return done(); }
      throw e;
    }
    closeModal();
    toast('Operation restarted');
    done();
  }));
}

// ==== Provider settings (docs/providers.md "Settings") ===========================================

/**
 * The compute provider's deployment settings, as it declares them. Superadmins save them (staff
 * with platform.view read them); secret fields take a Worker secret's name, never its value.
 */
async function providerSettingsModal() {
  const d = await api.get('/api/platform/provider-settings');
  const mayEdit = can('system.settings') && hasFields(d.fields);
  const name = d.provider?.displayName || 'The compute provider';
  const m = openModal(html`<h2>${name} settings</h2>
    <p>${hasFields(d.fields) ? `What ${name} needs for this deployment. Operations started after saving use the new values.` : `${name} has no settings.`}</p>
    <form class="form" id="pc-pf-form" novalidate>
      ${providerFields(d.fields || [], { values: d.values, secretsSet: d.secretsSet, prefix: 'pc-pf', disabled: !mayEdit })}
      ${alertBox('pc-pf-err')}
      <div class="acts"><button type="button" class="btn" data-close>${mayEdit ? 'Cancel' : 'Close'}</button>
        ${mayEdit ? html`<button type="submit" class="btn primary" id="pc-pf-go">Save</button>` : ''}</div></form>`, { wide: true });
  $('#pc-pf-form', m).addEventListener('submit', (e) => {
    e.preventDefault();
    if (!mayEdit) return;
    clearFieldErrors(m);
    showAlert($('#pc-pf-err', m), '');
    busy($('#pc-pf-go', m), async () => {
      try {
        await api.put('/api/platform/provider-settings', { values: readProviderFields(d.fields, m, 'pc-pf') });
      } catch (x) {
        if (x?.code === 'invalid_provider_settings' && showFieldProblems(x.body?.problems, m, 'pc-pf')) return;
        showAlert($('#pc-pf-err', m), errorText(x));
        return;
      }
      closeModal();
      toast(`${name} settings saved`);
    });
  });
}

// ==== Operations ==================================================================================
const OP_TABS = [['stuck', 'Stuck'], ['failed', 'Failed'], ['running', 'Running']];
const OP_INTRO = {
  stuck: 'Running operations that sat in one phase for 15 minutes or retried a step 3 times.',
  failed: 'Operations that ended in failure, newest first. Kept for 30 days.',
  running: 'Everything in progress right now, oldest first.',
};

async function opsView(ctx) {
  const state = OP_TABS.some(([k]) => k === ctx.query.get('state')) ? ctx.query.get('state') : 'stuck';
  const mayRestart = can('instances.stop');
  const mayRotate = can('instances.rotate');
  const load = () => Promise.all([
    api.get(`/api/platform/ops?state=${state}&limit=200`),
    api.get('/api/platform/instances?limit=500').catch(() => ({ instances: [] })),
  ]);
  const paint = ([{ ops }, list]) => {
    const names = new Map(list.instances.map((i) => [i.id, i.name]));
    const actions = mayRestart && state !== 'running';
    ctx.set(html`<div class="page">
    ${head('Operations', OP_INTRO[state], html`<button class="btn" id="pc-provider-settings">${icon('server')}Provider settings</button>${mayRotate ? html`<button class="btn" id="pc-rotate-all">${icon('key')}Renew all credentials</button>` : ''}`)}
    ${tabs(OP_TABS.map(([k, l]) => [k, l, `/platform/ops${k === 'stuck' ? '' : `?state=${k}`}`]), state, 'Operation state')}
    <div class="card pc-tablecard"><div class="tablewrap"><table class="pc-ops">
      <thead><tr><th>Operation</th><th>Instance</th><th>Phase and step</th><th>${state === 'failed' ? 'Took' : 'In phase for'}</th><th class="num">Attempts</th><th>Last error</th><th>Started</th>${actions ? html`<th><span class="pc-sr">Actions</span></th>` : ''}</tr></thead>
      <tbody>${ops.length ? ops.map((o) => html`<tr>
        <td><b class="pc-kind">${kindLabel(o.kind)}</b>${o.stuck ? html` <span class="pill amber">Stuck</span>` : ''}<div class="pc-sub mono">${short(o.opId)}</div></td>
        <td><a class="pc-name" href="${instPath(o.instanceId)}">${names.get(o.instanceId) || short(o.instanceId)}</a><div class="pc-sub mono">${short(o.instanceId)}</div></td>
        <td>${phaseLabel(o.phase)}${o.step ? html`<div class="pc-sub mono">${o.step}</div>` : ''}</td>
        <td class="mono pc-nowrap">${dur(o.inPhaseMs)}</td>
        <td class="num">${o.attempts}</td>
        <td class="pc-errcell">${o.lastError ? html`<span class="mono pc-err" title="${o.lastError}">${o.lastError}</span>` : html`<span class="muted">—</span>`}</td>
        <td class="muted pc-nowrap" title="${dateTime(o.startedAt)}">${relTime(o.startedAt)}</td>
        ${actions ? html`<td class="pc-act">${o.workflowId && o.status !== 'done' ? html`<button class="btn sm" data-restart="${o.opId}">${icon('refresh')}Restart</button>` : html`<span class="muted pc-small">No Workflow</span>`}</td>` : ''}
      </tr>`) : html`<tr><td colspan="8" class="empty">${state === 'stuck' ? 'Nothing is stuck.' : state === 'failed' ? 'No failed operations in the last 30 days.' : 'Nothing is running.'}</td></tr>`}</tbody></table></div></div>
  </div>`);
    for (const b of $$('[data-restart]', ctx.el)) b.addEventListener('click', () => restartOp(b.dataset.restart, refresh));
    $('#pc-rotate-all', ctx.el)?.addEventListener('click', () => rotateAll(refresh));
    $('#pc-provider-settings', ctx.el)?.addEventListener('click', (e) => busy(e.currentTarget, () => providerSettingsModal()));
  };
  const refresh = async () => {
    try {
      const data = await load();
      if (ctx.alive() && !$('#scrim')) paint(data);
    } catch { /* keep what is shown; the next poll tries again */ }
  };
  const first = await load();
  if (!ctx.alive()) return;
  paint(first);
  ctx.poll(refresh, state === 'failed' ? 60000 : 15000);
}

// ==== Releases ====================================================================================
const HOLD_TEXT = {
  image_missing: () => 'Waiting for its image on GHCR',
  registry_unavailable: () => "GHCR couldn't be asked; trying again",
  label_mismatch: (h) => (h.reports ? html`Its image reports <span class="mono">${h.reports}</span>: an upgrade to it could never finish` : 'Its image has no version label: an upgrade to it could never finish'),
};
const soakText = (h) => (h === 0 ? 'take a release as soon as it is enrolled' : `wait ${plural(h, 'hour')} after a release is enrolled`);

// ==== Tiers (D33, D78) =============================================================================
async function tiersView(ctx) {
  const { tiers, computeSizes, defaultTier, computeProvider } = await api.get('/api/platform/tiers');
  if (!ctx.alive()) return;
  const mayEdit = can('system.settings');
  const sizeName = (id) => computeSizes.find((x) => x.id === id)?.name || id;
  ctx.set(html`<div class="page narrow">
    ${head('Tiers', 'What an org may have: instances, members and the compute sizes its admins pick from. Staff with tenant rights move an org to another tier on its page.',
      mayEdit ? html`<button class="btn primary" id="pc-tier-new">${icon('plus')}New tier</button>` : '')}
    <div class="card pc-tablecard"><div class="tablewrap"><table>
      <thead><tr><th>Tier</th><th class="num">Instances</th><th class="num">Members</th><th>Compute sizes</th><th class="num">Orgs</th>${mayEdit ? html`<th aria-label="Actions"></th>` : ''}</tr></thead>
      <tbody id="pc-tiers">${tiers.map((t) => html`<tr data-tier="${t.id}">
        <td class="pc-nowrap"><b>${t.name}</b> <span class="muted mono">${t.id}</span>${t.id === defaultTier ? html` <span class="pill blue">new orgs</span>` : ''}</td>
        <td class="num">${t.instances_per_org}</td><td class="num">${t.members}</td>
        <td>${t.sizes.map((id) => html`<span class="pill ${id === t.default_size ? 'violet' : 'line'}" title="${id === t.default_size ? 'Default for new instances' : ''}">${sizeName(id)}</span> `)}</td>
        <td class="num">${t.orgs}</td>
        ${mayEdit ? html`<td class="pc-nowrap"><button class="btn ghost sm" data-edit="${t.id}">Edit</button>${t.orgs || t.id === defaultTier ? '' : html`<button class="btn ghost sm" data-delete="${t.id}">Delete</button>`}</td>` : ''}</tr>`)}</tbody></table></div></div>
    <section class="card" aria-labelledby="pc-sizes-h"><div class="card-head"><h2 id="pc-sizes-h">Compute sizes</h2><span class="sub">fixed by ${computeProvider?.displayName || 'the compute provider'}; the Worca service's ceiling</span></div>
      <div class="rows" id="pc-sizes">${computeSizes.map((x) => html`<div class="row pc-wrap"><span class="g slate">${icon('server')}</span><div class="t"><b>${x.name} <span class="muted mono">${x.id}</span></b>
        <span>${x.vcpu} vCPU · ${sizeGb(x.memoryMb)} · ${plural(x.maxParallel, 'agent')} and ${plural(x.maxParallelScripts, 'script')} at once</span></div></div>`)}</div>
      <p class="hint pc-note">The credential broker and the tunnel keep the provider's own ceiling on every size. A tenant admin's change of size restarts Worca.</p></section>
  </div>`);
  $('#pc-tier-new', ctx.el)?.addEventListener('click', () => tierModal(ctx, null, computeSizes));
  for (const b of $$('[data-edit]', ctx.el)) b.addEventListener('click', () => tierModal(ctx, tiers.find((t) => t.id === b.dataset.edit), computeSizes));
  for (const b of $$('[data-delete]', ctx.el)) b.addEventListener('click', () => deleteTier(ctx, tiers.find((t) => t.id === b.dataset.delete)));
}

function tierModal(ctx, t, computeSizes) {
  const isNew = !t;
  const v = t || { name: '', instances_per_org: 1, members: 10, volume_gb: 10, sizes: ['standard'], default_size: 'standard' };
  const m = openModal(html`
    <h2>${isNew ? 'New tier' : `Edit ${t.name}`}</h2>
    <form class="form" id="pc-tier-form" novalidate>
      ${isNew ? html`<div class="field"><label for="pc-t-id">Id</label><input class="inp mono" id="pc-t-id" maxlength="40" autocomplete="off" placeholder="for example agency">
        <span class="hint">Lowercase letters, digits and dashes. Permanent: orgs and registration codes refer to it.</span></div>` : ''}
      <div class="field"><label for="pc-t-name">Name</label><input class="inp" id="pc-t-name" maxlength="60" autocomplete="off" value="${v.name}"></div>
      <div class="grid g3">
        <div class="field"><label for="pc-t-inst">Instances</label><input class="inp" id="pc-t-inst" type="number" min="1" max="100" value="${v.instances_per_org}"></div>
        <div class="field"><label for="pc-t-mem">Members</label><input class="inp" id="pc-t-mem" type="number" min="1" max="1000" value="${v.members}"></div>
        <div class="field"><label for="pc-t-vol">Volume GB</label><input class="inp" id="pc-t-vol" type="number" min="1" max="1000" value="${v.volume_gb}"></div>
      </div>
      <fieldset class="field pc-fieldset"><legend>Compute sizes</legend><div class="checks" id="pc-t-sizes">
        ${computeSizes.map((x) => html`<div class="check pc-sizepick"><input type="checkbox" id="pc-t-s-${x.id}" name="pc-t-size" value="${x.id}" ${v.sizes.includes(x.id) ? 'checked' : ''}>
          <label class="t" for="pc-t-s-${x.id}"><b>${x.name}</b><span>${x.vcpu} vCPU · ${sizeGb(x.memoryMb)} · ${plural(x.maxParallel, 'agent')} at once</span></label>
          <label class="pc-default"><input type="radio" name="pc-t-default" value="${x.id}" ${x.id === v.default_size ? 'checked' : ''}> default</label></div>`)}
      </div><span class="hint">Tenant admins pick from these; new instances get the default.</span></fieldset>
      ${isNew ? '' : html`<p class="hint">Changes apply to every org on it at once. Nothing running is stopped or resized.</p>`}
      ${alertBox('pc-t-err')}
      <div class="acts"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" id="pc-t-go">${isNew ? 'Create tier' : 'Save'}</button></div>
    </form>`);
  const form = $('#pc-tier-form', m);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    showAlert($('#pc-t-err', m), '');
    const sizes = $$('input[name=pc-t-size]:checked', m).map((x) => x.value);
    const defaultSize = $('input[name=pc-t-default]:checked', m)?.value;
    const num = (id) => Number($(id, m).value);
    const body = { name: $('#pc-t-name', m).value.trim(), instancesPerOrg: num('#pc-t-inst'), members: num('#pc-t-mem'), volumeGb: num('#pc-t-vol'), sizes, defaultSize };
    const id = isNew ? $('#pc-t-id', m).value.trim() : t.id;
    if (isNew && !/^[a-z][a-z0-9-]{1,39}$/.test(id)) return void fieldError($('#pc-t-id', m), 'Use 2 to 40 lowercase letters, digits and dashes, starting with a letter.');
    if (!body.name) return void fieldError($('#pc-t-name', m), 'Give it a name.');
    for (const [sel, max] of [['#pc-t-inst', 100], ['#pc-t-mem', 1000], ['#pc-t-vol', 1000]]) {
      const n = num(sel);
      if (!Number.isInteger(n) || n < 1 || n > max) return void fieldError($(sel, m), `A whole number from 1 to ${max}.`);
    }
    if (!sizes.length) return void fieldError($$('input[name=pc-t-size]', m), 'Pick at least one size.');
    if (!sizes.includes(defaultSize)) return void fieldError($$('input[name=pc-t-default]', m), 'The default must be one of the picked sizes.');
    busy($('#pc-t-go', m), async () => {
      try {
        const res = await protectedAction({ title: isNew ? 'Create tier' : 'Change tier', typed: false, danger: false,
          call: () => (isNew ? api.raw('POST', '/api/platform/tiers', { ...body, id }) : api.raw('PUT', p`/api/platform/tiers/${id}`, body)) });
        if (!res) return;
      } catch (err) {
        if (err.code === 'tier_exists' && m.isConnected) return void fieldError($('#pc-t-id', m), 'A tier with this id exists.');
        if (m.isConnected) return void showAlert($('#pc-t-err', m), errorText(err));
        throw err;
      }
      if (m.isConnected) closeModal();
      toast(isNew ? `Tier ${body.name} created` : `Tier ${body.name} saved`);
      ctx.refresh();
    });
  });
}

function deleteTier(ctx, t) {
  const m = openModal(html`<h2 class="danger">Delete tier ${t.name}</h2>
    <p>No org is on it. Registration codes that still offer it must be used up or expired first.</p>
    ${alertBox('pc-td-err')}
    <div class="acts"><button class="btn" data-close>Cancel</button><button class="btn danger" id="pc-td-go">Delete tier</button></div>`);
  $('#pc-td-go', m).addEventListener('click', (e) => busy(e.currentTarget, async () => {
    try {
      if (!(await protectedAction({ title: 'Delete tier', typed: false, call: () => api.raw('DELETE', p`/api/platform/tiers/${t.id}`) }))) return;
    } catch (err) {
      const text = err.code === 'tier_in_use' ? 'It is in use: an org is on it, it is the tier for new orgs, or an open registration code offers it.' : errorText(err);
      if (m.isConnected) return void showAlert($('#pc-td-err', m), text);
      throw err;
    }
    if (m.isConnected) closeModal();
    toast(`Tier ${t.name} deleted`);
    ctx.refresh();
  }));
}

async function releasesView(ctx) {
  const [{ latest, releases, held = [], settings }, stats, news] = await Promise.all([
    api.get('/api/platform/releases'),
    api.get('/api/platform/stats').catch(() => null),
    features.newsletter && can('newsletter.view') ? api.get('/api/platform/newsletter').catch(() => null) : null,
  ]);
  if (!ctx.alive()) return;
  const mayPublish = can('system.settings');
  const me = ctx.me.user.id;
  const total = stats ? Object.values(stats.instances.byStatus).reduce((a, b) => a + b, 0) : null;
  const by = (r) => (r.publishedBy ? (r.publishedBy === me ? 'you' : html`<span class="mono muted">${short(r.publishedBy)}</span>`)
    : r.source === 'npm' ? html`<span class="muted">npm</span>` : html`<span class="muted">—</span>`);
  const recorded = (r) => r.source !== null;
  ctx.set(html`<div class="page narrow">
    ${head('Releases', 'New stable releases of @worca/app are enrolled by themselves once their image is on GHCR. Tenants see "upgrade available" and upgrade when it suits them.',
      mayPublish ? html`<button class="btn primary" id="pc-publish">${icon('plus')}Publish a version</button>` : '')}
    <div class="card"><div class="rows">
      <div class="row pc-wrap" id="pc-rel-settings"><div class="t"><b>Automatic enrollment ${settings?.autoEnroll ? html`<span class="pill green">On</span>` : html`<span class="pill slate">Off</span>`}</b>
        <span>${settings?.autoEnroll ? 'npm releases become deployable, and the latest when newest, within minutes.' : 'New releases are only published by hand.'} Automatic updates ${soakText(settings?.soakHours ?? 0)}.</span></div>
        ${mayPublish ? html`<button class="btn sm" id="pc-rel-edit">Change</button>` : ''}</div>
    </div></div>
    <div class="card pc-tablecard"><div class="tablewrap"><table>
      <thead><tr><th>Version</th><th>Published</th><th>By</th><th class="num">Instances</th>${mayPublish ? html`<th aria-label="Actions"></th>` : ''}</tr></thead>
      <tbody>${releases.length ? releases.map((r) => html`<tr data-version="${r.version}">
        <td class="pc-nowrap"><span class="mono">${r.version}</span>${r.latest ? html` <span class="pill green pc-latest">latest</span>` : ''}${r.rc ? html` <span class="pill amber pc-rc" title="${r.deployable ? 'Orgs with release candidates on can pin instances to it' : 'Its release is out: no longer offered'}">release candidate</span>` : ''}${r.withdrawn ? html` <span class="pill amber">withdrawn</span><div class="pc-sub" title="${dateTime(r.withdrawn.at)}">${r.withdrawn.reason}</div>` : ''}</td>
        <td class="muted pc-nowrap">${r.publishedAt ? html`<span title="${dateTime(r.publishedAt)}">${dateShort(r.publishedAt)}</span>` : 'not recorded'}</td>
        <td class="pc-nowrap">${by(r)}</td>
        <td class="num">${r.instances}</td>
        ${mayPublish ? html`<td class="pc-nowrap">${recorded(r) ? (r.withdrawn ? html`<button class="btn ghost sm" data-restore="${r.version}">Restore</button>` : html`<button class="btn ghost sm" data-withdraw="${r.version}">Withdraw</button>`) : ''}</td>` : ''}</tr>`)
        : html`<tr><td colspan="${mayPublish ? 5 : 4}" class="empty">No releases recorded.</td></tr>`}</tbody></table></div></div>
    <p class="hint pc-tight">The latest is <span class="mono">${latest}</span>. Older releases stay deployable; a withdrawn one can't be deployed again until it is restored. Release candidates (<span class="mono">x.y.z-rc.N</span>) are enrolled too but never become the latest: only orgs with release candidates on can pin an instance to one, until its release is out. Each version deploys the image <span class="mono">ghcr.io/sinishadjukic/worca:</span><i>version</i>.</p>
    ${held.length ? html`<section class="card pc-tablecard" id="pc-held" aria-labelledby="pc-held-h">
      <div class="card-head pc-cardhead"><h2 id="pc-held-h">Not enrolled yet</h2><span class="sub">Versions on npm that automatic enrollment is holding back.</span></div>
      <div class="tablewrap"><table><thead><tr><th>Version</th><th>Why</th><th>Last checked</th></tr></thead>
        <tbody>${held.map((h) => html`<tr data-held="${h.version}"><td class="mono pc-nowrap">${h.version}</td><td>${(HOLD_TEXT[h.reason] || (() => h.reason))(h)}</td>
          <td class="muted pc-nowrap"><span title="${dateTime(h.checkedAt)}">${relTime(h.checkedAt)}</span></td></tr>`)}</tbody></table></div>
    </section>` : ''}
    ${news ? newsletterSection(news) : ''}
  </div>`);
  $('#pc-publish', ctx.el)?.addEventListener('click', () => publish(ctx, latest, total));
  $('#pc-rel-edit', ctx.el)?.addEventListener('click', () => releaseSettingsModal(ctx, settings));
  for (const b of $$('[data-withdraw]', ctx.el)) b.addEventListener('click', () => withdraw(ctx, releases.find((r) => r.version === b.dataset.withdraw)));
  for (const b of $$('[data-restore]', ctx.el)) b.addEventListener('click', () => restore(ctx, releases.find((r) => r.version === b.dataset.restore)));
}

const WITHDRAW_ERRORS = {
  last_release: "It's the only deployable release: publish or restore another first.",
  already_withdrawn: 'It was withdrawn meanwhile.',
  release_not_found: "It isn't a recorded release.",
};
function withdraw(ctx, r) {
  const m = openModal(html`
    <h2 class="danger">Withdraw Worca ${r.version}</h2>
    <p>Nothing can be created, upgraded or moved back to it any more, automatic updates skip it and automatic enrollment never brings it back.${r.latest ? ' The newest release left becomes the latest.' : ''}</p>
    <p>${r.instances ? html`${plural(r.instances, 'instance')} run${r.instances === 1 ? 's' : ''} it and keep${r.instances === 1 ? 's' : ''} running. Their org admins get an email with your reason and see it on the instance page.` : 'No instance runs it.'}</p>
    <div class="field"><label for="pc-wd-why">Reason <span class="opt">shown to the org admins</span></label>
      <textarea class="inp" id="pc-wd-why" rows="3" maxlength="500" required></textarea>
      <div class="hint">E.g. the vulnerability or the bug, and what to do.</div></div>
    ${alertBox('pc-wd-err')}
    <div class="acts"><button class="btn" data-close>Cancel</button><button class="btn danger" id="pc-wd-go" disabled>Withdraw</button></div>`);
  const why = $('#pc-wd-why', m), go = $('#pc-wd-go', m), err = $('#pc-wd-err', m);
  why.focus();
  why.addEventListener('input', () => { go.disabled = !why.value.trim(); showAlert(err, ''); });
  go.addEventListener('click', () => busy(go, async () => {
    let res;
    try {
      res = await protectedAction({ title: 'Withdraw a release', typed: false, call: () => api.raw('POST', p`/api/platform/releases/${r.version}/withdraw`, { reason: why.value.trim() }) });
      if (!res) return;
    } catch (e) {
      if (!WITHDRAW_ERRORS[e.code]) throw e;
      showAlert(err, WITHDRAW_ERRORS[e.code]);
      return;
    }
    closeModal();
    const b = res.body;
    toast(`Worca ${r.version} withdrawn${b.orgsNotified ? `; the admins of ${plural(b.orgsNotified, 'org')} were emailed` : ''}`);
    ctx.refresh();
  }));
}

function restore(ctx, r) {
  const m = openModal(html`
    <h2>Restore Worca ${r.version}?</h2>
    <p>It can be deployed again${r.withdrawn?.reason ? html` (withdrawn because: ${r.withdrawn.reason})` : ''}. When it is the newest release it becomes the latest again and is offered to older instances.</p>
    <div class="acts"><button class="btn" data-close>Cancel</button><button class="btn primary" id="pc-rs-go">Restore</button></div>`);
  const go = $('#pc-rs-go', m);
  go.addEventListener('click', () => busy(go, async () => {
    const res = await protectedAction({ title: 'Restore a release', typed: false, danger: false, call: () => api.raw('POST', p`/api/platform/releases/${r.version}/restore`) });
    if (!res) return;
    closeModal();
    toast(`Worca ${r.version} restored`);
    ctx.refresh();
  }));
}

function releaseSettingsModal(ctx, settings) {
  const m = openModal(html`
    <h2>Release settings</h2>
    <div class="checks"><label class="check"><input type="checkbox" id="pc-rel-auto"${settings?.autoEnroll ? ' checked' : ''}><span class="t"><b>Enroll new stable npm releases automatically</b>
      <span>Once a release's image is on GHCR and reports the same version, it becomes deployable, and the latest when it is the newest. Off: only "Publish a version" adds releases.</span></span></label></div>
    <div class="field"><label for="pc-rel-soak">Automatic updates wait</label>
      <div class="pc-inline"><input class="inp" id="pc-rel-soak" type="number" min="0" max="720" step="1" value="${settings?.soakHours ?? 0}"> hours after a release is enrolled</div>
      <div class="hint">Time to withdraw a bad release before it reaches instances with automatic updates on. Upgrades started by hand aren't held back. 0 takes a release at once.</div></div>
    <div class="acts"><button class="btn" data-close>Cancel</button><button class="btn primary" id="pc-rel-go">Save</button></div>`);
  const soak = $('#pc-rel-soak', m), go = $('#pc-rel-go', m);
  const valid = () => /^\d+$/.test(soak.value) && Number(soak.value) <= 720;
  soak.addEventListener('input', () => { go.disabled = !valid(); });
  go.addEventListener('click', () => busy(go, async () => {
    const body = { autoEnroll: $('#pc-rel-auto', m).checked, soakHours: Number(soak.value) };
    const res = await protectedAction({ title: 'Release settings', typed: false, danger: false, call: () => api.raw('PUT', '/api/platform/release-settings', body) });
    if (!res) return;
    closeModal();
    toast('Release settings saved');
    ctx.refresh();
  }));
}

// ---- newsletter (D70): counts and the latest issues; sending is automatic (the release hook) ----
const NL_LEVEL = { major: 'Major', minor: 'Minor', micro: 'Patch', rc: 'Release candidate' };
const NL_STATUS = { sending: 'blue', sent: 'green', failed: 'red' };
function newsletterSection(n) {
  const s = n.subscribers;
  const r = s.active.releases;
  return html`<section class="card pc-tablecard" id="pc-newsletter" aria-labelledby="pc-nl">
    <div class="card-head pc-cardhead"><h2 id="pc-nl">Newsletter</h2><span class="sub">Release mail goes out by itself when worca-cc publishes a release.</span></div>
    <div class="rows">
      <div class="row"><div class="t"><b>${plural(s.byStatus.active, 'active subscriber')}</b><span>${s.byStatus.unconfirmed} unconfirmed · ${s.byStatus.unsubscribed} unsubscribed · ${s.byStatus.suppressed} suppressed (bounced or reported as spam)</span></div></div>
      <div class="row"><div class="t"><b>Release mail</b><span>major only ${r.major} · major and minor ${r.minor} · every stable ${r.micro} · everything with release candidates ${r.rc} · none ${r.none}</span></div></div>
      <div class="row"><div class="t"><b>Product news</b><span>${plural(s.active.product, 'active subscriber')}</span></div></div>
    </div>
    <div class="tablewrap"><table>
      <thead><tr><th>Issue</th><th>Level</th><th>Status</th><th class="num">Recipients</th><th class="num">Sent</th><th>Started</th></tr></thead>
      <tbody>${n.issues.length ? n.issues.map((i) => html`<tr data-issue="${i.id}">
        <td>${i.url ? html`<a class="pc-link" href="${i.url}" rel="noopener noreferrer" target="_blank">${i.subject}</a>` : i.subject}</td>
        <td class="pc-nowrap">${i.kind === 'release' ? NL_LEVEL[i.level] || i.level || '—' : 'Product news'}</td>
        <td><span class="pill ${NL_STATUS[i.status] || 'slate'}">${i.status}</span></td>
        <td class="num">${i.recipients}</td>
        <td class="num">${i.sent}</td>
        <td class="muted pc-nowrap"><span title="${dateTime(i.createdAt)}">${dateShort(i.createdAt)}</span></td></tr>`)
        : html`<tr><td colspan="6" class="empty">Nothing sent yet.</td></tr>`}</tbody></table></div>
  </section>`;
}

const PUBLISH_ERRORS = {
  image_not_found: (v) => `There's no image ghcr.io/sinishadjukic/worca:${v}. Push it first, then publish.`,
  image_version_mismatch: (v, e) => `The image ghcr.io/sinishadjukic/worca:${v} reports ${e?.body?.reports || 'no version'}: an upgrade to it could never finish. Build the image from the release's own tag.`,
  release_withdrawn: (v) => `${v} was withdrawn. Restore it from the list instead.`,
  registry_unavailable: () => "Couldn't reach GHCR to check the image. Try again in a minute.",
  invalid_body: () => 'Use a version like 1.8.2.',
};
function publish(ctx, latest, total) {
  const m = openModal(html`
    <h2>Publish a Worca version</h2>
    <div class="field"><label for="pc-ver">Version</label>
      <input class="inp mono" id="pc-ver" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="${latest}" pattern="\\d+\\.\\d+\\.\\d+">
      <span class="hint" id="pc-ver-hint">The image ghcr.io/sinishadjukic/worca with this tag must exist. The latest now is ${latest}.</span></div>
    <div class="banner blue">${icon('info')}<div class="grow">${total === null ? 'Every instance on another version' : `Up to ${plural(total, 'instance')}`} will show "upgrade available". Nobody is upgraded automatically: each org's admins upgrade when it suits them.</div></div>
    ${alertBox('pc-ver-err')}
    <div class="acts"><button class="btn" data-close>Cancel</button><button class="btn primary" id="pc-ver-go" disabled>Publish</button></div>`);
  const inp = $('#pc-ver', m), go = $('#pc-ver-go', m), err = $('#pc-ver-err', m);
  const valid = () => /^\d+\.\d+\.\d+$/.test(inp.value.trim());
  inp.addEventListener('input', () => { go.disabled = !valid(); showAlert(err, ''); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && valid()) go.click(); });
  go.addEventListener('click', () => busy(go, async () => {
    const version = inp.value.trim();
    let res;
    try {
      res = await protectedAction({ title: 'Publish a version', typed: false, call: () => api.raw('PUT', '/api/platform/worca-version', { version }) });
      if (!res) return;
    } catch (e) {
      const text = PUBLISH_ERRORS[e.code];
      if (!text) throw e;
      // The version itself is wrong: under the field. GHCR unreachable: the action as a whole.
      if (e.code === 'registry_unavailable') showAlert(err, text(version, e));
      else fieldError(inp, text(version, e));
      return;
    }
    closeModal();
    toast(`Worca ${version} published; ${plural(res.body.instancesNotified ?? 0, 'instance')} offered the upgrade`);
    ctx.refresh();
  }));
}

// ==== routes ======================================================================================
export default [
  { path: '/platform', nav: 'p-overview', title: 'Platform overview', render: overview },
  { path: '/platform/orgs', nav: 'p-orgs', title: 'Orgs', render: orgsList },
  { path: '/platform/orgs/:id', nav: 'p-orgs', title: 'Org', render: orgDetail },
  { path: '/platform/instances', nav: 'p-instances', title: 'Instances', render: instancesList },
  { path: '/platform/instances/:id', nav: 'p-instances', title: 'Instance', render: instanceDetail },
  { path: '/platform/ops', nav: 'p-ops', title: 'Operations', render: opsView },
  { path: '/platform/releases', nav: 'p-releases', title: 'Releases', render: releasesView },
  { path: '/platform/tiers', nav: 'p-tiers', title: 'Tiers', guard: () => (features.tiers ? null : '/platform'), render: tiersView },
];
