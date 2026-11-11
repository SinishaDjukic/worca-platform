// The app shell: sidebar with the context switcher (Home, each org, Platform console) and the
// navigation of the current area. Areas: 'personal' (/, /account...), 'org' (/o/:orgId/...),
// 'platform' (/platform/...). Every nav entry of every area is declared here, so views only
// register their routes.
import { $, brand, features, html, icon, initials, isOrgAdmin, isStaff, hasRole, orgOf, setHtml, state, openModal, closeModal } from './core.mjs';

const ROLE_LABEL = { tenant_admin: 'Tenant admin', tenant_user: 'Tenant user' };
const STAFF_LABEL = { superadmin: 'Superadmin', admin: 'Platform admin', support: 'Support' };

/** nav: [{ key, href, icon, label, show? }], grouped by section. */
function orgNav(orgId) {
  const base = `/o/${encodeURIComponent(orgId)}`;
  if (isOrgAdmin(orgId)) {
    return [
      { cta: true, key: 'instance-new', href: `${base}/instances/new`, icon: 'plus', label: 'New instance' },
      { sect: 'Work' },
      { key: 'overview', href: base, icon: 'chart', label: 'Overview' },
      { key: 'instances', href: `${base}/instances`, icon: 'server', label: 'Instances' },
      { sect: 'Manage' },
      { key: 'members', href: `${base}/members`, icon: 'users', label: 'Members' },
      { key: 'teams', href: `${base}/teams`, icon: 'team', label: 'Teams' },
      { key: 'security', href: `${base}/security`, icon: 'shield', label: 'Sign-in and security' },
      { key: 'audit', href: `${base}/audit`, icon: 'history', label: 'Audit log' },
      { key: 'settings', href: `${base}/settings`, icon: 'settings', label: 'Org settings' },
    ];
  }
  return [
    { sect: 'Work' },
    { key: 'overview', href: base, icon: 'server', label: 'Instances' },
    { sect: 'Org' },
    { key: 'members', href: `${base}/members`, icon: 'users', label: 'People' },
    { key: 'teams', href: `${base}/teams`, icon: 'team', label: 'Teams' },
  ];
}
function platformNav() {
  const admin = hasRole('admin', 'superadmin');
  const sa = hasRole('superadmin');
  return [
    { sect: 'Platform' },
    { key: 'p-overview', href: '/platform', icon: 'chart', label: 'Overview' },
    { key: 'p-orgs', href: '/platform/orgs', icon: 'building', label: 'Orgs' },
    { key: 'p-instances', href: '/platform/instances', icon: 'server', label: 'Instances' },
    { key: 'p-ops', href: '/platform/ops', icon: 'activity', label: 'Operations' },
    admin && { sect: 'People' },
    admin && { key: 'p-registration', href: '/platform/registration', icon: 'ticket', label: 'Registration' },
    sa && features.accessRequests && { key: 'p-access', href: '/platform/access-requests', icon: 'mail', label: 'Access requests' },
    admin && { key: 'p-users', href: '/platform/users', icon: 'user', label: 'Users and support' },
    admin && { key: 'p-audit', href: '/platform/audit', icon: 'history', label: 'Audit log' },
    { sect: 'System' },
    { key: 'p-releases', href: '/platform/releases', icon: 'tag', label: 'Releases' },
    features.tiers && { key: 'p-tiers', href: '/platform/tiers', icon: 'chart', label: 'Tiers' },
    sa && { key: 'p-roles', href: '/platform/roles', icon: 'crown', label: 'Platform roles' },
    { key: 'p-system', href: '/platform/system', icon: 'settings', label: 'System' },
  ].filter(Boolean);
}
function personalNav() {
  return [
    { sect: 'You' },
    { key: 'home', href: '/', icon: 'home', label: 'Home' },
    { key: 'account', href: '/account', icon: 'user', label: 'Account' },
    { key: 'sessions', href: '/account/sessions', icon: 'laptop', label: 'Devices' },
    { key: 'data', href: '/account/data', icon: 'download', label: 'Your data' },
  ];
}

const navItems = (items, active) =>
  items.map((it) =>
    it.sect
      ? html`<div class="nav-sect">${it.sect}</div>`
      : html`<a class="navlink${it.cta ? ' cta' : ''}${it.key === active ? ' active' : ''}" href="${it.href}"${it.key === active ? html` aria-current="page"` : ''}>${icon(it.icon)}<span>${it.label}</span></a>`,
  );

function contextCard(area, orgId) {
  if (area === 'org' && orgOf(orgId)) {
    const o = orgOf(orgId);
    return html`<span class="av">${initials(o.name)}</span><span class="t"><b>${o.name || 'Unnamed org'}</b><span>${ROLE_LABEL[o.role] || o.role}</span></span>`;
  }
  if (area === 'platform') {
    const role = ['superadmin', 'admin', 'support'].find((r) => hasRole(r));
    return html`<span class="av">${icon('crown')}</span><span class="t"><b>Platform console</b><span>${STAFF_LABEL[role] || ''}</span></span>`;
  }
  const me = state.me.user;
  return html`<span class="av">${initials(me.name || me.email)}</span><span class="t"><b>${me.name || me.email}</b><span>All your instances</span></span>`;
}

function openSwitcher() {
  const orgs = state.me.orgs || [];
  const m = openModal(html`
    <h2>Switch to</h2>
    <div class="rows">
      <a class="row click" href="/"><span class="av">${icon('home')}</span><div class="t"><b>Home</b><span>Your instances, across all your orgs</span></div><div class="r">${icon('chev')}</div></a>
      ${orgs.map((o) => html`<a class="row click" href="/o/${encodeURIComponent(o.id)}"><span class="av">${initials(o.name)}</span><div class="t"><b>${o.name || 'Unnamed org'}</b><span>${ROLE_LABEL[o.role] || o.role} · ${o.instances} ${o.instances === 1 ? 'instance' : 'instances'}</span></div><div class="r">${icon('chev')}</div></a>`)}
      ${isStaff() ? html`<a class="row click" href="/platform"><span class="av">${icon('crown')}</span><div class="t"><b>Platform console</b><span>Orgs, instances, registration, system</span></div><div class="r">${icon('chev')}</div></a>` : ''}
    </div>
    <div class="acts"><a class="btn" href="/welcome">${icon('plus')}Create an org</a><button class="btn" data-close>Close</button></div>`);
  for (const a of m.querySelectorAll('a')) a.addEventListener('click', () => closeModal());
}

let shown = null; // { area, orgId } of the shell on screen
/** Repaints the context card (name of the person or org) after a rename, without re-rendering the page. */
export function repaintContext() {
  const b = $('#switch');
  if (b && shown) setHtml(b, html`${contextCard(shown.area, shown.orgId)}${icon('chevDown')}`);
}

/** Renders the shell for `view` and returns the element the view renders into. */
export function renderShell(view, params) {
  const root = $('#app');
  const area = view.area || 'personal';
  shown = { area, orgId: params.orgId };
  const items = area === 'org' && params.orgId && orgOf(params.orgId) ? orgNav(params.orgId) : area === 'platform' ? platformNav() : personalNav();
  if (view.bare) {
    setHtml(root, html`<main class="main bare" id="main"></main>`);
    return $('#main');
  }
  setHtml(root, html`
    <div class="app">
      <aside class="sidebar" id="sb">
        <div class="brand"><a href="/" class="logo" aria-label="${brand.product} home"></a><span class="tag">cloud</span>
          <button class="btn ghost sm menu-btn" id="menu" aria-label="Menu" aria-expanded="false">${icon('menu')}</button></div>
        <button class="ctx" id="switch" aria-haspopup="dialog">${contextCard(area, params.orgId)}${icon('chevDown')}</button>
        <nav class="nav" aria-label="Main">${navItems(items, typeof view.nav === 'function' ? view.nav(params) : view.nav)}</nav>
        <div class="side-foot">
          <nav class="nav" aria-label="Account">
            ${area !== 'personal' ? html`<a class="navlink" href="/account">${icon('user')}<span>Account</span></a>` : ''}
            <form method="post" action="/sign-out" class="navform"><button class="navlink" type="submit">${icon('logout')}<span>Sign out</span></button></form>
          </nav>
        </div>
      </aside>
      <main class="main" id="main"></main>
    </div>`);
  $('#switch').addEventListener('click', openSwitcher);
  $('#menu').addEventListener('click', (e) => {
    const sb = $('#sb');
    sb.classList.toggle('open');
    e.currentTarget.setAttribute('aria-expanded', String(sb.classList.contains('open')));
  });
  return $('#main');
}
