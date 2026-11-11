// Org workspace prototype: tenant admins and tenant users at app.worca.dev. Example data only.
const ME = { name: 'Maja Horvat', email: 'maja@acme-robotics.example' };
const S = {
  role: 'admin', // 'admin' | 'user'
  org: 'acme',
  orgs: {
    acme: { id: 'org_7f3a9c2e', name: 'Acme Robotics', role: 'admin', tier: 'Team', limit: 5 },
    north: { id: 'org_1b8e44d0', name: 'Northwind Labs', role: 'user', tier: 'Starter', limit: 2 },
  },
  instances: [
    { id: 'in_k7m2', name: 'Platform team', slug: 'k7m2qz9xwp', status: 'running', health: 'ok', version: '1.8.0', avail: null, teams: ['Platform', 'Infra'], beat: '40 s ago', pipes: { running: 2, waiting: 1, done: 14, failed: 0 }, suspendable: false, next: null, policy: 'Org default', created: 'Aug 12', lastVisit: 'just now' },
    { id: 'in_w9hx', name: 'Data pipelines', slug: 'w9hx3mfk7a', status: 'running', health: 'ok', version: '1.7.2', avail: '1.8.0', teams: ['Data'], beat: '1 min ago', pipes: { running: 0, waiting: 0, done: 31, failed: 2 }, suspendable: true, next: 'tonight 02:00', policy: 'Passkey or SSO', created: 'Jul 30', lastVisit: '3 h ago' },
    { id: 'in_p4dn', name: 'Mobile app', slug: 'p4dn8rtv2c', status: 'suspended', health: 'ok', version: '1.8.0', avail: null, teams: ['Mobile'], beat: 'asleep since 09:14', pipes: { running: 0, waiting: 0, done: 9, failed: 0 }, suspendable: true, next: null, policy: 'Org default', created: 'Sep 3', lastVisit: 'yesterday' },
    { id: 'in_qz2r', name: 'Sandbox', slug: 'qz2r8vn4lt', status: 'running', health: 'degraded', version: '1.8.0', avail: null, teams: ['Platform'], beat: '2 min ago', pipes: { running: 1, waiting: 0, done: 3, failed: 1 }, suspendable: false, next: null, policy: 'Org default', created: 'Sep 28', lastVisit: '20 min ago' },
  ],
  members: [
    { name: 'Maja Horvat', email: 'maja@acme-robotics.example', role: 'admin', teams: ['Platform', 'Infra'], joined: 'Jul 2', me: true, method: 'Passkey' },
    { name: 'Luka Petrović', email: 'luka@acme-robotics.example', role: 'admin', teams: ['Infra'], joined: 'Jul 2', method: 'SSO' },
    { name: 'Ana Kovač', email: 'ana@acme-robotics.example', role: 'user', teams: ['Data'], joined: 'Jul 30', method: 'SSO' },
    { name: 'Tomás Rivera', email: 'tomas@acme-robotics.example', role: 'user', teams: ['Mobile', 'Platform'], joined: 'Aug 14', method: 'Google' },
    { name: 'Ines Novak', email: 'ines@acme-robotics.example', role: 'user', teams: ['Mobile'], joined: 'Sep 3', method: 'Email code' },
    { name: 'Jonas Weber', email: 'jonas@acme-robotics.example', role: 'user', teams: ['Data'], joined: 'Sep 19', method: 'SSO' },
  ],
  invites: [
    { email: 'priya@acme-robotics.example', role: 'user', team: 'Platform', by: 'Luka Petrović', expires: 'in 5 days' },
    { email: 'contractor@studio-hale.example', role: 'user', team: 'Mobile', by: 'Maja Horvat', expires: 'in 23 hours' },
  ],
  teams: ['Platform', 'Infra', 'Mobile', 'Data'],
  policy: { methods: { email: true, passkey: true, google: true, microsoft: false, sso: true }, domain: 'acme-robotics.eu' },
  domains: [{ name: 'acme-robotics.eu', state: 'verified', txt: 'worca-verify=3f9c1a7be04d' }],
  sso: { name: 'Acme Entra ID', type: 'OIDC', issuer: 'login.microsoftonline.com/4c1e…/v2.0', state: 'active' },
  audit: [
    ['10:42', 'Luka Petrović', 'Invited priya@acme-robotics.example as tenant user', 'invite'],
    ['09:14', 'System', 'Mobile app fell asleep after a day without visits', 'instance'],
    ['Yesterday', 'Maja Horvat', 'Added Tomás Rivera to Platform', 'team'],
    ['Yesterday', 'Maja Horvat', 'Created instance Sandbox', 'instance'],
    ['Oct 3', 'Luka Petrović', 'Changed the login policy: required domain acme-robotics.eu', 'policy'],
    ['Oct 2', 'System', 'Data pipelines reported version 1.8.0 available', 'instance'],
    ['Sep 30', 'Maja Horvat', 'Rotated the org data key', 'security'],
  ],
};
const org = () => S.orgs[S.org];
const isAdmin = () => S.role === 'admin' && org().role === 'admin';
const host = (i) => `${i.slug}.worca.run`;
const inst = (id) => S.instances.find((i) => i.id === id);
const myTeams = () => (S.role === 'admin' ? S.teams : ['Mobile', 'Data']);
const visible = () => (S.org === 'north' ? NORTH : S.instances.filter((i) => isAdmin() || i.teams.some((t) => myTeams().includes(t))));
const NORTH = [{ id: 'in_n1', name: 'Research', slug: 'b3vt9kq2mz', status: 'running', health: 'ok', version: '1.8.0', teams: ['Research'], beat: '30 s ago', pipes: { running: 1, waiting: 0, done: 6, failed: 0 }, lastVisit: '2 days ago' }];
const shownStatus = (i) => (i.status === 'running' && i.health === 'degraded' ? 'degraded' : i.status);

// ---- shell ---------------------------------------------------------------------------------
function navItem(view, ic, label, extra = '') {
  const on = app.view === view || (view === 'instances' && ['instance', 'create', 'progress'].includes(app.view)) || (view === 'teams' && app.view === 'team');
  return `<button class="${on ? 'active' : ''}" data-go="${view}">${icon(ic)}<span>${label}</span>${extra}</button>`;
}
function shell(content) {
  const o = org();
  const admin = isAdmin();
  const asleep = visible().filter((i) => i.status === 'suspended').length;
  return `
  <div class="proto"><b>Prototype</b><span class="note">Org workspace · example data</span>
    <span class="spacer"></span><span>View as</span>
    <div class="seg" role="group" aria-label="View as">
      <button class="${S.role === 'admin' ? 'on' : ''}" data-role="admin">Tenant admin</button>
      <button class="${S.role === 'user' ? 'on' : ''}" data-role="user">Tenant user</button></div></div>
  <div class="app">
    <aside class="sidebar" id="sb">
      <div class="brand"><span class="logo" role="img" aria-label="worca"></span><span class="tag">cloud</span>
        <button class="btn ghost sm menu-btn" id="menu" aria-label="Menu">${icon('menu')}</button></div>
      <button class="ctx" id="switch"><span class="av">${initials(o.name)}</span><span class="t"><b>${esc(o.name)}</b><span>${admin ? 'Tenant admin' : 'Tenant user'} · ${o.tier}</span></span>${icon('chevDown')}</button>
      <nav class="nav">
        ${admin ? `<button class="cta" data-go="create">${icon('plus')}<span>New instance</span></button>` : ''}
        <div class="nav-sect">Work</div>
        ${navItem('home', 'home', 'Home', asleep ? `<span class="count">${visible().length}</span>` : '')}
        ${admin ? navItem('overview', 'chart', 'Overview', '<span class="count amber">2</span>') : ''}
        ${admin ? `<div class="nav-sect">Manage</div>
          ${navItem('instances', 'server', 'Instances', `<span class="count">${S.instances.length}</span>`)}
          ${navItem('members', 'users', 'Members')}
          ${navItem('teams', 'team', 'Teams')}
          ${navItem('security', 'shield', 'Sign-in and security')}
          ${navItem('audit', 'history', 'Audit log')}
          ${navItem('settings', 'settings', 'Org settings')}` : `<div class="nav-sect">Org</div>${navItem('directory', 'users', 'People')}${navItem('myorg', 'building', 'Your teams')}`}
      </nav>
      <div class="side-foot">
        <div class="nav">${navItem('account', 'user', 'Account')}<button data-signout>${icon('logout')}<span>Sign out</span></button></div>
        ${admin ? `<div class="usage"><div class="r"><span>${o.tier} plan · instances</span><b>${S.instances.length} / ${o.limit}</b></div><div class="meter"><i style="width:${(S.instances.length / o.limit) * 100}%"></i></div></div>` : ''}
      </div>
    </aside>
    <main class="main" id="main">${content}</main>
  </div>`;
}

// ---- views ---------------------------------------------------------------------------------
function instanceCard(i) {
  const st = shownStatus(i);
  const s = STATUS[st];
  return `<div class="card stack" style="gap:14px">
    <div class="flex" style="flex-wrap:nowrap">${glyph(st, true)}<div style="min-width:0"><b style="font-size:16px;font-weight:700;letter-spacing:-.01em">${esc(i.name)}</b><div class="mono muted" style="font-size:12px;overflow:hidden;text-overflow:ellipsis">${host(i)}</div></div></div>
    <div class="ink2" style="font-size:13px">${s.line}${i.status === 'suspended' ? '' : ` · <span class="muted">${i.pipes.running} pipeline${i.pipes.running === 1 ? '' : 's'} running</span>`}</div>
    <div class="between"><span class="muted" style="font-size:12px">${i.teams.map(esc).join(', ')}</span>
      <button class="btn ${i.status === 'running' ? 'primary' : ''} sm" data-open="${i.id}" ${['creating', 'deleting', 'stopped'].includes(i.status) ? 'disabled' : ''}>${icon('ext')}${i.status === 'suspended' ? 'Wake and open' : 'Open'}</button></div>
  </div>`;
}

const V = {};
V.home = () => {
  const list = visible();
  const running = list.reduce((n, i) => n + (i.status === 'running' ? i.pipes?.running || 0 : 0), 0);
  return `<div class="page">
    <div class="head"><div><h1>Good morning, ${esc(ME.name.split(' ')[0])}</h1>
      <p>${list.length} instance${list.length === 1 ? '' : 's'} in ${esc(org().name)}${running ? ` · <b>${running} pipeline${running === 1 ? '' : 's'} running</b>` : ''}</p></div>
      ${isAdmin() ? `<div class="acts"><button class="btn" data-go="create">${icon('plus')}New instance</button></div>` : ''}</div>
    ${S.org === 'acme' && !isAdmin() ? `<div class="banner blue">${icon('info', 'i')}<div class="grow">You see the instances your teams use: <b>Mobile</b> and <b>Data</b>. Ask an admin of ${esc(org().name)} if you need another.</div></div>` : ''}
    <div class="grid g2">${list.map(instanceCard).join('')}</div>
    <div class="label">Your other orgs</div>
    <div class="rows">${Object.entries(S.orgs).filter(([k]) => k !== S.org).map(([k, o]) => `<div class="row click" data-org="${k}"><span class="av" style="border-radius:8px">${initials(o.name)}</span><div class="t"><b>${esc(o.name)}</b><span>${o.role === 'admin' ? 'Tenant admin' : 'Tenant user'} · 1 instance</span></div><div class="r">Switch ${icon('chev')}</div></div>`).join('')}</div>
  </div>`;
};

V.overview = () => {
  const by = (st) => S.instances.filter((i) => i.status === st).length;
  return `<div class="page">
    <div class="head"><div><h1>Overview</h1><p>${esc(org().name)} at a glance. Things that need you come first.</p></div></div>
    <div class="grid g4">
      <div class="tile"><div class="k">${icon('server')}Instances</div><div class="v">${S.instances.length}<span class="muted" style="font-size:16px"> / ${org().limit}</span></div><div class="s"><b>${by('running')}</b> running · <b>${by('suspended')}</b> asleep</div></div>
      <div class="tile"><div class="k">${icon('arrowUp')}Upgrades</div><div class="v">${S.instances.filter((i) => i.avail).length}</div><div class="s">Latest worca is <b>1.8.0</b></div></div>
      <div class="tile"><div class="k">${icon('users')}Members</div><div class="v">${S.members.length}</div><div class="s"><b>${S.invites.length}</b> invitations open</div></div>
      <div class="tile"><div class="k">${icon('shield')}Sign-in</div><div class="v" style="font-size:20px;padding-block:5px">SSO + passkey</div><div class="s">Only <b>@acme-robotics.eu</b></div></div>
    </div>
    <div class="grid g-main">
      <div class="card"><div class="card-head"><h2>Needs you</h2><span class="sub">2 items</span></div>
        <div class="rows">
          <div class="row click" data-go="instance" data-p="${P({ id: 'in_w9hx' })}"><span class="g violet">${icon('arrowUp')}</span><div class="t"><b>Data pipelines can upgrade to 1.8.0</b><span>Upgrades never happen on their own. Pick a quiet moment.</span></div><div class="r">${icon('chev')}</div></div>
          <div class="row click" data-go="instance" data-p="${P({ id: 'in_qz2r' })}"><span class="g amber">${icon('alert')}</span><div class="t"><b>Sandbox reports a problem</b><span>Health degraded since 10:22 · 1 pipeline failed</span></div><div class="r">${icon('chev')}</div></div>
          <div class="row click" data-go="members"><span class="g blue">${icon('mail')}</span><div class="t"><b>Invitation to contractor@studio-hale.example expires in 23 hours</b><span>Resend it or let it lapse</span></div><div class="r">${icon('chev')}</div></div>
        </div></div>
      <div class="card"><div class="card-head"><h2>Recent activity</h2><button class="linkbtn" data-go="audit">Audit log</button></div>
        <div class="list">${S.audit.slice(0, 5).map((a) => `<div class="row"><div class="t"><b style="font-weight:500;white-space:normal">${esc(a[2])}</b><span>${esc(a[1])} · ${esc(a[0])}</span></div></div>`).join('')}</div></div>
    </div>
  </div>`;
};

V.instances = () => {
  const f = app.params.f || 'all';
  const rows = S.instances.filter((i) => f === 'all' || (f === 'attention' ? i.health === 'degraded' || i.avail : i.status === f));
  return `<div class="page">
    <div class="head"><div><h1>Instances</h1><p>Each instance is its own worca at its own address. People reach one when a team it's granted to includes them.</p></div>
      <div class="acts"><button class="btn primary" data-go="create">${icon('plus')}New instance</button></div></div>
    <div class="seg">${[['all', 'All'], ['running', 'Running'], ['suspended', 'Asleep'], ['attention', 'Needs attention']].map(([k, l]) => `<button class="${f === k ? 'on' : ''}" data-go="instances" data-p="${P({ f: k })}">${l}</button>`).join('')}</div>
    <div class="card" style="padding:8px 14px"><div class="tablewrap"><table>
      <thead><tr><th></th><th>Instance</th><th>Teams</th><th>Version</th><th>Pipelines</th><th>Last heartbeat</th></tr></thead>
      <tbody>${rows.map((i) => `<tr class="click" data-go="instance" data-p="${P({ id: i.id })}">
        <td style="width:40px">${glyph(shownStatus(i))}</td>
        <td><b style="font-weight:600">${esc(i.name)}</b><div class="mono muted" style="font-size:12px">${host(i)}</div></td>
        <td class="ink2">${i.teams.map(esc).join(', ')}</td>
        <td><span class="mono">${i.version}</span>${i.avail ? ` <span class="pill violet">${i.avail} available</span>` : ''}</td>
        <td class="mono ink2">${i.pipes.running} run · ${i.pipes.done} done${i.pipes.failed ? ` · <span style="color:var(--red-ink)">${i.pipes.failed} failed</span>` : ''}</td>
        <td class="muted">${esc(i.beat)}</td></tr>`).join('') || `<tr><td colspan="6" class="empty">Nothing here.</td></tr>`}</tbody></table></div></div>
  </div>`;
};

V.instance = () => {
  const i = inst(app.params.id);
  const st = shownStatus(i);
  const s = STATUS[st];
  return `<div class="page narrow">
    <div><div class="crumb"><button data-go="instances">Instances</button>${icon('chev')}<span>${esc(i.name)}</span></div>
    <div class="head"><div><h1>${esc(i.name)}</h1><p class="mono" style="font-size:13px">${host(i)} · created ${i.created}</p></div>
      <div class="acts"><button class="btn primary" data-open="${i.id}" ${['creating', 'deleting'].includes(i.status) ? 'disabled' : ''}>${icon('ext')}${i.status === 'suspended' ? 'Wake and open' : 'Open'}</button></div></div></div>
    <div class="card stack" style="gap:18px">
      <div class="flex" style="flex-wrap:nowrap">${glyph(st, true)}<div><b style="font-size:17px;font-weight:700">${s.label}</b><div class="ink2">${i.health === 'degraded' ? 'worca reports a problem in its last heartbeat. Pipelines keep running.' : s.line}</div></div></div>
      <div class="grid g3">
        <div class="mini"><b>${i.pipes.running}</b><span>pipelines running</span></div>
        <div class="mini"><b>${i.pipes.done}</b><span>pipelines done</span></div>
        <div class="mini"><b>${esc(i.beat)}</b><span>last heartbeat</span></div>
      </div>
      ${i.avail ? `<div class="banner violet">${icon('arrowUp', 'i')}<div class="grow"><b>worca ${i.avail} is available.</b> This instance runs ${i.version}. Upgrading restarts it for about a minute. Running pipelines are interrupted and can be resumed afterwards.</div><button class="btn sm" id="upgrade">Upgrade</button></div>` : ''}
      <div><div class="label">Access</div><div class="rows">
        <div class="row click" id="edit-teams">${icon('team')}<div class="t"><b>Teams</b><span>${i.teams.map(esc).join(', ')} · ${S.members.filter((m) => m.teams.some((t) => i.teams.includes(t))).length} people</span></div><div class="r">Change ${icon('chev')}</div></div>
        <div class="row click" id="edit-policy">${icon('shield')}<div class="t"><b>Sign-in for this instance</b><span>${esc(i.policy)}</span></div><div class="r">Change ${icon('chev')}</div></div>
      </div></div>
      <div><div class="label">How it runs</div><div class="rows">
        <div class="row">${icon('moon')}<div class="t"><b>Sleep when idle</b><span>${i.suspendable ? 'Sleeps after a day without visits; wakes when someone opens it' : 'Stays awake: pipelines are running'}</span></div></div>
        <div class="row">${icon('history')}<div class="t"><b>Next scheduled run</b><span>${i.next ? `${i.next}, woken 10 minutes before` : 'None'}</span></div></div>
        <div class="row">${icon('tag')}<div class="t"><b>Version</b><span class="mono">${i.version}</span></div></div>
      </div></div>
    </div>
    <div class="card danger-zone"><div class="card-head"><h2>Delete this instance</h2></div>
      <div class="between"><span class="ink2" style="max-width:56ch">Deletes its data, its address and its history for good. You'll confirm by typing its name, with your passkey, and through a link we email you.</span>
      <button class="btn danger" id="del">${icon('trash')}Delete instance</button></div></div>
  </div>`;
};

V.create = () => `<div class="page narrow">
  <div><div class="crumb"><button data-go="instances">Instances</button>${icon('chev')}<span>New instance</span></div>
  <div class="head"><div><h1>New instance</h1><p>A worca of its own, at its own address. Ready in about two minutes.</p></div></div></div>
  <div class="card"><form class="form" id="create-form">
    <div class="field"><label for="c-name">Name</label><input class="inp" id="c-name" value="Robotics research" required><span class="hint">Only people in ${esc(org().name)} see it.</span></div>
    <div class="field"><label>Who can use it</label><div class="checks">${S.teams.map((t, k) => `<label class="check"><input type="checkbox" id="ct-${k}" value="${t}" ${t === 'Platform' ? 'checked' : ''}><span class="t"><b>${t}</b><span>${S.members.filter((m) => m.teams.includes(t)).length} people</span></span></label>`).join('')}</div></div>
    <div class="field"><label for="c-pol">Sign-in <span class="opt">optional</span></label><select class="inp" id="c-pol"><option>Org default (email code, passkey, Google, SSO)</option><option>Passkey or SSO only</option><option>SSO only</option></select><span class="hint">An instance can only be stricter than the org.</span></div>
    <div class="banner blue">${icon('info', 'i')}<div class="grow">Your <b>${org().tier}</b> plan includes ${org().limit} instances with 2 vCPU, 4 GB memory and 10 GB storage each. This will be <b>${S.instances.length + 1} of ${org().limit}</b>.</div></div>
    <div class="flex" style="justify-content:flex-end"><button type="button" class="btn" data-go="instances">Cancel</button><button class="btn primary" type="submit">Create instance</button></div>
  </form></div></div>`;

const STEPS = [
  ['Reserving the address', 'b8rk2mq7zt.worca.run'],
  ['Creating its compute', 'EU (Amsterdam), 2 vCPU · 4 GB'],
  ['Connecting it to worca.run', 'Private tunnel, no public ports'],
  ['Starting worca 1.8.0', 'Pulling the image'],
  ['Waiting for worca to report in', 'Its first heartbeat'],
];
V.progress = () => {
  const n = app.params.step || 0;
  const done = n >= STEPS.length;
  return `<div class="page narrow">
    <div class="head"><div><h1>${esc(app.params.name || 'Robotics research')}</h1><p class="mono" style="font-size:13px">b8rk2mq7zt.worca.run</p></div></div>
    <div class="card stack">
      <div class="flex">${glyph(done ? 'running' : 'creating', true)}<div><b style="font-size:17px">${done ? 'Ready' : 'Creating'}</b><div class="ink2">${done ? 'Platform can open it now.' : 'You can leave this page; we email you when it is ready.'}</div></div></div>
      <div class="steps">${STEPS.map(([t, d], k) => `<div class="step ${k > n ? 'wait' : ''}">${k < n ? `<span class="g green">${icon('check')}</span>` : k === n ? `<span class="g violet spin">${icon('loader')}</span>` : `<span class="g slate"><span class="dot" style="background:var(--slate)"></span></span>`}<div class="t"><b>${t}</b><span>${d}</span></div></div>`).join('')}</div>
      ${done ? `<div class="flex" style="justify-content:flex-end"><button class="btn" data-go="instances">Back to instances</button><button class="btn primary" data-toast="Opens b8rk2mq7zt.worca.run in a new tab">${icon('ext')}Open</button></div>` : ''}
    </div></div>`;
};

V.members = () => {
  const f = app.params.f || 'members';
  return `<div class="page">
    <div class="head"><div><h1>Members</h1><p>Everyone in ${esc(org().name)}. Admins manage the org; members use the instances their teams can reach.</p></div>
      <div class="acts"><button class="btn primary" id="invite">${icon('plus')}Invite people</button></div></div>
    <div class="seg"><button class="${f === 'members' ? 'on' : ''}" data-go="members" data-p="${P({ f: 'members' })}">Members · ${S.members.length}</button><button class="${f === 'inv' ? 'on' : ''}" data-go="members" data-p="${P({ f: 'inv' })}">Invitations · ${S.invites.length}</button></div>
    <div class="card" style="padding:8px 14px"><div class="tablewrap">${f === 'members' ? `<table>
      <thead><tr><th>Person</th><th>Role</th><th>Teams</th><th>Signs in with</th><th>Joined</th><th></th></tr></thead>
      <tbody>${S.members.map((m, k) => `<tr><td><div class="who"><span class="av">${initials(m.name)}</span><div class="t"><b style="font-weight:600">${esc(m.name)}${m.me ? ' <span class="muted" style="font-weight:500">(you)</span>' : ''}</b><span>${esc(m.email)}</span></div></div></td>
        <td>${m.role === 'admin' ? '<span class="pill violet">Admin</span>' : '<span class="pill line">Member</span>'}</td>
        <td class="ink2">${m.teams.map(esc).join(', ')}</td><td class="ink2">${m.method}</td><td class="muted">${m.joined}</td>
        <td style="text-align:right">${m.me ? '' : `<button class="btn sm ghost" data-member="${k}">Manage</button>`}</td></tr>`).join('')}</tbody></table>` : `<table>
      <thead><tr><th>Email</th><th>Role</th><th>Team</th><th>Invited by</th><th>Expires</th><th></th></tr></thead>
      <tbody>${S.invites.map((v, k) => `<tr><td class="mono" style="font-size:12.5px">${esc(v.email)}</td><td><span class="pill line">Member</span></td><td class="ink2">${esc(v.team)}</td><td class="ink2">${esc(v.by)}</td><td class="${v.expires.includes('hours') ? '' : 'muted'}" style="${v.expires.includes('hours') ? 'color:var(--amber-ink);font-weight:600' : ''}">${v.expires}</td>
        <td style="text-align:right;white-space:nowrap"><button class="btn sm ghost" data-toast="Invitation sent again to ${esc(v.email)}">Resend</button><button class="btn sm ghost" data-revoke="${k}">Revoke</button></td></tr>`).join('') || `<tr><td colspan="6" class="empty">No open invitations.</td></tr>`}</tbody></table>`}</div></div>
  </div>`;
};

V.teams = () => `<div class="page">
  <div class="head"><div><h1>Teams</h1><p>Teams decide who reaches which instance. A person can be in several teams.</p></div>
    <div class="acts"><button class="btn primary" id="new-team">${icon('plus')}New team</button></div></div>
  <div class="grid g2">${S.teams.map((t) => {
    const ppl = S.members.filter((m) => m.teams.includes(t));
    const ins = S.instances.filter((i) => i.teams.includes(t));
    return `<div class="card stack click" data-go="team" data-p="${P({ t })}" style="cursor:pointer;gap:12px">
      <div class="between"><b style="font-size:16px;font-weight:700">${esc(t)}</b>${icon('chev')}</div>
      <div class="flex" style="gap:0">${ppl.map((m) => `<span class="av" title="${esc(m.name)}" style="width:28px;height:28px;font-size:10.5px;border:2px solid var(--panel);margin-right:-8px">${initials(m.name)}</span>`).join('')}<span class="muted" style="margin-left:14px;font-size:12.5px">${ppl.length} people</span></div>
      <div class="flex">${ins.map((i) => `<span class="pill line"><span class="dot" style="background:var(--${STATUS[shownStatus(i)].tone})"></span>${esc(i.name)}</span>`).join('') || '<span class="muted">No instances yet</span>'}</div></div>`;
  }).join('')}</div></div>`;

V.team = () => {
  const t = app.params.t;
  const ppl = S.members.filter((m) => m.teams.includes(t));
  return `<div class="page narrow">
    <div><div class="crumb"><button data-go="teams">Teams</button>${icon('chev')}<span>${esc(t)}</span></div>
    <div class="head"><div><h1>${esc(t)}</h1><p>${ppl.length} people · ${S.instances.filter((i) => i.teams.includes(t)).length} instances</p></div>
    <div class="acts"><button class="btn" data-toast="Renaming is inline in the real UI">Rename</button><button class="btn danger" data-toast="Teams are deleted with a typed name (D30 is only for instances and the org)">Delete team</button></div></div></div>
    <div class="card"><div class="card-head"><h2>People</h2><button class="btn sm" id="add-person">${icon('plus')}Add</button></div>
      <div class="list">${ppl.map((m) => `<div class="row"><span class="av">${initials(m.name)}</span><div class="t"><b>${esc(m.name)}</b><span>${esc(m.email)}</span></div><div class="r"><button class="btn sm ghost" data-toast="Removed ${esc(m.name)} from ${esc(t)}">Remove</button></div></div>`).join('')}</div></div>
    <div class="card"><div class="card-head"><h2>Instances</h2></div>
      <div class="rows">${S.instances.map((i) => `<label class="row" style="cursor:pointer">${glyph(shownStatus(i))}<div class="t"><b>${esc(i.name)}</b><span class="mono">${host(i)}</span></div><div class="r"><span class="switch"><input type="checkbox" id="ti-${i.id}" ${i.teams.includes(t) ? 'checked' : ''} aria-label="${esc(t)} can use ${esc(i.name)}"><i></i></span></div></label>`).join('')}</div></div>
  </div>`;
};

V.security = () => {
  const m = S.policy.methods;
  const meth = [['email', 'Email code', 'A 6-digit code by email'], ['passkey', 'Passkey', 'Face, fingerprint or security key'], ['google', 'Google', 'Google accounts with a verified address'], ['microsoft', 'Microsoft', 'Personal and work Microsoft accounts'], ['sso', 'Your SSO', S.sso.name]];
  return `<div class="page narrow">
    <div class="head"><div><h1>Sign-in and security</h1><p>How people in ${esc(org().name)} sign in. An instance can ask for more, never less.</p></div></div>
    <div class="card stack"><div class="card-head" style="margin:0"><h2>Allowed sign-in methods</h2><span class="sub">Org default</span></div>
      <div class="rows">${meth.map(([k, l, d]) => `<label class="row" style="cursor:pointer"><div class="t"><b>${l}</b><span>${esc(d)}</span></div><div class="r"><span class="switch"><input type="checkbox" id="m-${k}" data-method="${k}" ${m[k] ? 'checked' : ''}><i></i></span></div></label>`).join('')}</div>
      <div class="field"><label for="dom">Only these addresses</label><select class="inp" id="dom"><option>@acme-robotics.eu</option><option>Any address</option></select><span class="hint">Tightening this signs out people who no longer qualify, so it asks for confirmation by email.</span></div>
      <div class="flex" style="justify-content:flex-end"><button class="btn primary" id="save-policy">Save policy</button></div></div>
    <div class="card"><div class="card-head"><h2>Verified domains</h2><button class="btn sm" id="add-domain">${icon('plus')}Add domain</button></div>
      <div class="rows">${S.domains.map((d) => `<div class="row">${d.state === 'verified' ? `<span class="g green">${icon('check')}</span>` : `<span class="g amber">${icon('question')}</span>`}<div class="t"><b class="mono" style="font-weight:500">${esc(d.name)}</b><span>${d.state === 'verified' ? 'Verified with a DNS TXT record' : `Add TXT <span class="mono">_worca.${esc(d.name)}</span> = <span class="mono">${esc(d.txt)}</span>`}</span></div><div class="r">${d.state === 'verified' ? '<span class="pill green">Verified</span>' : '<button class="btn sm" data-toast="Checked DNS: record not found yet. DNS can take an hour.">Check now</button>'}</div></div>`).join('')}</div></div>
    <div class="card"><div class="card-head"><h2>Single sign-on</h2><span class="pill green">Active</span></div>
      <dl class="kv"><dt>Provider</dt><dd>${esc(S.sso.name)}</dd><dt>Protocol</dt><dd>${S.sso.type}</dd><dt>Issuer</dt><dd class="mono" style="font-size:12.5px">${esc(S.sso.issuer)}</dd><dt>For addresses</dt><dd class="mono" style="font-size:12.5px">@acme-robotics.eu</dd><dt>Redirect URL</dt><dd class="mono" style="font-size:12.5px">https://app.worca.dev/api/auth/sso/callback/acme</dd></dl></div>
  </div>`;
};

V.audit = () => `<div class="page">
  <div class="head"><div><h1>Audit log</h1><p>Every change in ${esc(org().name)}, kept for 30 days.</p></div><div class="acts"><button class="btn" data-toast="CSV download starts in the real UI">${icon('download')}Export CSV</button></div></div>
  <div class="flex"><div class="seg"><button class="on">Everything</button><button>Instances</button><button>Members</button><button>Security</button></div></div>
  <div class="card" style="padding:8px 14px"><div class="tablewrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
  <tbody>${S.audit.map((a) => `<tr><td class="muted" style="white-space:nowrap">${a[0]}</td><td style="white-space:nowrap">${esc(a[1])}</td><td>${esc(a[2])}</td></tr>`).join('')}</tbody></table></div></div></div>`;

V.settings = () => `<div class="page narrow">
  <div class="head"><div><h1>Org settings</h1></div></div>
  <div class="card stack"><div class="field"><label for="o-name">Org name</label><input class="inp" id="o-name" value="${esc(org().name)}"></div>
    <dl class="kv"><dt>Plan</dt><dd>${org().tier} · ${org().limit} instances · <button class="linkbtn" data-toast="Plans are changed by worca support for now">Change plan</button></dd><dt>Org id</dt><dd class="mono">${org().id}</dd><dt>Created</dt><dd>July 2, 2026</dd></dl>
    <div class="flex" style="justify-content:flex-end"><button class="btn primary" data-toast="Saved">Save</button></div></div>
  <div class="card"><div class="card-head"><h2>Encryption</h2></div>
    <div class="between"><span class="ink2" style="max-width:56ch">Names, emails and settings of ${esc(org().name)} are encrypted with a key of its own. Rotating it re-encrypts everything in the background.</span><button class="btn" id="rotate">${icon('key')}Rotate key</button></div>
    <div class="muted" style="font-size:12px;margin-top:10px">Last rotated Sep 30 by Maja Horvat</div></div>
  <div class="card danger-zone"><div class="card-head"><h2>Delete the org</h2></div>
    <div class="between"><span class="ink2" style="max-width:56ch">Deletes all ${S.instances.length} instances, every member's access and the audit log. Other admins get an email when it's done.</span><button class="btn danger" id="del-org">${icon('trash')}Delete org</button></div></div></div>`;

V.myorg = () => `<div class="page narrow">
  <div class="head"><div><h1>Your teams</h1><p>In ${esc(org().name)} you're a member of these teams. Admins decide who's in which.</p></div></div>
  <div class="rows">${myTeams().map((t) => `<div class="row">${icon('team')}<div class="t"><b>${t}</b><span>${S.instances.filter((i) => i.teams.includes(t)).map((i) => i.name).join(', ') || 'No instances'}</span></div></div>`).join('')}</div>
  <div class="label">Admins of ${esc(org().name)}</div>
  <div class="rows">${S.members.filter((m) => m.role === 'admin').map((m) => `<div class="row"><span class="av">${initials(m.name)}</span><div class="t"><b>${esc(m.name)}</b><span>${esc(m.email)}</span></div></div>`).join('')}</div></div>`;

V.directory = () => `<div class="page">
  <div class="head"><div><h1>People</h1><p>Everyone in ${esc(org().name)}. Admins manage the org; ask one of them to change your teams.</p></div></div>
  <div class="card" style="padding:8px 14px"><div class="tablewrap"><table>
    <thead><tr><th>Person</th><th>Role</th><th>Teams</th></tr></thead>
    <tbody>${S.members.map((m) => `<tr><td><div class="who"><span class="av">${initials(m.name)}</span><div class="t"><b style="font-weight:600">${esc(m.name)}</b><span>${esc(m.email)}</span></div></div></td>
      <td>${m.role === 'admin' ? '<span class="pill violet">Admin</span>' : '<span class="pill line">Member</span>'}</td><td class="ink2">${m.teams.map(esc).join(', ')}</td></tr>`).join('')}</tbody></table></div></div></div>`;

V.account = () => {
  const tab = app.params.tab || 'profile';
  return `<div class="page narrow">
    <div class="head"><div><h1>Account</h1><p>${esc(ME.email)}</p></div></div>
    <div class="seg">${[['profile', 'Profile'], ['signin', 'Sign-in'], ['sessions', 'Devices'], ['data', 'Your data']].map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-go="account" data-p="${P({ tab: k })}">${l}</button>`).join('')}</div>
    ${tab === 'profile' ? `<div class="card form"><div class="field"><label for="p-name">Name</label><input class="inp" id="p-name" value="${esc(ME.name)}"></div><div class="field"><label for="p-mail">Email</label><input class="inp" id="p-mail" value="${esc(ME.email)}" disabled><span class="hint">Your email identifies you in every org; it can't be changed here.</span></div><div class="flex" style="justify-content:flex-end"><button class="btn primary" data-toast="Saved">Save</button></div></div>` : ''}
    ${tab === 'signin' ? `<div class="card"><div class="card-head"><h2>Passkeys</h2><button class="btn sm" data-toast="Your browser asks for your device now">${icon('plus')}Add passkey</button></div>
      <div class="rows"><div class="row">${icon('fingerprint')}<div class="t"><b>MacBook Pro · Touch ID</b><span>Added Jul 2 · used today</span></div><div class="r"><button class="btn sm ghost" data-toast="Removing a passkey needs a passkey session">Remove</button></div></div>
      <div class="row">${icon('key')}<div class="t"><b>YubiKey 5C</b><span>Added Aug 20 · used Sep 30</span></div><div class="r"><button class="btn sm ghost">Remove</button></div></div></div>
      <div class="hint" style="margin-top:10px">A passkey also counts as your second factor for admin actions.</div></div>
      <div class="card"><div class="card-head"><h2>Linked accounts</h2></div><div class="rows">
      <div class="row">${icon('globe')}<div class="t"><b>Google</b><span>maja@acme-robotics.example</span></div><div class="r"><button class="btn sm ghost">Unlink</button></div></div>
      <div class="row">${icon('globe')}<div class="t"><b>Microsoft</b><span>Not linked</span></div><div class="r"><button class="btn sm">Link</button></div></div></div></div>` : ''}
    ${tab === 'sessions' ? `<div class="card"><div class="card-head"><h2>Signed-in devices</h2><button class="btn sm" data-toast="Signed out 2 other devices; their open instance tabs stop within a minute">Sign out all others</button></div>
      <div class="rows"><div class="row">${icon('laptop')}<div class="t"><b>Chrome on macOS · this device</b><span>Passkey · active now</span></div><div class="r"><span class="pill green">This one</span></div></div>
      <div class="row">${icon('laptop')}<div class="t"><b>Safari on iPhone</b><span>Passkey · 2 h ago</span></div><div class="r"><button class="btn sm ghost">Sign out</button></div></div>
      <div class="row">${icon('laptop')}<div class="t"><b>Firefox on Linux</b><span>Email code · Oct 1</span></div><div class="r"><button class="btn sm ghost">Sign out</button></div></div></div></div>` : ''}
    ${tab === 'data' ? `<div class="card"><div class="card-head"><h2>Your data</h2></div><div class="between"><span class="ink2">Everything worca holds about you: profile, sign-in methods, memberships and your audit entries, as JSON.</span><button class="btn" data-toast="Export prepared">${icon('download')}Download</button></div></div>
      <div class="card danger-zone"><div class="card-head"><h2>Delete your account</h2></div><div class="between"><span class="ink2" style="max-width:56ch">Removes you from every org. You can't delete it while you're the last admin of an org.</span><button class="btn danger" id="del-me">Delete account</button></div></div>` : ''}
  </div>`;
};

// ---- gate preview (what opening an instance looks like) ------------------------------------
function openInstance(id) {
  const i = inst(id) || NORTH.find((n) => n.id === id);
  if (i.status === 'running') return toast(`Opens ${host(i)} in a new tab`, 'ext');
  openModal(`<div class="mail" style="border-radius:14px"><div class="mh" style="flex-direction:row;align-items:center;gap:8px"><span class="dot" style="background:#E8B4AC"></span><span class="dot" style="background:#EAD3A2"></span><span class="dot" style="background:#BCD8B4"></span><span class="mono" style="margin-left:8px;font-size:11.5px">${host(i)}</span></div>
    <div class="mb" style="align-items:center;text-align:center;padding:34px 20px;gap:12px" id="gate">
      <span class="g blue lg spin">${icon('loader')}</span><b style="font-size:18px;color:var(--ink)">Waking ${esc(i.name)}</b>
      <span>It was asleep to save resources. This usually takes under 10 seconds; this page continues by itself.</span>
      <div class="bar" style="width:220px"><i id="gate-bar" style="width:8%;background:var(--blue);transition:width .3s"></i></div></div></div>
    <p class="muted" style="font-size:12px;text-align:center">Prototype: this page is served by the gate on the instance's own address.</p>`, {
    onMount: () => {
      let p = 8;
      const t = setInterval(() => {
        p += 18; const bar = $('#gate-bar'); if (!bar) return clearInterval(t);
        bar.style.width = Math.min(p, 100) + '%';
        if (p >= 100) { clearInterval(t); i.status = 'running'; i.beat = 'just now'; closeModal(); app.render(); toast(`${i.name} is awake · opens in a new tab`, 'ext'); }
      }, 450);
    } });
}

// ---- events ----------------------------------------------------------------------------------
function bind() {
  document.querySelectorAll('[data-role]').forEach((b) => (b.onclick = () => { S.role = b.dataset.role; S.org = 'acme'; go('home'); }));
  document.querySelectorAll('[data-open]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); openInstance(b.dataset.open); }));
  document.querySelectorAll('[data-toast]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); toast(b.dataset.toast, 'info'); }));
  document.querySelectorAll('[data-org]').forEach((b) => (b.onclick = () => { S.org = b.dataset.org; go('home'); }));
  const sw = $('#switch');
  if (sw) sw.onclick = () => openModal(`<h2>Switch org</h2><div class="rows">${Object.entries(S.orgs).map(([k, o]) => `<div class="row click" data-pick="${k}"><span class="av" style="border-radius:8px">${initials(o.name)}</span><div class="t"><b>${esc(o.name)}</b><span>${o.role === 'admin' ? 'Tenant admin' : 'Tenant user'} · ${o.tier}</span></div><div class="r">${k === S.org ? '<span class="pill green">Current</span>' : icon('chev')}</div></div>`).join('')}</div>
    <p class="hint">Platform staff also see "Platform console" here.</p>`, { onMount: (m) => m.querySelectorAll('[data-pick]').forEach((r) => (r.onclick = () => { S.org = r.dataset.pick; closeModal(); go('home'); })) });
  const menu = $('#menu'); if (menu) menu.onclick = () => $('#sb').classList.toggle('open');
  const so = document.querySelector('[data-signout]'); if (so) so.onclick = () => toast('Signs out here and closes your open instance tabs', 'logout');

  const cf = $('#create-form');
  if (cf) cf.onsubmit = (e) => {
    e.preventDefault();
    const name = $('#c-name').value.trim() || 'New instance';
    go('progress', { step: 0, name });
    const tick = (n) => setTimeout(() => { if (app.view !== 'progress') return; go('progress', { step: n, name }); if (n < STEPS.length) tick(n + 1); }, n === 1 ? 900 : 1300);
    tick(1);
  };
  const up = $('#upgrade');
  if (up) up.onclick = () => openModal(`<h2>Upgrade to worca 1.8.0?</h2><p>Data pipelines restarts with the new version; its address and data stay. Pipelines running at that moment are interrupted and can be resumed afterwards. Pick a quiet moment.</p>
    <div class="acts"><button class="btn" data-x>Not now</button><button class="btn primary" id="go-up">Upgrade</button></div>`, { onMount: (m) => { m.querySelector('[data-x]').onclick = closeModal; m.querySelector('#go-up').onclick = () => { const i = inst(app.params.id); i.status = 'upgrading'; closeModal(); app.render(); setTimeout(() => { i.status = 'running'; i.version = '1.8.0'; i.avail = null; app.render(); toast('Data pipelines now runs 1.8.0'); }, 2600); }; } });
  const del = $('#del');
  if (del) del.onclick = () => { const i = inst(app.params.id); destructive({ title: 'Delete instance', what: 'Delete an instance', name: i.name, actor: ME.email, consequence: `<b>${esc(i.name)}</b> (${host(i)}) and all its data are deleted for good. ${i.teams.join(', ')} lose access right away.`, onConfirmed: () => { i.status = 'deleting'; app.render(); toast(`${i.name} is being deleted`, 'trash'); setTimeout(() => { S.instances = S.instances.filter((x) => x !== i); if (app.view === 'instance') go('instances'); else app.render(); }, 2500); } }); };
  const delOrg = $('#del-org');
  if (delOrg) delOrg.onclick = () => destructive({ title: 'Delete org', what: 'Delete the organization', name: org().name, actor: ME.email, consequence: `All ${S.instances.length} instances of <b>${esc(org().name)}</b> and everyone's access are deleted for good.`, onConfirmed: () => toast('Prototype: the org would be deleted now', 'trash') });
  const delMe = $('#del-me');
  if (delMe) delMe.onclick = () => destructive({ title: 'Delete account', what: 'Delete your account', name: ME.email, actor: ME.email, needsPasskey: false, consequence: 'You are the last admin of <b>Acme Robotics</b>. Make someone else an admin first, or delete the org.', onConfirmed: () => toast('Refused: last admin of Acme Robotics', 'alert') });
  const rot = $('#rotate');
  if (rot) rot.onclick = () => openModal(`<div class="center"><span class="g violet lg">${icon('fingerprint')}</span><h2>Rotate the org key?</h2><p>Re-encrypts names, emails and settings of ${esc(org().name)}. Nothing is unavailable while it runs. Needs your passkey.</p></div><div class="acts"><button class="btn" data-x>Cancel</button><button class="btn primary" id="rk">Use passkey and rotate</button></div>`, { onMount: (m) => { m.querySelector('[data-x]').onclick = closeModal; m.querySelector('#rk').onclick = () => { closeModal(); toast('Rotating the key · about a minute'); }; } });
  const inv = $('#invite');
  if (inv) inv.onclick = () => openModal(`<h2>Invite people</h2><div class="form">
    <div class="field"><label for="i-mail">Email addresses</label><textarea class="inp" id="i-mail" rows="3" placeholder="one per line">priya@acme-robotics.example</textarea><span class="hint">Only @acme-robotics.eu can sign in under your policy.</span></div>
    <div class="grid g2"><div class="field"><label for="i-role">Role</label><select class="inp" id="i-role"><option>Member</option><option>Admin</option></select></div>
    <div class="field"><label for="i-team">Team</label><select class="inp" id="i-team">${S.teams.map((t) => `<option>${t}</option>`).join('')}</select></div></div></div>
    <div class="acts"><button class="btn" data-x>Cancel</button><button class="btn primary" id="i-go">Send invitation</button></div>`, { onMount: (m) => { m.querySelector('[data-x]').onclick = closeModal; m.querySelector('#i-go').onclick = () => { const e = m.querySelector('#i-mail').value.trim().split(/\s+/)[0] || 'someone@acme-robotics.example'; S.invites.unshift({ email: e, role: 'user', team: m.querySelector('#i-team').value, by: ME.name, expires: 'in 7 days' }); closeModal(); go('members', { f: 'inv' }); toast(`Invitation sent to ${e}`, 'mail'); }; } });
  document.querySelectorAll('[data-revoke]').forEach((b) => (b.onclick = () => { const v = S.invites.splice(+b.dataset.revoke, 1)[0]; app.render(); toast(`Invitation to ${v.email} revoked`); }));
  document.querySelectorAll('[data-member]').forEach((b) => (b.onclick = () => { const mb = S.members[+b.dataset.member]; openModal(`<h2>${esc(mb.name)}</h2><p class="mono" style="font-size:12.5px">${esc(mb.email)}</p>
    <div class="field"><label for="mr">Role</label><select class="inp" id="mr"><option ${mb.role === 'user' ? 'selected' : ''}>Member</option><option ${mb.role === 'admin' ? 'selected' : ''}>Admin</option></select></div>
    <div class="field"><label>Teams</label><div class="checks">${S.teams.map((t, k) => `<label class="check"><input type="checkbox" id="mt-${k}" ${mb.teams.includes(t) ? 'checked' : ''}><span class="t"><b>${t}</b></span></label>`).join('')}</div></div>
    <div class="acts" style="justify-content:space-between"><button class="btn danger" id="rm">Remove from org</button><span class="flex"><button class="btn" data-x>Cancel</button><button class="btn primary" id="ms">Save</button></span></div>`, { onMount: (m) => { m.querySelector('[data-x]').onclick = closeModal; m.querySelector('#ms').onclick = () => { closeModal(); toast('Saved'); }; m.querySelector('#rm').onclick = () => { S.members = S.members.filter((x) => x !== mb); closeModal(); app.render(); toast(`${mb.name} removed; their open instance tabs stop within a minute`); }; } }); }));
  const et = $('#edit-teams');
  if (et) et.onclick = () => { const i = inst(app.params.id); openModal(`<h2>Who can use ${esc(i.name)}</h2><div class="checks">${S.teams.map((t, k) => `<label class="check"><input type="checkbox" id="et-${k}" value="${t}" ${i.teams.includes(t) ? 'checked' : ''}><span class="t"><b>${t}</b><span>${S.members.filter((m) => m.teams.includes(t)).length} people</span></span></label>`).join('')}</div><p class="hint">People who lose access are signed out of the instance within a minute.</p><div class="acts"><button class="btn" data-x>Cancel</button><button class="btn primary" id="ets">Save</button></div>`, { onMount: (m) => { m.querySelector('[data-x]').onclick = closeModal; m.querySelector('#ets').onclick = () => { i.teams = [...m.querySelectorAll('input:checked')].map((x) => x.value); closeModal(); app.render(); toast('Access updated'); }; } }); };
  const ep = $('#edit-policy');
  if (ep) ep.onclick = () => { const i = inst(app.params.id); openModal(`<h2>Sign-in for ${esc(i.name)}</h2><p>Stricter than the org if you like. People signed in another way are asked to sign in again before they get in.</p><div class="checks">${['Org default', 'Passkey or SSO', 'SSO only'].map((p, k) => `<label class="check"><input type="radio" name="pp" id="pp-${k}" value="${p}" ${i.policy === p ? 'checked' : ''}><span class="t"><b>${p}</b></span></label>`).join('')}</div><div class="acts"><button class="btn" data-x>Cancel</button><button class="btn primary" id="pps">Save</button></div>`, { onMount: (m) => { m.querySelector('[data-x]').onclick = closeModal; m.querySelector('#pps').onclick = () => { i.policy = m.querySelector('input:checked').value; closeModal(); app.render(); toast('Sign-in rule saved'); }; } }); };
  const sp = $('#save-policy');
  if (sp) sp.onclick = () => destructive({ title: 'Change login policy', what: 'Change the login policy', name: org().name, actor: ME.email, typed: false, consequence: '<b>Ines Novak</b> signs in with an email code, which this policy no longer allows. She is signed out and has to use another method next time.', onConfirmed: () => toast('Login policy changed; 1 person signed out') });
  const nt = $('#new-team');
  if (nt) nt.onclick = () => openModal(`<h2>New team</h2><div class="field"><label for="nt-n">Name</label><input class="inp" id="nt-n" value="Firmware"></div><div class="acts"><button class="btn" data-x>Cancel</button><button class="btn primary" id="nt-go">Create team</button></div>`, { onMount: (m) => { m.querySelector('[data-x]').onclick = closeModal; m.querySelector('#nt-go').onclick = () => { const n = m.querySelector('#nt-n').value.trim(); if (n) S.teams.push(n); closeModal(); go('team', { t: n }); }; } });
  const ad = $('#add-domain');
  if (ad) ad.onclick = () => { S.domains.push({ name: 'acme-robotics.com', state: 'pending', txt: 'worca-verify=91be2c04f7a3' }); app.render(); toast('Add the TXT record, then check'); };
}

app.render = () => {
  if (!app.view) app.view = 'home';
  const allowed = isAdmin() ? Object.keys(V).filter((k) => k !== 'directory') : ['home', 'myorg', 'directory', 'account'];
  if (!allowed.includes(app.view)) app.view = 'home';
  $('#root').innerHTML = shell(V[app.view]());
  bind();
};
go('home');
