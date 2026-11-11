// Shared prototype runtime: icons, escaping, a tiny view router, dialogs, toasts and the
// destructive-action flow every view uses (type the name -> passkey -> emailed link, D24/D30).
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.4 3.3-5.5 6.5-5.5s5.9 2.1 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c2 .7 3.2 2.5 3.5 5.2"/>',
  team: '<circle cx="12" cy="7" r="3"/><circle cx="5" cy="10" r="2.2"/><circle cx="19" cy="10" r="2.2"/><path d="M7 20c.4-3 2.4-5 5-5s4.6 2 5 5M1.5 19c.3-2 1.5-3.3 3.3-3.6M22.5 19c-.3-2-1.5-3.3-3.3-3.6"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6L12 3Z"/><path d="m9 12 2 2 4-4"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7.5V12l3 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4 4-6.5 8-6.5s7.2 2.5 8 6.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  loader: '<path d="M12 3a9 9 0 1 0 9 9"/>',
  arrowUp: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M17 6l3 3M14.5 8.5l2 2"/>',
  fingerprint: '<path d="M7 10.5a5 5 0 0 1 10 0v2.5M12 10.5v4.5c0 2.5-.8 4.6-2 6M9 21c-.6-1-1-2.6-1-4.5v-6M16.5 16.5c-.2 1.7-.6 3.1-1.2 4.3M4.5 16c-.3-1.3-.5-3.2-.5-5.5a8 8 0 0 1 14-5.3M20 9.5c.3 1 .5 2.1.5 3.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 7h.01M15 7h.01M9 11h.01M15 11h.01M9 15h.01M15 15h.01M10 21v-3h4v3"/>',
  ticket: '<path d="M3 8a2 2 0 0 0 0 4v0a2 2 0 0 1 0 4v2a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-2a2 2 0 0 1 0-4 2 2 0 0 0 0-4V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1Z"/><path d="M14 5v14" stroke-dasharray="2 2.5"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9Z"/><circle cx="8" cy="8" r="1.5"/>',
  crown: '<path d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7Z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H4"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  play: '<path d="m8 5 11 7-11 7V5Z"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>',
  question: '<path d="M9.2 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4.5M12 18h.01"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
};
const icon = (name, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const initials = (name) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

/** Status vocabulary shared by both prototypes: instance states as worca shows run states. */
const STATUS = {
  running:   { tone: 'green', icon: 'check',  label: 'Running',   line: 'Ready to open' },
  suspended: { tone: 'blue',  icon: 'moon',   label: 'Asleep',    line: 'Wakes in a few seconds when opened' },
  creating:  { tone: 'violet',icon: 'loader', label: 'Creating',  line: 'Setting up, about two minutes', spin: true },
  upgrading: { tone: 'violet',icon: 'arrowUp',label: 'Upgrading', line: 'Back in a minute' },
  stopped:   { tone: 'red',   icon: 'stop',   label: 'Stopped',   line: 'Stopped by the platform' },
  deleting:  { tone: 'slate', icon: 'trash',  label: 'Deleting',  line: 'Being removed' },
  degraded:  { tone: 'amber', icon: 'alert',  label: 'Degraded',  line: 'Running, but reports a problem' },
};
const glyph = (status, big) => {
  const s = STATUS[status];
  return `<span class="g ${s.tone}${big ? ' lg' : ''}${s.spin ? ' spin' : ''}" title="${s.label}">${icon(s.icon)}</span>`;
};
const statusPill = (status) => `<span class="pill ${STATUS[status].tone}">${STATUS[status].label}</span>`;

// ---- dialogs and toasts -------------------------------------------------------------------
function openModal(html, { wide = false, onMount } = {}) {
  closeModal();
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.id = 'scrim';
  scrim.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) closeModal(); });
  document.body.appendChild(scrim);
  const first = scrim.querySelector('input,select,textarea,button.primary,button');
  if (first) first.focus();
  if (onMount) onMount(scrim.firstElementChild);
  return scrim.firstElementChild;
}
function closeModal() { const s = $('#scrim'); if (s) s.remove(); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

let toastTimer;
function toast(text, ic = 'check') {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.innerHTML = `${icon(ic)}<span>${esc(text)}</span>`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function copyText(text, btn) {
  const done = () => toast('Copied');
  try { navigator.clipboard.writeText(text).then(done, () => toast('Select the text and copy it', 'info')); } catch { toast('Select the text and copy it', 'info'); }
}

/**
 * The destructive-action flow (D24, D30, D31):
 * 1. type the name; 2. passkey step unless the session already used one;
 * 3. "check your email"; 4. the emailed link opens a confirm page; 5. onConfirmed().
 */
function destructive({ title, what, name, consequence, actor, needsPasskey = true, onConfirmed, typed = true }) {
  const step1 = () => openModal(`
    <h2 class="danger">${esc(title)}</h2>
    <p>${consequence}</p>
    ${typed ? `<div class="field"><label for="d-name">Type <span class="code">${esc(name)}</span> to continue</label>
      <input class="inp" id="d-name" autocomplete="off" spellcheck="false"></div>` : ''}
    <div class="acts"><button class="btn" data-x>Cancel</button><button class="btn danger" id="d-go" ${typed ? 'disabled' : ''}>${esc(title)}</button></div>`,
    { onMount: (m) => {
      const inp = m.querySelector('#d-name'), go = m.querySelector('#d-go');
      if (inp) inp.addEventListener('input', () => { go.disabled = inp.value.trim() !== name; });
      m.querySelector('[data-x]').onclick = closeModal;
      go.onclick = () => (needsPasskey ? step2() : step3());
    } });
  const step2 = () => openModal(`
    <div class="center">${`<span class="g violet lg">${icon('fingerprint')}</span>`}
      <h2>Confirm with your passkey</h2>
      <p>${esc(what)} needs a passkey. Your current session signed in with an email code.</p></div>
    <div class="acts"><button class="btn" data-x>Cancel</button><button class="btn primary" id="pk">${icon('fingerprint')}Use passkey</button></div>`,
    { onMount: (m) => { m.querySelector('[data-x]').onclick = closeModal; m.querySelector('#pk').onclick = () => { m.querySelector('#pk').textContent = 'Waiting for your device…'; setTimeout(step3, 700); }; } });
  const step3 = () => openModal(`
    <div class="center"><span class="g amber lg">${icon('mail')}</span>
      <h2>Check your email</h2>
      <p>We sent a confirmation link to <b>${esc(actor)}</b>. Nothing changes until you open it and confirm. The link works once, for 30 minutes, and only for you.</p></div>
    <div class="mail"><div class="mh"><b>Confirm: ${esc(what)}</b><span>From worca &lt;no-reply@worca.example&gt; · to ${esc(actor)}</span></div>
      <div class="mb"><span>You asked to ${esc(what.toLowerCase())}: <b>${esc(name)}</b>. If this wasn't you, ignore this mail.</span>
      <div><button class="btn primary sm" id="open-link">${icon('ext')}Open the confirmation link</button></div>
      <span class="muted" style="font-size:12px">Prototype: this stands in for the mail in your inbox.</span></div></div>
    <div class="acts"><button class="btn" data-x>Close</button></div>`,
    { onMount: (m) => { m.querySelector('[data-x]').onclick = closeModal; m.querySelector('#open-link').onclick = step4; } });
  const step4 = () => openModal(`
    <div class="crumb" style="justify-content:center"><span class="mono">app.worca.dev/confirm/…</span></div>
    <div class="center"><span class="g red lg">${icon('alert')}</span>
      <h2>${esc(title)}?</h2>
      <p>${consequence}</p></div>
    <div class="acts" style="justify-content:center"><button class="btn" data-x>Keep it</button><button class="btn danger" id="final">${esc(title)}</button></div>`,
    { onMount: (m) => { m.querySelector('[data-x]').onclick = closeModal; m.querySelector('#final').onclick = () => { closeModal(); onConfirmed(); }; } });
  step1();
}

// ---- tiny charts ---------------------------------------------------------------------------
/** Stacked bars. series: [{ name, color, values[] }], labels: [] */
function stackedBars({ labels, series, height = 200, unit = '' }) {
  const W = 640, H = height, padL = 34, padB = 26, padT = 10;
  const totals = labels.map((_, i) => series.reduce((s, x) => s + x.values[i], 0));
  const max = Math.max(1, ...totals);
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / step) * step;
  const ticks = [0, top / 2, top];
  const cw = (W - padL) / labels.length, bw = Math.min(26, cw * 0.55);
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  let out = '';
  for (const t of ticks) out += `<line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line-2)" stroke-width="1"/><text x="${padL - 8}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="var(--ink-3)">${unit}${t}</text>`;
  labels.forEach((l, i) => {
    let acc = 0;
    const x = padL + cw * i + (cw - bw) / 2;
    series.forEach((s, si) => {
      const v = s.values[i];
      if (!v) return;
      const y1 = y(acc + v), y0 = y(acc);
      const isTop = series.slice(si + 1).every((n) => !n.values[i]);
      out += `<rect x="${x}" y="${y1}" width="${bw}" height="${Math.max(0, y0 - y1)}" fill="${s.color}" rx="${isTop ? 3 : 0}"/>`;
      acc += v;
    });
    if (i % Math.ceil(labels.length / 7) === 0) out += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--ink-3)">${l}</text>`;
  });
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img">${out}</svg></div>`;
}
function sparkline(values, { color = 'var(--blue)', height = 46 } = {}) {
  const W = 300, H = height, max = Math.max(...values, 1);
  const pts = values.map((v, i) => [i * (W / (values.length - 1)), H - 4 - (H - 10) * (v / max)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const last = pts[pts.length - 1];
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}"><path d="${d} L${W},${H} L0,${H}Z" fill="${color}" opacity=".12"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2"/><circle cx="${last[0]}" cy="${last[1]}" r="3.5" fill="${color}"/></svg></div>`;
}

// ---- router ----------------------------------------------------------------------------------
const app = { view: null, params: {}, render: null };
function go(view, params = {}) {
  app.view = view; app.params = params;
  app.render();
  const main = $('.main'); if (main) main.scrollTop = 0;
  window.scrollTo(0, 0);
  const sb = $('.sidebar'); if (sb) sb.classList.remove('open');
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-go]');
  if (!el) return;
  e.preventDefault();
  let params = {};
  try { params = el.dataset.p ? JSON.parse(el.dataset.p) : {}; } catch {}
  go(el.dataset.go, params);
});
const P = (o) => esc(JSON.stringify(o));
