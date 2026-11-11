// Outbound network policy (D73): the editor shared by the org's Security page and the instance
// dialog, its plain-language summaries, and its refusals as field errors.
// API: GET/PUT /api/orgs/:orgId/egress, GET/PUT /api/orgs/:orgId/instances/:id/egress.
import { $, $$, ApiError, fieldError, html, icon, plural } from './core.mjs';

/** The first Worca release that enforces the policy (worca-cc #634). */
export const EGRESS_MIN_WORCA = '1.11.0';
/** Said wherever the policy is edited: from which version it applies, and how far it reaches (a
 * proxy inside Worca's container, not a firewall: worca-cc docs, "Outbound network policy"). */
export const EGRESS_NOTE = `Saved and sent to your instances. Worca applies it from version ${EGRESS_MIN_WORCA}; instances on older versions ignore it. It covers tools that go through Worca's proxy, which most do; a program that bypasses the proxy on purpose can still connect.`;

export const MODES = [
  ['open', 'Open', 'Agents can reach any host'],
  ['block', 'Open except blocked hosts', 'Everything except the hosts you block'],
  ['allow', 'Only allowed hosts', 'Nothing except the hosts you allow; blocked hosts are carved out'],
];
export const MODE_LABEL = Object.fromEntries(MODES.map(([k, label]) => [k, label]));

/** "Open", "Open except 2 blocked hosts", "Only 5 allowed hosts, 1 blocked". */
export function policyLine(p) {
  if (!p) return '—';
  if (p.mode === 'block') return p.deny.length ? `Open except ${plural(p.deny.length, 'blocked host')}` : 'Open: nothing blocked yet';
  if (p.mode === 'allow') return `Only ${plural(p.allow.length, 'allowed host')}${p.deny.length ? `, ${p.deny.length} blocked` : ''}`;
  return 'Open: agents can reach any host';
}

const REASON = {
  scheme: 'Leave out https:// and the like: just the host name.',
  path: 'Just the host name, without a path.',
  port: 'Leave out the port: just the host name.',
  ip: 'IP addresses are not supported yet: use a host name.',
  wildcard: 'A * only works as the first part, as in *.example.com.',
  no_dot: 'Use a full host name with a dot, like example.com.',
  label: 'Each part between dots needs 1 to 63 letters, digits or inner hyphens.',
  length: 'That host name is too long.',
  chars: 'Use letters, digits, hyphens and dots only.',
  empty: 'Enter a host name.',
};

/** The text of a refused policy, or '' when `e` isn't one of ours. */
export function egressRefusal(e) {
  if (!(e instanceof ApiError)) return '';
  const b = e.body || {};
  if (e.code === 'egress_host_invalid') return `${b.entry ? `"${b.entry}": ` : ''}${REASON[b.reason] || 'That is not a host name.'}`;
  if (e.code === 'egress_too_many') return 'At most 200 hosts per list.';
  if (e.code === 'egress_blocks_platform_host') return `${b.entry || 'This entry'} would block a host Worca needs to work. Those are always allowed.`;
  return '';
}

/** Puts a refused policy under its list; true when it was one. */
export function showEgressRefusal(root, prefix, e) {
  const text = egressRefusal(e);
  if (!text) return false;
  const field = e.body?.field === 'allow' ? 'allow' : 'deny';
  fieldError($(`#${prefix}-${field}`, root), text);
  return true;
}

/** One host per line (commas and spaces split too); blanks dropped. The server normalizes. */
export const parseHosts = (text) => String(text || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

/** The always-allowed hosts, read-only. */
export function platformHostsMarkup(hosts) {
  return html`<div class="field"><div class="label">Always allowed</div>
    <div class="rows eg-hosts">${(hosts || []).map((h) => html`<div class="row">${icon('lock')}<div class="t"><b class="mono">${h.host}</b><span>${h.why}</span></div></div>`)}</div>
    <span class="hint">What an instance needs to work. They can't be blocked.</span></div>`;
}

/**
 * The editor: mode radios, the allowlist (allow mode), the blocklist (block and allow modes), and
 * the always-allowed hosts. Element ids start with `prefix`.
 */
export function editorMarkup(prefix, policy, platformHosts) {
  const p = policy || { mode: 'open', allow: [], deny: [] };
  return html`<fieldset class="field eg-fieldset"><legend>Agents can reach</legend><div class="checks">${MODES.map(([k, label, desc]) => html`
      <label class="check"><input type="radio" name="${prefix}-mode" value="${k}" ${p.mode === k ? 'checked' : ''}><span class="t"><b>${label}</b><span>${desc}</span></span></label>`)}
    </div></fieldset>
    <div class="field" id="${prefix}-allow-f"><label for="${prefix}-allow">Allowed hosts</label>
      <textarea class="inp eg-list" id="${prefix}-allow" rows="5" spellcheck="false" autocomplete="off" placeholder="github.com&#10;*.githubusercontent.com&#10;registry.npmjs.org">${p.allow.join('\n')}</textarea>
      <span class="hint">One per line. <span class="mono">example.com</span> is that host only; <span class="mono">*.example.com</span> any subdomain of it. At most 200.</span></div>
    <div class="field" id="${prefix}-deny-f"><label for="${prefix}-deny">Blocked hosts</label>
      <textarea class="inp eg-list" id="${prefix}-deny" rows="4" spellcheck="false" autocomplete="off" placeholder="pastebin.com&#10;*.ngrok.io">${p.deny.join('\n')}</textarea>
      <span class="hint" id="${prefix}-deny-hint"></span></div>
    ${platformHostsMarkup(platformHosts)}`;
}

/** Shows the lists the chosen mode uses; call once after rendering the editor. */
export function bindEditor(root, prefix, onChange = () => {}) {
  const sync = () => {
    const mode = editorMode(root, prefix);
    $(`#${prefix}-allow-f`, root).hidden = mode !== 'allow';
    $(`#${prefix}-deny-f`, root).hidden = mode === 'open';
    $(`#${prefix}-deny-hint`, root).textContent = mode === 'allow'
      ? 'Carved out of the allowed hosts: blocking always wins. One per line, as above.'
      : 'One per line. example.com is that host only; *.example.com any subdomain of it. At most 200.';
    onChange();
  };
  for (const r of $$(`input[name="${prefix}-mode"]`, root)) r.addEventListener('change', sync);
  for (const t of [$(`#${prefix}-allow`, root), $(`#${prefix}-deny`, root)]) t.addEventListener('input', onChange);
  sync();
}

export const editorMode = (root, prefix) => $(`input[name="${prefix}-mode"]:checked`, root)?.value || 'open';

/** The policy the editor shows, with only the lists its mode uses. */
export function readEditor(root, prefix) {
  const mode = editorMode(root, prefix);
  return {
    mode,
    allow: mode === 'allow' ? parseHosts($(`#${prefix}-allow`, root).value) : [],
    deny: mode === 'open' ? [] : parseHosts($(`#${prefix}-deny`, root).value),
  };
}

/** Same policy, ignoring order and case (the server normalizes the rest). */
export function samePolicy(a, b) {
  if (!a || !b) return a === b;
  const norm = (l) => [...new Set(l.map((s) => s.toLowerCase().replace(/\.$/, '')))].sort().join(',');
  return a.mode === b.mode && norm(a.allow) === norm(b.allow) && norm(a.deny) === norm(b.deny);
}

/** Read-only view of a policy: its mode and lists. */
export function policyDetails(p) {
  if (!p) return '';
  const list = (label, items) => (items.length ? html`<div class="eg-ro"><span class="muted">${label}</span> <span class="mono">${items.join(', ')}</span></div>` : '');
  return html`${list('Allowed:', p.mode === 'allow' ? p.allow : [])}${list('Blocked:', p.mode === 'open' ? [] : p.deny)}`;
}
