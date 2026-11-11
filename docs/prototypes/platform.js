// Platform console prototype: worca platform staff (support, admin, superadmin). Example data only.
// D15: the console shows status and counts, never instance contents, and can't open an instance.
const ME = { name: 'Sam R.', email: 'admin@worca.example' };
const RANK = { support: 1, admin: 2, superadmin: 3 };
const S = {
  role: 'superadmin',
  passkey: true,
  mode: 'code',
  orgs: [
    { id: 'org_7f3a9c2e', name: 'Acme Robotics', tier: 'Team', members: 6, created: 'Jul 2', admin: 'maja@acme-robotics.example', status: 'active' },
    { id: 'org_1b8e44d0', name: 'Northwind Labs', tier: 'Starter', members: 3, created: 'Jul 19', admin: 'erik@northwind-labs.example', status: 'active' },
    { id: 'org_c3d01f9a', name: 'Helio Energy', tier: 'Business', members: 21, created: 'Aug 4', admin: 'ops@helio.example', status: 'active' },
    { id: 'org_5e2b7a61', name: 'Kestrel Analytics', tier: 'Team', members: 8, created: 'Aug 22', admin: 'dana@kestrel.example', status: 'active' },
    { id: 'org_90af3c12', name: 'Studio Hale', tier: 'Starter', members: 2, created: 'Sep 9', admin: 'mo@studio-hale.example', status: 'active' },
    { id: 'org_e41c8b7d', name: 'Brightline Health', tier: 'Business', members: 14, created: 'Sep 15', admin: 'it@brightline.example', status: 'active' },
    { id: 'org_2a6f0e93', name: 'Tidewater Logistics', tier: 'Team', members: 5, created: 'Oct 1', admin: 'sam@tidewater.example', status: 'active' },
    { id: 'org_8d7c3b20', name: 'quick-crypto-gains', tier: 'Starter', members: 1, created: 'Oct 5', admin: 'x9@proton.example', status: 'active' },
  ],
  instances: [],
  codes: [
    { code: 'WRC-7F3K-92QD', tier: 'Team', uses: '0 / 1', expires: 'Oct 20', by: 'admin@worca.example', note: 'Tidewater follow-up' },
    { code: 'WRC-K2P8-4XMT', tier: 'Starter', uses: '3 / 10', expires: 'Oct 31', by: 'admin@worca.example', note: 'Meetup Oct 2' },
    { code: 'WRC-QH6V-1ZRA', tier: 'Business', uses: '1 / 1', expires: '—', by: 'admin@worca.example', note: 'Helio pilot' },
  ],
  waitlist: [
    { email: 'lea@fernweh.example', at: 'Oct 5', note: 'Signed in with Google' },
    { email: 'ravi@orbitpay.example', at: 'Oct 4', note: 'Email code' },
    { email: 'jo@hollow-oak.example', at: 'Oct 3', note: 'Email code' },
    { email: 'ops@mintleaf.example', at: 'Sep 29', note: 'Microsoft' },
  ],
  staff: [
    { name: 'Sam R.', email: 'admin@worca.example', role: 'superadmin', since: 'Oct 6', me: true },
    { name: 'Pat M.', email: 'petra@worca.example', role: 'admin', since: 'Oct 6' },
    { name: 'Ira K.', email: 'ivo@worca.example', role: 'support', since: 'Oct 6' },
  ],
  versions: [{ v: '1.8.0', at: 'Oct 1', latest: true }, { v: '1.7.2', at: 'Sep 12' }, { v: '1.7.0', at: 'Aug 20' }],
  audit: [
    ['11:02', 'petra@worca.example', 'admin', 'Created registration code WRC-7F3K-92QD (Team, 1 use)'],
    ['10:40', 'system', '—', 'Workflow create for in_t7ka stuck at "Starting worca" for 12 min'],
    ['09:55', 'admin@worca.example', 'superadmin', 'Stopped in_q8xz (quick-crypto-gains) for abuse: crypto mining'],
    ['Yesterday', 'petra@worca.example', 'admin', 'Approved waitlist account mo@studio-hale.example'],
    ['Oct 4', 'admin@worca.example', 'superadmin', 'Changed tier of Helio Energy: Team → Business'],
    ['Oct 1', 'admin@worca.example', 'superadmin', 'Published worca 1.8.0'],
    ['Oct 1', 'admin@worca.example', 'superadmin', 'Granted support to ivo@worca.example'],
  ],
};
// 19 instances across the orgs
[
  ['in_k7m2', 0, 'running', 'ok', '1.8.0', '40 s ago'], ['in_w9hx', 0, 'running', 'ok', '1.7.2', '1 min ago'], ['in_p4dn', 0, 'suspended', 'ok', '1.8.0', 'asleep 2 h'], ['in_qz2r', 0, 'running', 'degraded', '1.8.0', '2 min ago'],
  ['in_b3vt', 1, 'running', 'ok', '1.8.0', '30 s ago'],
  ['in_h1a4', 2, 'running', 'ok', '1.8.0', '20 s ago'], ['in_h2c9', 2, 'running', 'ok', '1.8.0', '50 s ago'], ['in_h3x0', 2, 'running', 'ok', '1.7.2', '1 min ago'], ['in_h4mm', 2, 'suspended', 'ok', '1.8.0', 'asleep 1 day'], ['in_h5ru', 2, 'running', 'silent', '1.8.0', '14 min ago'],
  ['in_k1e7', 3, 'running', 'ok', '1.7.2', '10 s ago'], ['in_k2p3', 3, 'suspended', 'ok', '1.7.0', 'asleep 5 days'],
  ['in_s8lt', 4, 'suspended', 'ok', '1.8.0', 'asleep 9 h'],
  ['in_b1w2', 5, 'running', 'ok', '1.8.0', '15 s ago'], ['in_b2f8', 5, 'running', 'ok', '1.8.0', '45 s ago'], ['in_b3dd', 5, 'suspended', 'ok', '1.7.2', 'asleep 3 h'],
  ['in_t7ka', 6, 'creating', 'ok', '1.8.0', 'never'],
  ['in_q8xz', 7, 'stopped', 'ok', '1.8.0', 'stopped 09:55'],
].forEach(([id, o, status, health, version, beat]) => S.instances.push({ id, org: S.orgs[o], status, health, version, beat, slug: id.slice(3) + 'x7q2mz'.slice(0, 6), pipes: { running: status === 'running' ? (id.charCodeAt(4) % 3) : 0, waiting: id === 'in_k7m2' ? 1 : 0, done: 3 + (id.charCodeAt(5) % 30), failed: health === 'degraded' ? 1 : 0 }, abuse: status === 'stopped' ? 'Crypto mining: CPU at 100% for 9 h, outbound to pool.minexmr.example' : null }));

const can = (r) => RANK[S.role] >= RANK[r];
const shown = (i) => (i.health === 'degraded' ? 'degraded' : i.health === 'silent' ? 'degraded' : i.status);
const findI = (id) => S.instances.find((i) => i.id === id);
const findO = (id) => S.orgs.find((o) => o.id === id);
const host = (i) => `${i.slug}.worca.run`;
const ROLE_LABEL = { support: 'Support', admin: 'Admin', superadmin: 'Superadmin' };

function navItem(view, ic, label, extra = '', also = []) {
  const on = app.view === view || also.includes(app.view);
  return `<button class="${on ? 'active' : ''}" data-go="${view}">${icon(ic)}<span>${label}</span>${extra}</button>`;
}
function shell(content) {
  const unhealthy = S.instances.filter((i) => i.health !== 'ok' || (i.status === 'creating')).length;
  return `
  <div class="proto"><b>Prototype</b><span class="note">Platform console · example data</span><span class="spacer"></span>
    <span>Role</span><div class="seg" role="group" aria-label="Role">${['support', 'admin', 'superadmin'].map((r) => `<button class="${S.role === r ? 'on' : ''}" data-role="${r}">${ROLE_LABEL[r]}</button>`).join('')}</div>
    <span>Session</span><div class="seg" role="group" aria-label="Session"><button class="${S.passkey ? 'on' : ''}" data-pk="1">Passkey</button><button class="${!S.passkey ? 'on' : ''}" data-pk="0">Email code</button></div></div>
  <div class="app">
    <aside class="sidebar" id="sb">
      <div class="brand"><span class="logo" role="img" aria-label="worca"></span><span class="tag">platform</span>
        <button class="btn ghost sm menu-btn" id="menu" aria-label="Menu">${icon('menu')}</button></div>
      <button class="ctx" id="switch"><span class="av" style="background:var(--violet)">${icon('crown')}</span><span class="t"><b>Platform console</b><span>${ROLE_LABEL[S.role]} · ${esc(ME.email)}</span></span>${icon('chevDown')}</button>
      <nav class="nav">
        <div class="nav-sect">Watch</div>
        ${navItem('overview', 'chart', 'Overview', unhealthy ? `<span class="count amber">${unhealthy}</span>` : '')}
        ${navItem('orgs', 'building', 'Orgs', `<span class="count">${S.orgs.length}</span>`, ['org'])}
        ${navItem('instances', 'server', 'Instances', `<span class="count">${S.instances.length}</span>`, ['instance'])}
        ${can('admin') ? `<div class="nav-sect">Access</div>
          ${navItem('registration', 'ticket', 'Registration', S.waitlist.length ? `<span class="count amber">${S.waitlist.length}</span>` : '')}
          ${navItem('users', 'search', 'Find a user')}
          ${navItem('audit', 'history', 'Audit log')}` : ''}
        ${can('superadmin') ? `<div class="nav-sect">Run the platform</div>
          ${navItem('releases', 'tag', 'Releases')}
          ${navItem('roles', 'shield', 'Staff and roles')}
          ${navItem('system', 'settings', 'System')}` : ''}
      </nav>
      <div class="side-foot"><div class="nav"><button data-toast="Your own account page, shared with the org workspace">${icon('user')}<span>Account</span></button><button data-toast="Signs out">${icon('logout')}<span>Sign out</span></button></div>
        <div class="usage"><div class="r"><span>Mail sent today</span><b>37 / 100</b></div><div class="meter"><i style="width:37%"></i></div></div></div>
    </aside>
    <main class="main">${S.passkey ? content : lockScreen()}</main>
  </div>`;
}
function lockScreen() {
  return `<div class="page narrow" style="padding-top:8vh"><div class="card stack" style="align-items:center;text-align:center;padding:40px 28px">
    <span class="g violet lg">${icon('fingerprint')}</span><h1 style="font-size:24px;margin:0">Sign in with your passkey</h1>
    <p class="ink2" style="max-width:46ch;margin:0">The platform console needs a passkey session. You signed in with an email code, which is enough for your orgs but not for platform work.</p>
    <button class="btn primary" data-pk="1">${icon('fingerprint')}Use passkey</button></div></div>`;
}
const privacy = () => `<div class="banner violet">${icon('lock', 'i')}<div class="grow">You see status and counts only. Instance contents, pipelines' names and tenants' code stay private, and no platform role can open an instance.</div></div>`;

const V = {};
V.overview = () => {
  const by = (s) => S.instances.filter((i) => i.status === s).length;
  const days = ['Sep 23', '24', '25', '26', '27', '28', '29', '30', 'Oct 1', '2', '3', '4', '5', '6'];
  const run = [6, 6, 7, 7, 7, 8, 8, 8, 9, 9, 10, 10, 11, 11], sl = [2, 3, 2, 3, 3, 3, 4, 4, 3, 4, 4, 5, 5, 5], st = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
  const vers = S.versions.map((v) => ({ ...v, n: S.instances.filter((i) => i.version === v.v).length }));
  const total = S.instances.length;
  const vc = ['var(--green)', 'var(--amber)', 'var(--slate)'];
  return `<div class="page">
    <div class="head"><div><h1>Overview</h1><p>The platform right now. What needs someone comes first.</p></div>
      <div class="acts"><span class="pill green"><span class="dot" style="background:var(--green)"></span>All providers up</span></div></div>
    <div class="grid g4">
      <div class="tile"><div class="k">${icon('building')}Orgs<span class="delta">+2 this week</span></div><div class="v">${S.orgs.length}</div><div class="s"><b>${S.orgs.reduce((n, o) => n + o.members, 0)}</b> people</div></div>
      <div class="tile"><div class="k">${icon('server')}Instances</div><div class="v">${total}</div><div class="s"><b>${by('running')}</b> running · <b>${by('suspended')}</b> asleep · <b>${by('stopped')}</b> stopped</div></div>
      <div class="tile"><div class="k">${icon('alert')}Need a look</div><div class="v" style="color:var(--amber-ink)">3</div><div class="s"><b>1</b> silent · <b>1</b> degraded · <b>1</b> stuck</div></div>
      <div class="tile"><div class="k">${icon('ticket')}Waiting to join</div><div class="v">${S.waitlist.length}</div><div class="s">Invite-code mode · <b>4</b> codes open</div></div>
    </div>
    <div class="grid g-main">
      <div class="card"><div class="card-head"><h2>Needs a look</h2><span class="sub">oldest first</span></div>
        <div class="rows">
          <div class="row click" data-go="instance" data-p="${P({ id: 'in_t7ka' })}"><span class="g violet spin">${icon('loader')}</span><div class="t"><b>Creating for 12 min, stuck at "Starting worca"</b><span>Tidewater Logistics · in_t7ka · attempt 3 · usual is 2 min</span></div><div class="r">${icon('chev')}</div></div>
          <div class="row click" data-go="instance" data-p="${P({ id: 'in_h5ru' })}"><span class="g amber">${icon('activity')}</span><div class="t"><b>No heartbeat for 14 min</b><span>Helio Energy · in_h5ru · status still running</span></div><div class="r">${icon('chev')}</div></div>
          <div class="row click" data-go="instance" data-p="${P({ id: 'in_qz2r' })}"><span class="g amber">${icon('alert')}</span><div class="t"><b>Reports degraded health</b><span>Acme Robotics · in_qz2r · since 10:22</span></div><div class="r">${icon('chev')}</div></div>
          ${can('admin') ? `<div class="row click" data-go="registration" data-p="${P({ tab: 'waitlist' })}"><span class="g blue">${icon('users')}</span><div class="t"><b>${S.waitlist.length} accounts waiting for approval</b><span>Oldest since Sep 29</span></div><div class="r">${icon('chev')}</div></div>` : ''}
        </div></div>
      <div class="card"><div class="card-head"><h2>worca versions</h2>${can('superadmin') ? '<button class="linkbtn" data-go="releases">Releases</button>' : ''}</div>
        <div class="bar" style="height:12px;margin-bottom:12px">${vers.map((v, k) => `<i style="width:${(v.n / total) * 100}%;background:${vc[k]}"></i>`).join('')}</div>
        <div class="list">${vers.map((v, k) => `<div class="row"><span class="dot" style="background:${vc[k]}"></span><div class="t"><b class="mono" style="font-weight:500">${v.v}${v.latest ? ' <span class="pill green" style="font-family:var(--sans)">latest</span>' : ''}</b></div><div class="r mono">${v.n} instances</div></div>`).join('')}</div>
        <p class="hint" style="margin:10px 0 0">Tenants upgrade on their own; nothing is forced.</p></div>
    </div>
  </div>`;
};

V.orgs = () => `<div class="page">
  <div class="head"><div><h1>Orgs</h1><p>Every tenant on the platform, newest first.</p></div></div>
  <div class="card" style="padding:8px 14px"><div class="tablewrap"><table>
    <thead><tr><th>Org</th><th>Plan</th><th class="num">People</th><th class="num">Instances</th><th>Health</th><th>Since</th></tr></thead>
    <tbody>${[...S.orgs].reverse().map((o) => { const ins = S.instances.filter((i) => i.org === o); const bad = ins.filter((i) => i.health !== 'ok' || ['stopped', 'creating'].includes(i.status)).length; return `<tr class="click" data-go="org" data-p="${P({ id: o.id })}">
      <td><b style="font-weight:600">${esc(o.name)}</b><div class="mono muted" style="font-size:12px">${o.id}</div></td>
      <td><span class="pill ${o.tier === 'Business' ? 'violet' : o.tier === 'Team' ? 'blue' : 'line'}">${o.tier}</span></td>
      <td class="num">${o.members}</td><td class="num">${ins.length}</td>
      <td>${bad ? `<span class="pill amber">${bad} need a look</span>` : '<span class="pill green">Fine</span>'}</td><td class="muted">${o.created}</td></tr>`; }).join('')}</tbody></table></div></div></div>`;

V.org = () => {
  const o = findO(app.params.id);
  const ins = S.instances.filter((i) => i.org === o);
  return `<div class="page">
    <div><div class="crumb"><button data-go="orgs">Orgs</button>${icon('chev')}<span>${esc(o.name)}</span></div>
    <div class="head"><div><h1>${esc(o.name)}</h1><p class="mono" style="font-size:13px">${o.id} · since ${o.created}</p></div>
    <div class="acts">${can('admin') ? `<button class="btn" id="tier">Change plan</button>` : ''}</div></div></div>
    ${privacy()}
    <div class="grid g4"><div class="mini"><b>${o.tier}</b><span>plan</span></div><div class="mini"><b>${o.members}</b><span>people</span></div><div class="mini"><b>${ins.length}</b><span>instances</span></div><div class="mini"><b style="font-size:14px;overflow-wrap:anywhere">${esc(o.admin)}</b><span>first admin</span></div></div>
    <div class="card" style="padding:8px 14px"><div class="tablewrap"><table><thead><tr><th></th><th>Instance</th><th>Version</th><th>Last heartbeat</th></tr></thead>
    <tbody>${ins.map((i) => `<tr class="click" data-go="instance" data-p="${P({ id: i.id })}"><td style="width:40px">${glyph(shown(i))}</td><td class="mono">${i.id}<div class="muted" style="font-size:12px">${host(i)}</div></td><td class="mono">${i.version}</td><td class="muted">${i.beat}</td></tr>`).join('')}</tbody></table></div></div></div>`;
};

V.instances = () => {
  const f = app.params.f || 'all';
  const rows = S.instances.filter((i) => f === 'all' || (f === 'look' ? i.health !== 'ok' || ['creating', 'stopped'].includes(i.status) : f === 'old' ? i.version !== '1.8.0' : i.status === f));
  return `<div class="page">
    <div class="head"><div><h1>Instances</h1><p>All ${S.instances.length} instances, by status. Click one for its heartbeats and history.</p></div></div>
    <div class="seg">${[['all', 'All'], ['running', 'Running'], ['suspended', 'Asleep'], ['look', 'Need a look'], ['old', 'Not on 1.8.0'], ['stopped', 'Stopped']].map(([k, l]) => `<button class="${f === k ? 'on' : ''}" data-go="instances" data-p="${P({ f: k })}">${l}</button>`).join('')}</div>
    <div class="card" style="padding:8px 14px"><div class="tablewrap"><table>
      <thead><tr><th></th><th>Instance</th><th>Org</th><th>Version</th><th class="num">Running</th><th class="num">Done</th><th>Last heartbeat</th></tr></thead>
      <tbody>${rows.map((i) => `<tr class="click" data-go="instance" data-p="${P({ id: i.id })}"><td style="width:40px">${glyph(shown(i))}</td>
        <td class="mono">${i.id}</td><td>${esc(i.org.name)}</td><td class="mono">${i.version}</td><td class="num">${i.pipes.running}</td><td class="num">${i.pipes.done}</td>
        <td style="${i.health === 'silent' ? 'color:var(--amber-ink);font-weight:600' : ''}" class="${i.health === 'silent' ? '' : 'muted'}">${i.beat}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Nothing matches.</td></tr>'}</tbody></table></div></div></div>`;
};

V.instance = () => {
  const i = findI(app.params.id);
  const st = shown(i);
  const beats = i.status === 'running' ? (i.health === 'silent' ? [60, 60, 60, 60, 59, 60, 60, 61, 60, 60, 58, 60, 60, 60, 60, 60, 60, 60, 60, 60, 47, 0, 0, 0] : [60, 60, 60, 59, 60, 60, 60, 61, 60, 60, 58, 60, 60, 60, 60, 60, 60, 60, 59, 60, 60, 60, 60, 60]) : i.status === 'suspended' ? [60, 60, 60, 60, 58, 60, 60, 60, 60, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const line = { running: i.health === 'silent' ? 'Last heartbeat 14 min ago. The control plane marks it down after 15.' : i.health === 'degraded' ? 'worca reports degraded health; pipelines still run.' : 'Heartbeat every minute, all fine.', suspended: 'Asleep. Wakes when someone in the org opens it.', creating: 'Provisioning has been at "Starting worca" for 12 min. Usual is 2 min.', stopped: 'Stopped for abuse. Only platform admins can lift it; the tenant may delete it.' }[i.status] || '';
  const steps = i.status === 'creating' ? [['Reserve the address', '10:28:02', 'done'], ['Create Railway project', '10:28:09', 'done'], ['Create tunnel and DNS', '10:28:14', 'done'], ['Starting worca', 'since 10:28:31 · attempt 3', 'now'], ['First heartbeat', '', 'wait']] : [['Reserve the address', i.org.created, 'done'], ['Create Railway project', i.org.created, 'done'], ['Create tunnel and DNS', i.org.created, 'done'], ['Starting worca', i.org.created, 'done'], ['First heartbeat', i.org.created, 'done']];
  return `<div class="page">
    <div><div class="crumb"><button data-go="instances">Instances</button>${icon('chev')}<span class="mono">${i.id}</span></div>
    <div class="head"><div><h1 class="mono" style="font-weight:500;letter-spacing:-.02em">${i.id}</h1><p><button class="linkbtn" data-go="org" data-p="${P({ id: i.org.id })}">${esc(i.org.name)}</button> · <span class="mono" style="font-size:13px">${host(i)}</span></p></div>
    <div class="acts">${can('admin') ? (i.status === 'stopped' ? `<button class="btn" id="lift">${icon('play')}Lift the stop</button>` : `<button class="btn danger" id="stop">${icon('stop')}Stop for abuse</button>`) : ''}${i.status === 'creating' && can('admin') ? `<button class="btn" data-toast="Operation restarted; finished steps are skipped">${icon('refresh')}Restart operation</button>` : ''}</div></div></div>
    ${privacy()}
    <div class="split">
      <div class="stack" style="gap:18px">
        <div class="card stack">
          <div class="flex" style="flex-wrap:nowrap">${glyph(st, true)}<div><b style="font-size:17px">${i.health === 'silent' ? 'Silent' : STATUS[st].label}</b><div class="ink2">${line}</div></div></div>
          ${i.abuse ? `<div class="banner amber">${icon('alert', 'i')}<div class="grow"><b>Stop reason.</b> ${esc(i.abuse)}<div class="muted" style="font-size:12px;margin-top:4px">admin@worca.example · Oct 6, 09:55 · org admins were emailed</div></div></div>` : ''}
          <div class="grid g4"><div class="mini"><b>${i.pipes.running}</b><span>running</span></div><div class="mini"><b>${i.pipes.waiting}</b><span>waiting</span></div><div class="mini"><b>${i.pipes.done}</b><span>done</span></div><div class="mini"><b style="${i.pipes.failed ? 'color:var(--red-ink)' : ''}">${i.pipes.failed}</b><span>failed</span></div></div>
          <div><div class="label">Providers</div><div class="rows">
            <div class="row"><span class="g ${i.status === 'creating' ? 'amber' : i.status === 'running' ? 'green' : 'slate'}">${icon(i.status === 'running' ? 'check' : 'server')}</span><div class="t"><b>Railway deployment</b><span class="mono">${i.status === 'creating' ? 'DEPLOYING · healthcheck not passed' : i.status === 'running' ? 'SUCCESS' : 'STOPPED (volume kept)'}</span></div></div>
            <div class="row"><span class="g ${i.status === 'running' ? 'green' : 'slate'}">${icon(i.status === 'running' ? 'check' : 'globe')}</span><div class="t"><b>Cloudflare tunnel</b><span class="mono">${i.status === 'running' ? 'healthy' : 'down (no connections while asleep or stopped)'}</span></div></div>
          </div><p class="hint" style="margin:8px 2px 0">Checked every 5 minutes.</p></div>
        </div>
        <div class="card"><div class="card-head"><h2>Provisioning</h2><span class="sub">Workflow wf_${i.id.slice(3)}_create</span></div>
          <div class="steps">${steps.map(([t, d, s]) => `<div class="step ${s === 'wait' ? 'wait' : ''}">${s === 'done' ? `<span class="g green">${icon('check')}</span>` : s === 'now' ? `<span class="g amber spin">${icon('loader')}</span>` : `<span class="g slate"><span class="dot" style="background:var(--slate)"></span></span>`}<div class="t"><b>${t}</b><span class="mono">${d}</span></div></div>`).join('')}</div></div>
      </div>
      <div class="card"><div class="card-head"><h2>Details</h2></div>
        <dl class="kv"><dt>Status</dt><dd>${statusPill(st)}</dd><dt>Version</dt><dd class="mono">${i.version}</dd><dt>Health</dt><dd>${i.health}</dd><dt>Last heartbeat</dt><dd>${i.beat}</dd><dt>Can sleep</dt><dd>${i.pipes.running ? 'No, pipelines running' : 'Yes'}</dd><dt>Region</dt><dd>EU West (Amsterdam)</dd><dt>Size</dt><dd>2 vCPU · 4 GB · 10 GB</dd></dl>
        <div class="label" style="margin-top:20px">Provider references</div>
        <dl class="kv" style="font-size:12px"><dt>Railway project</dt><dd class="mono">worca-run-${i.id}</dd><dt>Tunnel</dt><dd class="mono">worca-run-${i.id}</dd><dt>Gate object</dt><dd class="mono">eu · ${i.id}</dd></dl></div>
    </div></div>`;
};

V.registration = () => {
  const tab = app.params.tab || 'codes';
  return `<div class="page">
    <div class="head"><div><h1>Registration</h1><p>Who can create an account. Invitations into an existing org don't need any of this.</p></div>
      <div class="acts">${tab === 'codes' ? `<button class="btn primary" id="new-code">${icon('plus')}New code</button>` : ''}</div></div>
    <div class="card"><div class="between"><div><b>Sign-up mode</b><div class="ink2" style="font-size:13px">${{ code: 'Only people with a code can sign up.', waitlist: 'Anyone can sign up and waits for approval; a code skips the wait.', open: 'Anyone with a verified email gets an account.' }[S.mode]}</div></div>
      <div class="seg">${[['code', 'Invite code'], ['waitlist', 'Waitlist'], ['open', 'Open']].map(([k, l]) => `<button class="${S.mode === k ? 'on' : ''}" data-mode="${k}" ${can('superadmin') ? '' : 'disabled title="Superadmins change the mode"'}>${l}</button>`).join('')}</div></div>
      ${can('superadmin') ? '' : '<p class="hint" style="margin:10px 0 0">Only a superadmin can change the mode.</p>'}</div>
    <div class="seg"><button class="${tab === 'codes' ? 'on' : ''}" data-go="registration" data-p="${P({ tab: 'codes' })}">Codes · ${S.codes.length}</button><button class="${tab === 'waitlist' ? 'on' : ''}" data-go="registration" data-p="${P({ tab: 'waitlist' })}">Waiting · ${S.waitlist.length}</button></div>
    <div class="card" style="padding:8px 14px"><div class="tablewrap">${tab === 'codes' ? `<table><thead><tr><th>Code</th><th>Plan</th><th>Used</th><th>Expires</th><th>Note</th><th></th></tr></thead>
      <tbody>${S.codes.map((c, k) => `<tr><td class="mono">${c.code}</td><td>${c.tier}</td><td class="mono">${c.uses}</td><td class="muted">${c.expires}</td><td class="ink2">${esc(c.note)}</td><td style="text-align:right;white-space:nowrap"><button class="btn sm ghost" data-copy="${c.code}">${icon('copy')}Copy</button><button class="btn sm ghost" data-revoke="${k}">Revoke</button></td></tr>`).join('')}</tbody></table>` :
      `<table><thead><tr><th>Email</th><th>Signed up</th><th>How</th><th></th></tr></thead>
      <tbody>${S.waitlist.map((w, k) => `<tr><td class="mono" style="font-size:12.5px">${esc(w.email)}</td><td class="muted">${w.at}</td><td class="ink2">${w.note}</td><td style="text-align:right;white-space:nowrap"><button class="btn sm" data-approve="${k}">${icon('check')}Approve</button><button class="btn sm ghost" data-reject="${k}">Reject</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nobody is waiting.</td></tr>'}</tbody></table>`}</div></div></div>`;
};

V.users = () => {
  const q = app.params.q;
  const hit = q && q.toLowerCase() === 'maja@acme-robotics.example';
  return `<div class="page narrow">
    <div class="head"><div><h1>Find a user</h1><p>Look up one account by its exact email address. Addresses are stored encrypted, so there's no browsing or partial search.</p></div></div>
    <form class="card flex" id="find" style="flex-wrap:nowrap"><input class="inp" id="q" type="email" placeholder="name@company.example" value="${esc(q || 'maja@acme-robotics.example')}" aria-label="Email address"><button class="btn primary">${icon('search')}Find</button></form>
    ${q ? (hit ? `<div class="card stack">
      <div class="flex"><span class="av" style="width:44px;height:44px;font-size:14px">MH</span><div><b style="font-size:17px">Maja Horvat</b><div class="mono muted" style="font-size:12.5px">usr_4e81c0d2 · maja@acme-robotics.example</div></div><span class="pill green" style="margin-left:auto">Active</span></div>
      <dl class="kv"><dt>Orgs</dt><dd>Acme Robotics (admin), Northwind Labs (member)</dd><dt>Signs in with</dt><dd>2 passkeys, Google</dd><dt>Last sign-in</dt><dd>Today 08:41 · passkey</dd><dt>Account since</dt><dd>Jul 2, via code WRC-A1B2-C3D4</dd><dt>Platform roles</dt><dd>None</dd></dl>
      <div class="label">Support actions</div>
      <div class="rows">
        <div class="row">${icon('key')}<div class="t"><b>Reset sign-in after lost passkeys</b><span>Removes all passkeys and sessions; she then signs in with an email code. Needs a second staff member's approval.</span></div><div class="r"><button class="btn sm" id="reset">Start reset</button></div></div>
        <div class="row">${icon('logout')}<div class="t"><b>Sign out everywhere</b><span>Ends every session, including open instance tabs within a minute</span></div><div class="r"><button class="btn sm" data-toast="Signed out of 3 sessions">Sign out</button></div></div>
        <div class="row">${icon('lock')}<div class="t"><b>Disable the account</b><span>Blocks sign-in until enabled again. Her orgs are not touched.</span></div><div class="r"><button class="btn sm danger" data-toast="Account disabled">Disable</button></div></div>
      </div></div>` : `<div class="card empty">No account with that address. Check it for typos; partial matches aren't possible.</div>`) : ''}
  </div>`;
};

V.audit = () => `<div class="page">
  <div class="head"><div><h1>Audit log</h1><p>Every platform action by staff and by the system. Kept for 30 days.</p></div><div class="acts"><button class="btn" data-toast="CSV download starts in the real UI">${icon('download')}Export CSV</button></div></div>
  <div class="card" style="padding:8px 14px"><div class="tablewrap"><table><thead><tr><th>When</th><th>Who</th><th>Role</th><th>What</th></tr></thead>
  <tbody>${S.audit.map((a) => `<tr><td class="muted" style="white-space:nowrap">${a[0]}</td><td class="mono" style="font-size:12.5px;white-space:nowrap">${esc(a[1])}</td><td>${a[2] === '—' ? '<span class="muted">—</span>' : `<span class="pill ${a[2] === 'superadmin' ? 'violet' : 'blue'}">${a[2]}</span>`}</td><td>${esc(a[3])}</td></tr>`).join('')}</tbody></table></div></div></div>`;

V.releases = () => `<div class="page narrow">
  <div class="head"><div><h1>Releases</h1><p>Publishing a version makes it available. Tenants see "upgrade available" and upgrade when it suits them.</p></div>
    <div class="acts"><button class="btn primary" id="publish">${icon('plus')}Publish a version</button></div></div>
  <div class="card" style="padding:8px 14px"><div class="tablewrap"><table><thead><tr><th>Version</th><th>Published</th><th class="num">Instances</th><th>Images</th></tr></thead>
  <tbody>${S.versions.map((v) => `<tr><td class="mono">${v.v} ${v.latest ? '<span class="pill green" style="font-family:var(--sans)">latest</span>' : ''}</td><td class="muted">${v.at}</td><td class="num">${S.instances.filter((i) => i.version === v.v).length}</td><td class="mono muted" style="font-size:12px">ghcr.io/worca-dev/worca:${v.v}</td></tr>`).join('')}</tbody></table></div></div></div>`;

V.roles = () => `<div class="page narrow">
  <div class="head"><div><h1>Staff and roles</h1><p>Platform roles never open a tenant's instance. Every staff account needs a passkey.</p></div>
    <div class="acts"><button class="btn primary" id="grant">${icon('plus')}Add staff</button></div></div>
  <div class="grid g3">${[['support', 'Reads orgs, instances and their status'], ['admin', 'Plus registration, plans, abuse stops, user support'], ['superadmin', 'Plus releases, roles, system settings and keys']].map(([r, d]) => `<div class="tile"><div class="k">${icon(r === 'superadmin' ? 'crown' : r === 'admin' ? 'shield' : 'search')}${ROLE_LABEL[r]}</div><div class="v" style="font-size:22px">${S.staff.filter((s) => s.role === r).length}</div><div class="s">${d}</div></div>`).join('')}</div>
  <div class="card"><div class="list">${S.staff.map((s, k) => {
    const lastSuper = s.role === 'superadmin' && S.staff.filter((x) => x.role === 'superadmin').length === 1;
    return `<div class="row"><span class="av">${initials(s.name)}</span><div class="t"><b>${esc(s.name)}${s.me ? ' <span class="muted" style="font-weight:500">(you)</span>' : ''}</b><span class="mono">${esc(s.email)}</span></div><div class="r"><span class="pill ${s.role === 'superadmin' ? 'violet' : s.role === 'admin' ? 'blue' : 'line'}">${ROLE_LABEL[s.role]}</span><button class="btn sm ghost" data-unstaff="${k}" ${lastSuper ? 'disabled title="There must always be one superadmin"' : ''}>Remove</button></div></div>`;
  }).join('')}</div><p class="hint" style="margin:10px 4px 0">The last superadmin can't be removed.</p></div></div>`;

V.system = () => `<div class="page narrow">
  <div class="head"><div><h1>System</h1><p>Keys, providers and mail. Changes here affect every tenant.</p></div></div>
  <div class="card"><div class="card-head"><h2>Master key</h2><span class="pill green">Healthy</span></div>
    <dl class="kv"><dt>Version</dt><dd class="mono">m1 · v1</dd><dt>Wraps</dt><dd>${S.orgs.length} org keys, 64 user keys</dd><dt>Last rotated</dt><dd>Never (created Oct 6)</dd><dt>Rotation</dt><dd>Set the new key as MASTER_KEY and the old one as MASTER_KEY_PREVIOUS, deploy, then rotate here</dd><dt>Offline copy</dt><dd>Split between two people</dd></dl>
    <div class="between" style="margin-top:16px"><span class="ink2" style="max-width:52ch">Rotation re-wraps every org and user key. Tenant data isn't re-encrypted, so it takes seconds.</span><button class="btn" id="rotate-master">${icon('key')}Rotate master key</button></div></div>
  <div class="card"><div class="card-head"><h2>Providers</h2></div><div class="rows">
    <div class="row"><span class="g green">${icon('check')}</span><div class="t"><b>Railway · compute</b><span>Hobby · 18 of 50 projects · EU West (Amsterdam)</span></div><div class="r mono">p50 4.1 s</div></div>
    <div class="row"><span class="g green">${icon('check')}</span><div class="t"><b>Cloudflare · tunnels and DNS</b><span>worca.run · 18 tunnels · 39 of 200 DNS records (Free plan)</span></div><div class="r mono">p50 0.6 s</div></div>
    <div class="row"><span class="g green">${icon('check')}</span><div class="t"><b>Resend · mail</b><span>worca.dev verified · SPF, DKIM, DMARC pass</span></div><div class="r mono">37 / 100 today</div></div>
    <div class="row"><span class="g amber">${icon('alert')}</span><div class="t"><b>Bot protection on sign-in</b><span>Turnstile is off</span></div><div class="r"><button class="btn sm" data-toast="Needs a Turnstile site key first">Turn on</button></div></div>
  </div></div></div>`;

// ---- events ----------------------------------------------------------------------------------
function bind() {
  document.querySelectorAll('[data-role]').forEach((b) => (b.onclick = () => { S.role = b.dataset.role; app.render(); }));
  document.querySelectorAll('[data-pk]').forEach((b) => (b.onclick = () => { S.passkey = b.dataset.pk === '1'; app.render(); if (S.passkey && b.closest('.main')) toast('Signed in with your passkey'); }));
  document.querySelectorAll('[data-toast]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); toast(b.dataset.toast, 'info'); }));
  document.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copyText(b.dataset.copy)));
  const menu = $('#menu'); if (menu) menu.onclick = () => $('#sb').classList.toggle('open');
  const sw = $('#switch');
  if (sw) sw.onclick = () => openModal(`<h2>Switch</h2><div class="rows"><div class="row"><span class="av" style="border-radius:8px;background:var(--violet);color:#fff">${icon('crown')}</span><div class="t"><b>Platform console</b><span>${ROLE_LABEL[S.role]}</span></div><div class="r"><span class="pill green">Current</span></div></div>
    <div class="row click" data-x><span class="av" style="border-radius:8px">WT</span><div class="t"><b>worca team</b><span>Tenant admin · your own org</span></div><div class="r">${icon('chev')}</div></div></div>
    <p class="hint">Staff reach a tenant's instances only through their own membership in that org.</p>`, { onMount: (m) => (m.querySelector('[data-x]').onclick = () => { closeModal(); toast('Opens the org workspace', 'ext'); }) });

  document.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { if (!can('superadmin')) return; S.mode = b.dataset.mode; app.render(); toast(`Sign-up mode: ${b.textContent}`); }));
  document.querySelectorAll('[data-revoke]').forEach((b) => (b.onclick = () => { const c = S.codes.splice(+b.dataset.revoke, 1)[0]; app.render(); toast(`${c.code} revoked`); }));
  document.querySelectorAll('[data-approve]').forEach((b) => (b.onclick = () => { const w = S.waitlist.splice(+b.dataset.approve, 1)[0]; app.render(); toast(`${w.email} approved and emailed`, 'mail'); }));
  document.querySelectorAll('[data-reject]').forEach((b) => (b.onclick = () => { const w = S.waitlist.splice(+b.dataset.reject, 1)[0]; app.render(); toast(`${w.email} rejected; the account is deleted`); }));
  const nc = $('#new-code');
  if (nc) nc.onclick = () => openModal(`<h2>New registration code</h2><div class="form">
    <div class="grid g2"><div class="field"><label for="nc-t">Plan</label><select class="inp" id="nc-t"><option>Starter</option><option selected>Team</option><option>Business</option></select></div>
    <div class="field"><label for="nc-u">Uses</label><input class="inp mono" id="nc-u" type="number" min="1" value="1"></div></div>
    <div class="field"><label for="nc-e">Expires</label><select class="inp" id="nc-e"><option>In 14 days</option><option>In 30 days</option><option>Never</option></select></div>
    <div class="field"><label for="nc-n">Note <span class="opt">only staff see it</span></label><input class="inp" id="nc-n" value="Mintleaf trial"></div></div>
    <div class="acts"><button class="btn" data-x>Cancel</button><button class="btn primary" id="nc-go">Create code</button></div>`, { onMount: (m) => { m.querySelector('[data-x]').onclick = closeModal; m.querySelector('#nc-go').onclick = () => {
      const code = 'WRC-' + Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
      S.codes.unshift({ code, tier: m.querySelector('#nc-t').value, uses: `0 / ${m.querySelector('#nc-u').value}`, expires: 'Oct 20', by: ME.email, note: m.querySelector('#nc-n').value });
      openModal(`<div class="center"><span class="g green lg">${icon('ticket')}</span><h2>Code created</h2><p>Send it to the person yourself. They enter it when they sign up at app.worca.dev.</p>
        <div class="codeblock" style="font-size:20px;letter-spacing:.06em;user-select:all">${code}</div></div><div class="acts" style="justify-content:center"><button class="btn" id="cp">${icon('copy')}Copy</button><button class="btn primary" data-x>Done</button></div>`, { onMount: (m2) => { m2.querySelector('#cp').onclick = () => copyText(code); m2.querySelector('[data-x]').onclick = () => { closeModal(); app.render(); }; } });
    }; } });

  const stop = $('#stop');
  if (stop) stop.onclick = () => { const i = findI(app.params.id); openModal(`<h2 class="danger">Stop ${i.id} for abuse</h2><p>The instance stops at once and its people are shown "stopped by the platform". The org's admins get an email with your reason. They can delete it, but only staff can start it again.</p>
    <div class="field"><label for="why">Reason <span class="opt">sent to the org's admins</span></label><textarea class="inp" id="why" rows="3">Outbound traffic to a mining pool and CPU at 100% for 9 hours, which our terms forbid.</textarea></div>
    <div class="acts"><button class="btn" data-x>Cancel</button><button class="btn danger" id="go-stop">${icon('stop')}Stop instance</button></div>`, { onMount: (m) => { m.querySelector('[data-x]').onclick = closeModal; m.querySelector('#go-stop').onclick = () => { i.status = 'stopped'; i.health = 'ok'; i.abuse = m.querySelector('#why').value; i.beat = 'stopped just now'; closeModal(); app.render(); toast(`${i.id} stopped; ${i.org.name} admins emailed`, 'stop'); }; } }); };
  const lift = $('#lift');
  if (lift) lift.onclick = () => { const i = findI(app.params.id); openModal(`<h2>Lift the stop?</h2><p>${i.id} starts again and its people can open it. The org's admins are told.</p><div class="acts"><button class="btn" data-x>Cancel</button><button class="btn primary" id="go-lift">Lift and start</button></div>`, { onMount: (m) => { m.querySelector('[data-x]').onclick = closeModal; m.querySelector('#go-lift').onclick = () => { i.status = 'running'; i.abuse = null; i.beat = 'just now'; closeModal(); app.render(); toast(`${i.id} is running again`); }; } }); };
  const tier = $('#tier');
  if (tier) tier.onclick = () => { const o = findO(app.params.id); openModal(`<h2>Plan for ${esc(o.name)}</h2><div class="checks">${[['Starter', '2 instances · 1 vCPU · 2 GB'], ['Team', '5 instances · 2 vCPU · 4 GB'], ['Business', '20 instances · 4 vCPU · 8 GB']].map(([t, d], k) => `<label class="check"><input type="radio" name="tr" id="tr-${k}" value="${t}" ${o.tier === t ? 'checked' : ''}><span class="t"><b>${t}</b><span>${d}</span></span></label>`).join('')}</div><p class="hint">Lowering a plan never stops running instances; it only blocks new ones over the limit.</p><div class="acts"><button class="btn" data-x>Cancel</button><button class="btn primary" id="tr-go">Save plan</button></div>`, { onMount: (m) => { m.querySelector('[data-x]').onclick = closeModal; m.querySelector('#tr-go').onclick = () => { o.tier = m.querySelector('input:checked').value; closeModal(); app.render(); toast(`${o.name} is on ${o.tier}`); }; } }); };
  const find = $('#find');
  if (find) find.onsubmit = (e) => { e.preventDefault(); go('users', { q: $('#q').value.trim() }); };
  const reset = $('#reset');
  if (reset) reset.onclick = () => openModal(`<div class="center"><span class="g amber lg">${icon('users')}</span><h2>Needs a second person</h2><p>Resetting sign-in lets someone take over an account, so a second staff member approves it. Pat M. or another admin approves it under Find a user. The request expires in 24 hours.</p></div><div class="acts"><button class="btn primary" data-x>OK</button></div>`, { onMount: (m) => (m.querySelector('[data-x]').onclick = closeModal) });
  const pub = $('#publish');
  if (pub) pub.onclick = () => openModal(`<h2>Publish a worca version</h2><div class="field"><label for="pv">Version</label><input class="inp mono" id="pv" value="1.8.1"><span class="hint">The images ghcr.io/worca-dev/worca:1.8.1 and worca-broker:1.8.1 must exist.</span></div>
    <div class="banner blue">${icon('info', 'i')}<div class="grow">${S.instances.length} instances will show "upgrade available". None upgrades until its tenant says so.</div></div>
    <div class="acts"><button class="btn" data-x>Cancel</button><button class="btn primary" id="pv-go">Publish</button></div>`, { onMount: (m) => { m.querySelector('[data-x]').onclick = closeModal; m.querySelector('#pv-go').onclick = () => { const v = m.querySelector('#pv').value.trim(); S.versions.forEach((x) => (x.latest = false)); S.versions.unshift({ v, at: 'Today', latest: true }); closeModal(); app.render(); toast(`worca ${v} published`); }; } });
  const grant = $('#grant');
  if (grant) grant.onclick = () => openModal(`<h2>Add staff</h2><div class="field"><label for="g-mail">Their worca account</label><input class="inp" id="g-mail" value="nina@worca.example"><span class="hint">They need an account with a passkey first.</span></div>
    <div class="field"><label>Role</label><div class="checks">${['support', 'admin', 'superadmin'].map((r, k) => `<label class="check"><input type="radio" name="gr" id="gr-${k}" value="${r}" ${r === 'support' ? 'checked' : ''}><span class="t"><b>${ROLE_LABEL[r]}</b></span></label>`).join('')}</div></div>
    <div class="acts"><button class="btn" data-x>Cancel</button><button class="btn primary" id="g-go">Add</button></div>`, { onMount: (m) => { m.querySelector('[data-x]').onclick = closeModal; m.querySelector('#g-go').onclick = () => { const email = m.querySelector('#g-mail').value.trim(); S.staff.push({ name: email.split('@')[0], email, role: m.querySelector('input:checked').value, since: 'Today' }); closeModal(); app.render(); toast(`${email} added`); }; } });
  document.querySelectorAll('[data-unstaff]').forEach((b) => (b.onclick = () => { const s = S.staff[+b.dataset.unstaff]; destructive({ title: 'Remove staff role', what: 'Remove a platform role', name: s.email, actor: ME.email, typed: false, consequence: `<b>${esc(s.email)}</b> loses the ${ROLE_LABEL[s.role]} role. Their own account and org memberships stay.`, onConfirmed: () => { S.staff = S.staff.filter((x) => x !== s); app.render(); toast('Role removed'); } }); }));
  const rm = $('#rotate-master');
  if (rm) rm.onclick = () => destructive({ title: 'Rotate master key', what: 'Rotate the master key', name: 'rotate master key', actor: ME.email, consequence: 'Every org and user key is re-wrapped under a new master key. Update the offline copy afterwards; the old key stops working.', onConfirmed: () => toast('Master key rotated · now m1 · v2', 'key') });
}

app.render = () => {
  if (!app.view) app.view = 'overview';
  const need = { registration: 'admin', users: 'admin', audit: 'admin', releases: 'superadmin', roles: 'superadmin', system: 'superadmin' };
  if (need[app.view] && !can(need[app.view])) app.view = 'overview';
  $('#root').innerHTML = shell(V[app.view]());
  bind();
};
go('overview');
