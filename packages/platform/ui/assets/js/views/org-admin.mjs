// Org administration (tenant admins only): sign-in and security (login policy, verified domains,
// SSO connections), the audit log, and org settings (name, plan, data key, deleting the org).
// API: src/control/tenancy/{routes,policy-routes,domains,sso-routes}.ts, docs/internal-apis.md.
import {
  $, $$, api, ApiError, busy, closeModal, copyText, dateShort, dateTime, errorText, html, icon, loadMe, openModal, p,
  plural, protectedAction, relTime, setHtml, SIGN_IN_METHOD, toast, fieldError, clearFieldErrors, alertBox, showAlert, watchOp, features,
} from '../core.mjs';
import { repaintContext } from '../shell.mjs';
import { bindEditor, editorMarkup, EGRESS_NOTE, MODE_LABEL, readEditor, samePolicy, showEgressRefusal } from '../egress.mjs';

// ---- shared helpers --------------------------------------------------------------------------

const METHODS = [
  ['email-otp', 'Email code', 'A 6-digit code by email'],
  ['passkey', 'Passkey', 'Face, fingerprint or security key'],
  ['google', 'Google', 'Google accounts with a verified address'],
  ['microsoft', 'Microsoft', 'Personal and work Microsoft accounts'],
  ['sso', 'Your single sign-on', 'Your own identity provider, connected below'],
];
const methodNames = (list) => list.map((m) => SIGN_IN_METHOD[m] || m).join(', ');
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const normDomain = (s) => String(s || '').trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
const PROVIDER_ID_RE = /^sso-[a-z0-9-]{3,40}$/;
/** An http(s) URL; the server decides which hosts are allowed (https only, except a loopback IdP in local dev). */
const isUrl = (s) => { try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; } };

/** A value to copy: monospace text and a copy button (clicks are handled by bindCopy). */
const copyLine = (value, label) => html`<div class="oa-copy"><span class="mono">${value}</span><button type="button" class="btn ghost sm" data-copy="${value}" aria-label="Copy ${label}" title="Copy">${icon('copy')}</button></div>`;
function bindCopy(root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (b && root.contains(b)) copyText(b.dataset.copy);
  });
}

/** A plain yes/no question in a modal; resolves true when confirmed. */
function confirmModal({ title, body, action, danger = false, iconName }) {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal(html`
      ${iconName ? html`<div class="center"><span class="g ${danger ? 'red' : 'violet'} lg">${icon(iconName)}</span><h2>${title}</h2><p>${body}</p></div>` : html`<h2 class="${danger ? 'danger' : ''}">${title}</h2><p>${body}</p>`}
      <div class="acts"><button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cf-go">${action}</button></div>`,
    { onClose: () => { if (!answered) resolve(false); } });
    $('#cf-go', m).addEventListener('click', () => { answered = true; closeModal(); resolve(true); });
  });
}

const head = (title, sub, acts = '') => html`<div class="head"><div><h1>${title}</h1>${sub ? html`<p>${sub}</p>` : ''}</div>${acts ? html`<div class="acts">${acts}</div>` : ''}</div>`;

// ---- Sign-in and security ---------------------------------------------------------------------

const DOMAIN_ERRORS = {
  domain_exists: 'This domain is already on the list.',
  domain_taken: 'Another org has already verified this domain. Each domain belongs to one org.',
  txt_record_not_found: "We didn't find the TXT record yet. DNS changes can take up to an hour to show up; check again later.",
  domain_in_use_by_sso: 'An SSO connection uses this domain. Remove that connection first.',
  domain_in_use_by_policy: 'The login policy requires addresses at this domain. Change the policy first.',
  invalid_body: "That doesn't look like a domain name, for example acme.com.",
};
const SSO_ERRORS = {
  domain_not_verified: 'That domain is not verified yet. Verify it first, then connect SSO.',
  provider_id_taken: 'That connection id is already in use. Pick another one, or leave it empty.',
  sso_provider_limit: "You've reached the number of SSO connections you can add. Remove one first, or contact Worca support.",
  idp_url_not_allowed: "One of the addresses isn't allowed. Use your identity provider's own public https addresses.",
  idp_url_off_issuer: 'Every endpoint must be on the same site as the issuer.',
  endpoints_required: 'Without discovery, enter the authorization, token and JWKS endpoints.',
  discovery_failed: "We couldn't read your provider's discovery document.",
  issuer_mismatch: "The issuer doesn't match the one your provider names in its metadata.",
  entity_id_required: "Enter your provider's entity id (or paste its metadata XML).",
  sso_url_required: "Enter your provider's sign-on URL (HTTP-Redirect binding), or paste its metadata XML.",
  cert_required: "Paste your provider's signing certificate, or its metadata XML.",
  invalid_certificate: "The signing certificate isn't a valid PEM certificate.",
  invalid_idp_config: 'Your identity provider settings were refused.',
  invalid_body: 'Some fields are not valid. Check the addresses and the required fields.',
  provider_id_reserved: 'This connection was set up before connection ids were checked, so only Worca support can remove it. Contact support.',
  not_found: 'This connection no longer exists.',
};
const DISCOVERY_REASON = {
  discovery_not_found: 'No discovery document at that address.',
  discovery_timeout: 'The provider took too long to answer.',
  discovery_incomplete: 'The discovery document is missing required fields.',
  oidc_endpoint_redirect: 'An endpoint redirects elsewhere.',
  unsupported_token_auth_method: 'The provider offers no supported client authentication (client secret basic or post).',
};
/** Plain message for a refused registration, with the server's reason and detail when present. */
function ssoErrorText(e) {
  if (!(e instanceof ApiError)) return errorText(e);
  const base = SSO_ERRORS[e.code] || (e.status === 400 ? SSO_ERRORS.invalid_idp_config : errorText(e));
  const reason = e.body?.reason && DISCOVERY_REASON[e.body.reason];
  const detail = typeof e.body?.detail === 'string' && e.body.detail.trim() ? e.body.detail.trim() : '';
  return [base, reason, detail].filter(Boolean).join(' ');
}
const POLICY_ERRORS = {
  invalid_body: "The required domain doesn't look like a domain name, for example acme.com.",
  confirm_name_mismatch: "The name didn't match. Nothing was changed.",
};
const textFor = (table, e) => (e instanceof ApiError && table[e.code]) || errorText(e);

async function renderSecurity(ctx) {
  const base = p`/api/orgs/${ctx.orgId}`;
  const [policy, { domains }, { providers }, { instances }, egress] = await Promise.all([
    api.get(`${base}/policy`),
    api.get(`${base}/domains`),
    api.get(`${base}/sso`),
    api.get(`${base}/instances`).catch(() => ({ instances: [] })),
    api.get(`${base}/egress`).catch(() => null),
  ]);
  if (!ctx.alive()) return;
  const orgName = ctx.org.name || 'this org';
  const allowed = policy.allowedMethods || [];
  const isOn = (m) => allowed.length === 0 || allowed.includes(m);
  const verified = domains.filter((d) => d.verifiedAt);
  const activeSso = providers.filter((s) => s.status === 'active');
  const instName = new Map(instances.map((i) => [i.id, i.name]));
  const overrides = (policy.instanceOverrides || []).filter((o) => instName.has(o.instanceId));
  const ssoLine = activeSso.length ? `Through ${activeSso.map((s) => s.domain || s.providerId).join(', ')}` : 'Needs an active SSO connection, below';

  ctx.set(html`<div class="page narrow">
    ${head('Sign-in and security', `How people in ${orgName} sign in. An instance can ask for more, never less.`)}

    <section class="card stack" aria-labelledby="pol-h">
      <div class="card-head oa-flush"><h2 id="pol-h">Allowed sign-in methods</h2><span class="sub">Org default</span></div>
      <div class="field"><div class="rows">${METHODS.map(([k, label, desc]) => html`
        <label class="row oa-click" for="m-${k}"><div class="t"><b>${label}</b><span>${k === 'sso' ? ssoLine : desc}</span></div>
          <div class="r"><span class="switch"><input type="checkbox" id="m-${k}" data-method="${k}" ${isOn(k) ? 'checked' : ''}><i></i></span></div></label>`)}
      </div></div>
      <div class="field"><label for="pol-domain">Only addresses at <span class="opt">optional</span></label>
        <input class="inp mono" id="pol-domain" list="pol-domains" placeholder="Any address" autocomplete="off" spellcheck="false" value="${policy.requiredDomain || ''}">
        <datalist id="pol-domains">${verified.map((d) => html`<option value="${d.domain}">`)}</datalist>
        <span class="hint">Leave empty to allow any address. A change that would shut members out lists them first, and asks for the org name, your passkey and a confirmation by email.</span></div>
      ${alertBox('pol-err')}
      ${overrides.length ? html`<div><div class="label">Instances with a stricter rule</div>
        <div class="rows">${overrides.map((o) => html`<a class="row click" href="/o/${encodeURIComponent(ctx.orgId)}/instances/${encodeURIComponent(o.instanceId)}">${icon('server')}<div class="t"><b>${instName.get(o.instanceId)}</b><span>Requires ${methodNames(o.requiredMethods)}</span></div><div class="r">${icon('chev')}</div></a>`)}</div></div>` : ''}
      <div class="flex oa-end"><button class="btn primary" id="save-policy">Save policy</button></div>
    </section>

    <section class="card" aria-labelledby="dom-h">
      <div class="card-head"><h2 id="dom-h">Verified domains</h2><button class="btn sm" id="add-domain">${icon('plus')}Add domain</button></div>
      ${domains.length ? html`<div class="rows">${domains.map((d) => domainRow(d))}</div>`
        : html`<div class="empty">No domains yet. Verify the domain of your work addresses to connect single sign-on.</div>`}
    </section>

    <section class="card" aria-labelledby="sso-h">
      <div class="card-head"><h2 id="sso-h">Single sign-on</h2><button class="btn sm" id="add-sso" ${verified.length ? '' : 'disabled'}>${icon('plus')}Connect SSO</button></div>
      ${providers.length ? html`<div class="stack">${providers.map((s) => ssoBlock(s))}</div>`
        : html`<div class="empty">${verified.length ? 'No SSO connection yet. Connect your identity provider (Entra ID, Okta, Google Workspace…) with OIDC or SAML.' : 'No SSO connection yet. Verify a domain first, then connect your identity provider with OIDC or SAML.'}</div>`}
    </section>

    ${egress ? html`<section class="card stack" id="egress-card" aria-labelledby="eg-h"></section>` : ''}
  </div>`);

  const el = ctx.el;
  bindCopy(el);
  if (egress) renderEgress(ctx, base, egress, instName);

  $('#save-policy', el).addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const errEl = $('#pol-err', el);
    const domInp = $('#pol-domain', el);
    showAlert(errEl, '');
    clearFieldErrors(el);
    const on = $$('[data-method]', el).filter((i) => i.checked).map((i) => i.dataset.method);
    if (on.length === 0) { fieldError($$('[data-method]', el), 'Allow at least one way to sign in.'); return false; }
    const dom = normDomain(domInp.value);
    if (dom && !DOMAIN_RE.test(dom)) { fieldError(domInp, POLICY_ERRORS.invalid_body); return false; }
    const body = { allowedMethods: on.length === METHODS.length ? [] : on, requiredDomain: dom || null };
    try {
      const res = await protectedAction({
        title: 'Change the login policy',
        consequence: html`These members could no longer sign in, or would be signed out. Type the org name to go on; we then email you a link to confirm.`,
        name: orgName,
        nameLabel: 'the org name',
        typed: false,
        actionLabel: 'Continue',
        call: (confirmName) => api.raw('PUT', `${base}/policy`, confirmName === undefined ? body : { ...body, confirmName }),
      });
      // Saved: the button says so and the page already shows the new state. 202: the email modal says it.
      if (res && res.status === 200) { domInp.value = dom; return true; }
      return false;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_body') fieldError(domInp, POLICY_ERRORS.invalid_body);
      else showAlert(errEl, textFor(POLICY_ERRORS, err));
      return false;
    }
  }, { done: 'Saved' }));

  $('#add-domain', el).addEventListener('click', () => addDomain(ctx, base));
  for (const b of $$('[data-verify]', el)) b.addEventListener('click', (e) => busy(e.currentTarget, () => verifyDomain(ctx, base, b.dataset.verify)));
  for (const b of $$('[data-rm-domain]', el)) {
    b.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const ok = await confirmModal({ title: 'Remove this domain?', body: html`${b.dataset.name} is no longer verified for ${orgName}. You can add it again later, with a new TXT record.`, action: 'Remove domain', danger: true });
      if (!ok) return;
      await busy(btn, async () => {
        try {
          await api.del(`${base}${p`/domains/${b.dataset.rmDomain}`}`);
          toast('Domain removed');
          ctx.refresh();
        } catch (err) {
          toast(textFor(DOMAIN_ERRORS, err), 'error');
        }
      });
    });
  }
  $('#add-sso', el).addEventListener('click', () => connectSso(ctx, base, verified));
  for (const b of $$('[data-rm-sso]', el)) {
    b.addEventListener('click', (e) => removeSso(ctx, base, providers.find((s) => s.id === b.dataset.rmSso), e.currentTarget));
  }
}

// ---- Outbound network (D73) -------------------------------------------------------------------

const EGRESS_CHANGED = 'Someone changed this policy meanwhile. This is the current one; check it and save again.';

/**
 * The org's outbound network policy: what Worca's agents may reach. Saving restarts Worca on the
 * running instances that follow it (asked first); loosening asks for a passkey (protectedAction
 * steps up on mfa_required). Re-renders itself with the current policy after a concurrent change.
 */
function renderEgress(ctx, base, data, instName, { alert = '' } = {}) {
  const card = $('#egress-card', ctx.el);
  if (!card) return;
  const n = data.instances || { inheriting: 0, inheritingRunning: 0, overriding: 0 };
  const overrides = (data.overrides || []).filter((o) => instName.has(o.instanceId));
  let saved = data.policy;
  let version = data.version;
  setHtml(card, html`
    <div class="card-head oa-flush"><h2 id="eg-h">Outbound network</h2><span class="sub">Org default</span></div>
    <p class="ink2">What Worca's agents may reach on the internet. An instance can have its own policy instead.</p>
    <div class="banner blue" id="eg-note">${icon('info')}<div class="grow">${EGRESS_NOTE}</div></div>
    ${editorMarkup('eg', saved, data.platformHosts)}
    <p class="hint" id="eg-count">${plural(n.inheriting, 'instance follows', 'instances follow')} this policy${n.overriding ? html`; ${plural(n.overriding, 'has its own', 'have their own')}` : ''}.</p>
    ${overrides.length ? html`<div><div class="label">Instances with their own policy</div>
      <div class="rows">${overrides.map((o) => html`<a class="row click" href="/o/${encodeURIComponent(ctx.orgId)}/instances/${encodeURIComponent(o.instanceId)}">${icon('server')}<div class="t"><b>${instName.get(o.instanceId)}</b><span>${MODE_LABEL[o.mode] || o.mode}</span></div><div class="r">${icon('chev')}</div></a>`)}</div></div>` : ''}
    ${alertBox('eg-err')}
    <div class="flex oa-end"><button class="btn primary" id="eg-save">Save policy</button></div>`);
  const save = $('#eg-save', card);
  const unchanged = () => samePolicy(readEditor(card, 'eg'), saved);
  bindEditor(card, 'eg', () => { if (save.dataset.fbState !== 'busy' && save.dataset.fbState !== 'done') save.disabled = unchanged(); });
  showAlert($('#eg-err', card), alert);

  save.addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const errEl = $('#eg-err', card);
    showAlert(errEl, '');
    clearFieldErrors(card);
    const next = readEditor(card, 'eg');
    const running = n.inheritingRunning || 0;
    if (running > 0) {
      const ok = await confirmModal({
        title: 'Save and restart Worca?',
        body: html`${plural(running, 'running instance', 'running instances')} that ${running === 1 ? 'follows' : 'follow'} this policy will restart Worca to apply it. Active runs pause and resume.`,
        action: 'Save and restart',
      });
      if (!ok) return false;
    }
    let res;
    try {
      res = await protectedAction({
        title: 'Change the outbound network policy', typed: false, danger: false,
        call: () => api.raw('PUT', `${base}/egress`, { policy: next, version }),
      });
    } catch (err) {
      if (showEgressRefusal(card, 'eg', err)) return false;
      if (err instanceof ApiError && err.code === 'egress_changed') {
        const fresh = await api.get(`${base}/egress`).catch(() => null);
        if (fresh && ctx.alive()) renderEgress(ctx, base, fresh, instName, { alert: EGRESS_CHANGED });
        return false;
      }
      showAlert(errEl, errorText(err));
      return false;
    }
    if (!res) return false; // the passkey step was cancelled
    const out = res.body || {};
    saved = out.policy || next;
    version = out.version ?? version;
    for (const id of out.applyingIds || []) {
      const name = instName.get(id) || 'an instance';
      watchOp({ url: p`/api/orgs/${ctx.orgId}/instances/${id}`, href: p`/o/${ctx.orgId}/instances/${id}`, kind: 'reconfigure', ok: `The outbound network policy is applied on ${name}`, fail: `The outbound network policy couldn't be applied on ${name}` });
    }
    if (out.applying) toast(`Saved; Worca is restarting on ${plural(out.applying, 'instance')}`, 'info');
    else if (out.pending) toast(`Saved; ${plural(out.pending, 'instance gets', 'instances get')} it when ${out.pending === 1 ? 'it next starts' : 'they next start'}`, 'info');
    return true;
  }, { done: 'Saved', idleDisabled: unchanged }));
  save.disabled = unchanged();
}

function domainRow(d) {
  if (d.verifiedAt) {
    return html`<div class="row"><span class="g green">${icon('check')}</span>
      <div class="t"><b class="mono oa-dom">${d.domain}</b><span>Verified ${dateShort(d.verifiedAt)} with a DNS TXT record</span></div>
      <div class="r"><span class="pill green">Verified</span><button class="btn ghost sm" data-rm-domain="${d.id}" data-name="${d.domain}" aria-label="Remove ${d.domain}" title="Remove">${icon('trash')}</button></div></div>`;
  }
  return html`<div class="row oa-pending"><span class="g amber">${icon('question')}</span>
    <div class="t"><b class="mono oa-dom">${d.domain}</b><span>Add this TXT record at your DNS provider, then check.</span>
      <dl class="kv oa-txt"><dt>Name</dt><dd>${copyLine(d.txtName, 'record name')}</dd><dt>Value</dt><dd>${copyLine(d.txtValue, 'record value')}</dd></dl></div>
    <div class="r oa-domacts"><button class="btn sm" data-verify="${d.id}">${icon('refresh')}Check now</button><button class="btn ghost sm" data-rm-domain="${d.id}" data-name="${d.domain}" aria-label="Remove ${d.domain}" title="Remove">${icon('trash')}</button></div></div>`;
}

async function verifyDomain(ctx, base, id) {
  try {
    await api.post(`${base}${p`/domains/${id}/verify`}`);
    toast('Domain verified');
    ctx.refresh();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'txt_record_not_found') {
      openModal(html`<div class="center"><span class="g amber lg">${icon('question')}</span><h2>Record not found yet</h2>
        <p>${DOMAIN_ERRORS.txt_record_not_found}</p></div><div class="acts"><button class="btn primary" data-close>OK</button></div>`);
      return;
    }
    toast(textFor(DOMAIN_ERRORS, err), 'error');
  }
}

function addDomain(ctx, base) {
  const m = openModal(html`<h2>Add a domain</h2>
    <p>Prove that ${ctx.org.name || 'your org'} owns a domain by adding a DNS TXT record. You need a verified domain to connect single sign-on.</p>
    <form class="form" id="dom-form" novalidate>
      <div class="field"><label for="dom-name">Domain</label><input class="inp mono" id="dom-name" placeholder="acme.com" autocomplete="off" spellcheck="false" required></div>
      ${alertBox('dom-err')}
      <div class="acts"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" id="dom-go" type="submit">Add domain</button></div>
    </form>`);
  $('#dom-form', m).addEventListener('submit', (e) => {
    e.preventDefault();
    const errEl = $('#dom-err', m);
    const inp = $('#dom-name', m);
    showAlert(errEl, '');
    const domain = normDomain(inp.value);
    if (!DOMAIN_RE.test(domain)) return void fieldError(inp, DOMAIN_ERRORS.invalid_body);
    busy($('#dom-go', m), async () => {
      try {
        const d = await api.post(`${base}/domains`, { domain });
        showTxt(ctx, base, d);
      } catch (err) {
        if (err instanceof ApiError && ['invalid_body', 'domain_exists', 'domain_taken'].includes(err.code)) return void fieldError(inp, DOMAIN_ERRORS[err.code]);
        showAlert(errEl, textFor(DOMAIN_ERRORS, err));
      }
    });
  });
}

function showTxt(ctx, base, d) {
  const m = openModal(html`<h2>Add this TXT record</h2>
    <p>At the DNS provider of <b class="mono">${d.domain}</b>, create a TXT record with this name and value. Then check: DNS changes can take up to an hour to show up.</p>
    <dl class="kv oa-txt"><dt>Type</dt><dd class="mono">TXT</dd><dt>Name</dt><dd>${copyLine(d.txtName, 'record name')}</dd><dt>Value</dt><dd>${copyLine(d.txtValue, 'record value')}</dd></dl>
    ${alertBox('txt-err')}
    <div class="acts"><button class="btn" data-close>Check later</button><button class="btn primary" id="txt-go">${icon('refresh')}Check now</button></div>`,
  { wide: true, onClose: () => ctx.refresh() });
  bindCopy(m);
  $('#txt-go', m).addEventListener('click', (e) => busy(e.currentTarget, async () => {
    try {
      await api.post(`${base}${p`/domains/${d.id}/verify`}`);
      toast('Domain verified');
      closeModal();
    } catch (err) {
      showAlert($('#txt-err', m), textFor(DOMAIN_ERRORS, err));
    }
  }));
}

function ssoBlock(s) {
  const active = s.status === 'active';
  return html`<div class="oa-sso" data-sso="${s.providerId}">
    <div class="between"><div class="flex"><span class="g ${active ? 'green' : 'amber'}">${icon(active ? 'check' : 'alert')}</span>
      <div class="oa-sso-t"><b>${s.domain ? `@${s.domain}` : s.providerId}</b><span>${(s.type || '').toUpperCase() || 'SSO'} · added ${s.createdAt ? dateShort(s.createdAt) : 'earlier'}</span></div></div>
      <div class="flex">${active ? html`<span class="pill green">Active</span>` : html`<span class="pill amber">Domain not verified</span>`}
        <button class="btn ghost sm" data-rm-sso="${s.id}" aria-label="Remove ${s.providerId}">${icon('trash')}Remove</button></div></div>
    ${active ? '' : html`<div class="banner amber">${icon('alert')}<div class="grow">Nobody signs in through this connection until <b>${s.domain || 'its domain'}</b> is verified again.</div></div>`}
    <dl class="kv"><dt>Connection id</dt><dd class="mono">${s.providerId}</dd>
      <dt>Protocol</dt><dd>${s.type === 'saml' ? 'SAML 2.0' : s.type === 'oidc' ? 'OpenID Connect' : '—'}</dd>
      <dt>Issuer</dt><dd class="mono">${s.issuer}</dd>
      <dt>For addresses</dt><dd class="mono">${s.domain ? `@${s.domain}` : '—'}</dd>
      <dt>${s.type === 'saml' ? 'Reply URL (ACS)' : 'Redirect URL'}</dt><dd>${copyLine(s.redirectUrl, s.type === 'saml' ? 'reply URL' : 'redirect URL')}</dd>
      ${s.metadataUrl ? html`<dt>SP metadata</dt><dd>${copyLine(s.metadataUrl, 'metadata URL')}</dd>` : ''}</dl>
  </div>`;
}

function connectSso(ctx, base, verified) {
  let type = 'oidc';
  const field = (id, label, opts = {}) => html`<div class="field"><label for="${id}">${label}${opts.opt ? html` <span class="opt">optional</span>` : ''}</label>
    ${opts.area ? html`<textarea class="inp mono oa-cert" id="${id}" rows="${opts.rows || 5}" placeholder="${opts.ph || ''}" spellcheck="false"></textarea>`
      : html`<input class="inp mono" id="${id}" type="${opts.type || 'text'}" placeholder="${opts.ph || ''}" autocomplete="${opts.type === 'password' ? 'new-password' : 'off'}" spellcheck="false">`}
    ${opts.hint ? html`<span class="hint">${opts.hint}</span>` : ''}</div>`;
  const m = openModal(html`<h2>Connect single sign-on</h2>
    <p>People with an address at the domain sign in through your identity provider. Secrets and certificates are stored encrypted and never shown again.</p>
    <form class="form" id="sso-form" novalidate>
      <div class="seg" role="group" aria-label="Protocol"><button type="button" class="on" data-type="oidc" aria-pressed="true">OpenID Connect</button><button type="button" data-type="saml" aria-pressed="false">SAML 2.0</button></div>
      <div class="field"><label for="sso-dom">Domain</label><select class="inp" id="sso-dom">${verified.map((d) => html`<option value="${d.id}">@${d.domain}</option>`)}</select></div>
      <div class="oa-oidc stack">
        ${field('sso-issuer', 'Issuer URL', { ph: 'https://login.microsoftonline.com/…/v2.0', hint: 'The https address your identity provider names as its issuer. We read its discovery document once, now.' })}
        <div class="grid g2">${field('sso-cid', 'Client id')}${field('sso-secret', 'Client secret', { type: 'password' })}</div>
        ${field('sso-disc', 'Discovery URL', { opt: true, ph: 'Issuer URL + /.well-known/openid-configuration', hint: 'Only if your provider publishes it somewhere else.' })}
        <label class="check"><input type="checkbox" id="sso-manual"><span class="t"><b>Enter the endpoints by hand</b><span>For a provider without a discovery document; nothing is fetched</span></span></label>
        <div class="stack" id="sso-endpoints" hidden>
          ${field('sso-auth', 'Authorization endpoint')}${field('sso-token', 'Token endpoint')}${field('sso-jwks', 'JWKS endpoint')}
          ${field('sso-ui', 'User info endpoint', { opt: true })}
          <span class="hint">All on the same site as the issuer.</span>
        </div>
        <details class="oa-more"><summary>Scopes, client authentication and PKCE</summary><div class="stack">
          ${field('sso-scopes', 'Scopes', { opt: true, ph: 'openid email profile' })}
          <div class="field"><label for="sso-tea">Client authentication</label><select class="inp" id="sso-tea"><option value="">What the provider offers</option><option value="client_secret_basic">Client secret, basic</option><option value="client_secret_post">Client secret, post</option></select></div>
          <label class="check"><input type="checkbox" id="sso-pkce" checked><span class="t"><b>Use PKCE</b><span>Recommended; turn off only if your provider refuses it</span></span></label>
        </div></details>
      </div>
      <div class="oa-saml stack" hidden>
        <div class="seg" role="group" aria-label="How to enter the provider"><button type="button" class="on" data-saml="xml" aria-pressed="true">Paste metadata XML</button><button type="button" data-saml="manual" aria-pressed="false">Enter by hand</button></div>
        <div class="stack" id="saml-xml">
          ${field('sso-meta', 'IdP metadata XML', { area: true, rows: 7, ph: '<EntityDescriptor …>', hint: 'From your identity provider: the entity id, sign-on URL and certificate are read from it.' })}
        </div>
        <div class="stack" id="saml-manual" hidden>
          ${field('sso-entity', 'Entity id (issuer)', { ph: 'https://sts.windows.net/…/', hint: 'A URI naming your provider; it is never fetched.' })}
          ${field('sso-entry', 'Sign-on URL (HTTP-Redirect)', { ph: 'https://idp.example.com/saml/sso' })}
          ${field('sso-cert', 'Signing certificate', { area: true, ph: '-----BEGIN CERTIFICATE-----' })}
        </div>
        <details class="oa-more"><summary>Audience and name id format</summary><div class="stack">
          ${field('sso-aud', 'Audience', { opt: true, hint: 'Leave empty: the service provider metadata URL is the audience.' })}
          ${field('sso-nid', 'Name id format', { opt: true, ph: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' })}
          <label class="check"><input type="checkbox" id="sso-signed"><span class="t"><b>Require signed assertions</b><span>Refuse responses whose assertions aren't signed</span></span></label>
        </div></details>
      </div>
      ${field('sso-pid', 'Connection id', { opt: true, ph: 'sso-acme', hint: 'Part of the URLs you enter at your provider. Starts with sso-, then 3 to 40 lowercase letters, digits or dashes. Left empty, we pick one.' })}
      ${alertBox('sso-err')}
      <div class="acts"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" id="sso-go" type="submit">Connect</button></div>
    </form>`, { wide: true });
  const val = (id) => $(id, m).value.trim();
  let samlMode = 'xml';
  const segPick = (attr, b) => { for (const x of $$(`[${attr}]`, m)) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); } };
  for (const b of $$('[data-type]', m)) {
    b.addEventListener('click', () => {
      type = b.dataset.type;
      segPick('data-type', b);
      $('.oa-oidc', m).hidden = type !== 'oidc';
      $('.oa-saml', m).hidden = type !== 'saml';
      showAlert($('#sso-err', m), '');
      clearFieldErrors(m);
    });
  }
  for (const b of $$('[data-saml]', m)) {
    b.addEventListener('click', () => {
      samlMode = b.dataset.saml;
      segPick('data-saml', b);
      $('#saml-xml', m).hidden = samlMode !== 'xml';
      $('#saml-manual', m).hidden = samlMode !== 'manual';
    });
  }
  $('#sso-manual', m).addEventListener('change', (e) => { $('#sso-endpoints', m).hidden = !e.target.checked; });

  /** Builds the POST body, or returns { bad: the field(s), text: the problem }. */
  const bad = (sel, text) => ({ bad: [].concat(sel).map((x) => $(x, m)), text });
  const build = () => {
    const providerId = val('#sso-pid').toLowerCase();
    if (providerId && !PROVIDER_ID_RE.test(providerId)) return bad('#sso-pid', 'The connection id starts with sso-, then 3 to 40 lowercase letters, digits or dashes.');
    const common = { domainId: $('#sso-dom', m).value, ...(providerId ? { providerId } : {}) };
    if (type === 'oidc') {
      const issuer = val('#sso-issuer');
      if (!isUrl(issuer)) return bad('#sso-issuer', 'Enter the issuer URL, starting with https://.');
      const config = { clientId: val('#sso-cid'), clientSecret: $('#sso-secret', m).value };
      if (!config.clientId || !config.clientSecret) return bad([!config.clientId && '#sso-cid', !config.clientSecret && '#sso-secret'].filter(Boolean), 'Enter the client id and the client secret.');
      const disc = val('#sso-disc');
      if (disc && !isUrl(disc)) return bad('#sso-disc', 'The discovery URL must be an https address.');
      if (disc) config.discoveryEndpoint = disc;
      if ($('#sso-manual', m).checked) {
        config.skipDiscovery = true;
        const eps = { authorizationEndpoint: '#sso-auth', tokenEndpoint: '#sso-token', jwksEndpoint: '#sso-jwks', userInfoEndpoint: '#sso-ui' };
        for (const [k, sel] of Object.entries(eps)) {
          const v = val(sel);
          if (!v) { if (k !== 'userInfoEndpoint') return bad(sel, SSO_ERRORS.endpoints_required); continue; }
          if (!isUrl(v)) return bad(sel, 'Every endpoint must be an https address.');
          config[k] = v;
        }
      }
      const scopes = val('#sso-scopes').split(/[\s,]+/).filter(Boolean);
      if (scopes.length) config.scopes = scopes;
      if (val('#sso-tea')) config.tokenEndpointAuthentication = val('#sso-tea');
      if (!$('#sso-pkce', m).checked) config.pkce = false;
      return { type, issuer, config, ...common };
    }
    const config = {};
    let issuer;
    if (samlMode === 'xml') {
      const xml = val('#sso-meta');
      if (!xml) return bad('#sso-meta', "Paste your provider's metadata XML, or enter its details by hand.");
      if (!/<(\w+:)?EntityDescriptor[\s>]/.test(xml)) return bad('#sso-meta', "That doesn't look like SAML metadata: it should contain an EntityDescriptor.");
      config.idpMetadata = { metadata: xml };
    } else {
      issuer = val('#sso-entity');
      if (!issuer) return bad('#sso-entity', SSO_ERRORS.entity_id_required);
      const entry = val('#sso-entry');
      if (!isUrl(entry)) return bad('#sso-entry', 'Enter the sign-on URL, starting with https://.');
      const cert = val('#sso-cert');
      if (!cert) return bad('#sso-cert', SSO_ERRORS.cert_required);
      if (!/-----BEGIN CERTIFICATE-----/.test(cert) && !/^[A-Za-z0-9+/=\s]+$/.test(cert)) return bad('#sso-cert', SSO_ERRORS.invalid_certificate);
      config.entryPoint = entry;
      config.cert = cert;
    }
    if (val('#sso-aud')) config.audience = val('#sso-aud');
    if (val('#sso-nid')) config.identifierFormat = val('#sso-nid');
    if ($('#sso-signed', m).checked) config.wantAssertionsSigned = true;
    return { type, ...(issuer ? { issuer } : {}), config, ...common };
  };

  $('#sso-form', m).addEventListener('submit', (e) => {
    e.preventDefault();
    const errEl = $('#sso-err', m);
    showAlert(errEl, '');
    clearFieldErrors(m);
    const body = build();
    if (body.bad) return void fieldError(body.bad, body.text);
    busy($('#sso-go', m), async () => {
      try {
        const res = await api.post(`${base}/sso`, body);
        showSsoUrls(ctx, body.type, res);
      } catch (err) {
        const at = err instanceof ApiError && { provider_id_taken: '#sso-pid', domain_not_verified: '#sso-dom' }[err.code];
        if (at) return void fieldError($(at, m), ssoErrorText(err));
        showAlert(errEl, ssoErrorText(err));
      }
    });
  });
}

function showSsoUrls(ctx, type, res) {
  const m = openModal(html`<div class="center"><span class="g green lg">${icon('check')}</span><h2>SSO connected</h2>
      <p>Enter ${type === 'saml' ? 'these addresses' : 'this address'} at your identity provider to finish the setup.</p></div>
    <dl class="kv"><dt>Connection id</dt><dd class="mono">${res.providerId}</dd>
      <dt>${type === 'saml' ? 'Reply URL (ACS)' : 'Redirect URL'}</dt><dd>${copyLine(res.redirectUrl, 'redirect URL')}</dd>
      ${res.metadataUrl ? html`<dt>SP entity id and metadata</dt><dd>${copyLine(res.metadataUrl, 'metadata URL')}</dd>` : ''}</dl>
    ${type === 'saml' ? html`<p class="hint">The metadata URL is also our entity id and the audience your provider must send.</p>` : ''}
    <div class="acts"><button class="btn primary" data-close>Done</button></div>`, { wide: true, onClose: () => ctx.refresh() });
  bindCopy(m);
}

async function removeSso(ctx, base, s, btn) {
  if (!s) return;
  const ok = await confirmModal({
    title: 'Remove this SSO connection?',
    body: html`People at <b>${s.domain ? `@${s.domain}` : s.providerId}</b> can no longer sign in through it, and every SSO session of the org ends, so people sign in again.`,
    action: 'Remove connection',
    danger: true,
  });
  if (!ok) return;
  await busy(btn, async () => {
    try {
      const res = await protectedAction({
        title: 'Remove SSO connection',
        consequence: html`Removing <b>${s.providerId}</b> takes away a way in. Type the connection id to go on; we then email you a link to confirm.`,
        name: s.providerId,
        nameLabel: 'the connection id',
        typed: false,
        actionLabel: 'Continue',
        call: (confirmName) => api.raw('DELETE', `${base}${p`/sso/${s.id}`}`, confirmName === undefined ? undefined : { confirmName }),
      });
      if (res && res.status === 200) {
        toast('SSO connection removed');
        ctx.refresh();
      }
    } catch (err) {
      toast(ssoErrorText(err), 'error');
    }
  });
}

// ---- Audit log -------------------------------------------------------------------------------

const CATEGORIES = [['', 'Everything'], ['instances', 'Instances'], ['members', 'Members'], ['security', 'Security'], ['settings', 'Settings']];
const ROLE = { tenant_admin: 'tenant admin', tenant_user: 'tenant user' };
const CONFIRM_LABEL = {
  'org.delete': 'delete the org', 'org.policy.update': 'change the login policy', 'instance.policy.update': "change an instance's login policy",
  'org.sso.delete': 'remove an SSO connection', 'instance.delete': 'delete an instance',
};
/** "Only allowed hosts (github.com, …; blocked: …)", for the audit log. */
const egressSay = (p) => {
  if (!p || !p.mode) return 'the org policy';
  const lists = [p.mode === 'allow' && p.allow?.length ? p.allow.join(', ') : '', p.mode !== 'open' && p.deny?.length ? `blocked: ${p.deny.join(', ')}` : ''].filter(Boolean);
  return `${MODE_LABEL[p.mode] || p.mode}${lists.length ? ` (${lists.join('; ')})` : ''}`;
};
const methodsText = (list) => (list && list.length ? methodNames(list) : 'every method');

const SIZE_LABEL = { standard: 'Standard', large: 'Large', xl: 'XL' };
/** Plain-language text of an entry; `n` resolves ids to names. Keys follow AuditAction (tenancy/audit.ts). */
const ACTIONS = {
  'org.created': (d) => `Created the org${d.name ? ` "${d.name}"` : ''}`,
  'org.renamed': (d) => `Renamed the org to "${d.name}"`,
  'org.deleted': () => 'Deleted the org',
  'org.tier_changed': (d) => `Changed the plan${d.to ? ` to ${d.to}` : d.tier ? ` to ${d.tier}` : ''}`,
  'org.key_rotated': (d) => `Rotated the org data key${d.version ? ` (version ${d.version})` : ''}`,
  'org.policy_updated': (d) => `Changed the login policy: ${methodsText(d.allowedMethods)}${d.requiredDomain ? `, only @${d.requiredDomain}` : ''}`,
  'org.audit_viewed': () => 'Viewed the audit log',
  'org.egress_updated': (d) => `Changed the outbound network policy${d.from ? ` from ${egressSay(d.from)}` : ''}${d.to ? ` to ${egressSay(d.to)}` : ''}`,
  'member.role_changed': (d, e, n) => `Made ${n.user(e.targetId)} ${ROLE[d.to] || d.to}`,
  'member.removed': (d, e, n) => `Removed ${n.user(e.targetId)} from the org`,
  'invitation.created': (d) => `Invited ${d.email || 'someone'}${d.role ? ` as ${ROLE[d.role] || d.role}` : ''}`,
  'invitation.canceled': () => 'Canceled an invitation',
  'invitation.resent': (d) => `Sent the invitation to ${d.email || 'someone'} again`,
  'team.created': (d) => `Created the team ${d.name || ''}`.trim(),
  'team.renamed': (d) => `Renamed a team to ${d.name || ''}`.trim(),
  'team.deleted': (d, e, n) => `Deleted the team ${n.team(e.targetId)}`,
  'team.member_added': (d, e, n) => `Added ${n.user(d.userId)} to ${n.team(e.targetId)}`,
  'team.member_removed': (d, e, n) => `Removed ${n.user(d.userId)} from ${n.team(e.targetId)}`,
  'instance.policy_updated': (d, e, n) => `Changed the sign-in rule of ${n.inst(e.targetId)}: ${d.requiredMethods && d.requiredMethods.length ? `requires ${methodNames(d.requiredMethods)}` : 'org default'}`,
  'instance.stopped': (d, e, n) => `Stopped ${n.inst(e.targetId)}`,
  'instance.stop_lifted': (d, e, n) => `Allowed ${n.inst(e.targetId)} to run again`,
  'instance.create_started': (d, e, n) => `Started creating ${n.inst(e.targetId)}`,
  'instance.created': (d, e, n) => `${n.cap(n.inst(e.targetId))} is ready${d.version ? ` (version ${d.version})` : ''}`,
  'instance.create_failed': (d, e, n) => `Setting up ${n.inst(e.targetId)} failed`,
  'instance.renamed': (d, e, n) => `Renamed ${n.inst(e.targetId)}`,
  'instance.teams_changed': (d, e, n) => {
    const add = (d.added || []).map(n.team), rm = (d.removed || []).map(n.team);
    return `Changed who can open ${n.inst(e.targetId)}${add.length ? `: added ${add.join(', ')}` : ''}${rm.length ? `${add.length ? ';' : ':'} removed ${rm.join(', ')}` : ''}`;
  },
  'instance.upgrade_started': (d, e, n) => (d.direction === 'downgrade' ? `Started moving ${n.inst(e.targetId)} back to ${d.to}` : `Started upgrading ${n.inst(e.targetId)}${d.to ? ` to ${d.to}` : ''}`),
  'instance.upgraded': (d, e, n) => `Upgraded ${n.inst(e.targetId)}${d.to ? ` to ${d.to}` : ''}`,
  'instance.upgrade_rolled_back': (d, e, n) => `The upgrade of ${n.inst(e.targetId)} was rolled back`,
  'instance.provider_settings_set': (d, e, n) => `Changed the hosting settings of ${n.inst(e.targetId)}`,
  'instance.size_set': (d, e, n) => `Moved ${n.inst(e.targetId)} to the ${SIZE_LABEL[d.to] || d.to} size${d.from ? ` from ${SIZE_LABEL[d.from] || d.from}` : ''}${d.appliesOnStart ? '; applies when it next starts' : ''}`,
  'instance.egress_set': (d, e, n) => `Gave ${n.inst(e.targetId)} its own outbound network policy: ${egressSay(d.to)}`,
  'instance.egress_reset': (d, e, n) => `${n.cap(n.inst(e.targetId))} follows the org's outbound network policy again`,
  'instance.auto_update_set': (d, e, n) => (d.mode === 'off' ? `Turned automatic updates of ${n.inst(e.targetId)} off`
    : `Set automatic updates of ${n.inst(e.targetId)} to ${d.mode === 'minor' ? 'micro and minor releases' : 'micro releases'}`),
  'instance.suspended': (d, e, n) => `${n.cap(n.inst(e.targetId))} fell asleep`,
  'instance.delete_started': (d, e, n) => `Started deleting ${n.inst(e.targetId)}`,
  'instance.deleted': (d, e, n) => `Deleted ${n.inst(e.targetId)}`,
  'instance.op_restarted': (d, e, n) => `Restarted an operation on ${n.inst(e.targetId)}`,
  'instance.rotate_started': (d, e, n) => `Started renewing the credentials of ${n.inst(e.targetId)}`,
  'instance.secrets_rotated': (d, e, n) => `Renewed the credentials of ${n.inst(e.targetId)}${d.restarted ? '; it restarted' : ''}`,
  'auth.signed_in': (d) => `Signed in${d.method ? ` with ${SIGN_IN_METHOD[d.method] || d.method}` : ''}`,
  'auth.sign_in_failed': () => 'A sign-in failed',
  'auth.signed_out': () => 'Signed out',
  'auth.passkey_added': () => 'Added a passkey',
  'domain.added': (d) => `Added the domain ${d.domain || ''}`.trim(),
  'domain.verified': (d) => `Verified the domain ${d.domain || ''}`.trim(),
  'domain.verify_failed': () => "Checked a domain's TXT record: not found yet",
  'domain.removed': (d) => `Removed the domain ${d.domain || ''}`.trim(),
  'sso.registered': (d) => `Connected ${String(d.type || 'SSO').toUpperCase()} single sign-on for @${d.domain || '…'}`,
  'sso.removed': (d) => `Removed the SSO connection ${d.providerId || ''}${d.sessionsEnded ? `; ${plural(d.sessionsEnded, 'session')} ended` : ''}`,
  'confirmation.started': (d) => `Asked by email to confirm: ${CONFIRM_LABEL[d.action] || d.action || 'an action'}`,
  'confirmation.completed': (d) => `Confirmed by email: ${CONFIRM_LABEL[d.action] || d.action || 'an action'}`,
  'user.renamed': () => 'Changed their name',
};
/** Detail keys already said in the sentence; the rest is shown compactly underneath. */
const SAID = {
  'org.created': ['name'], 'org.renamed': ['name'], 'org.key_rotated': ['version'], 'org.policy_updated': ['allowedMethods', 'requiredDomain'], 'org.egress_updated': ['from', 'to'],
  'instance.egress_set': ['to', 'from'], 'instance.egress_reset': ['to', 'from'], 'instance.size_set': ['to', 'from', 'appliesOnStart'],
  'member.role_changed': ['to'], 'invitation.created': ['email', 'role'], 'invitation.resent': ['email'], 'team.created': ['name'], 'team.renamed': ['name'],
  'team.member_added': ['userId'], 'team.member_removed': ['userId'], 'instance.policy_updated': ['requiredMethods'], 'instance.created': ['version'],
  'instance.teams_changed': ['added', 'removed'], 'instance.upgrade_started': ['to'], 'instance.upgraded': ['to'], 'instance.auto_update_set': ['mode'], 'domain.added': ['domain'],
  'domain.verified': ['domain'], 'domain.removed': ['domain'], 'sso.registered': ['type', 'domain'], 'sso.removed': ['providerId', 'sessionsEnded'],
  'confirmation.started': ['action'], 'confirmation.completed': ['action'], 'auth.signed_in': ['method'],
};
const fmtVal = (v) => (v === null || v === undefined ? '—' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v));
function detailsText(e) {
  const d = e.details && typeof e.details === 'object' && !Array.isArray(e.details) ? e.details : null;
  if (!d) return '';
  const skip = new Set(SAID[e.action] || []);
  return Object.entries(d).filter(([k, v]) => !skip.has(k) && v !== undefined).map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${fmtVal(v)}`).join(' · ');
}
function namer(members, instances, teams) {
  const user = new Map(members.map((m) => [m.userId, m.name || m.email]));
  const inst = new Map(instances.map((i) => [i.id, i.name]));
  const team = new Map(teams.map((t) => [t.id, t.name]));
  return {
    user: (id) => user.get(id) || 'a former member',
    inst: (id) => (inst.get(id) ? `the instance ${inst.get(id)}` : 'an instance'),
    team: (id) => team.get(id) || 'a team',
    cap: (s) => s.charAt(0).toUpperCase() + s.slice(1),
    actor: (e) => (e.actorId && user.get(e.actorId)) || (e.actorScope === 'platform' ? (e.actorId ? 'Worca staff' : 'Worca') : e.actorScope === 'system' || !e.actorId ? 'System' : 'A former member'),
  };
}
function describe(e, n) {
  const f = ACTIONS[e.action];
  const d = e.details && typeof e.details === 'object' ? e.details : {};
  try {
    if (f) return f(d, e, n);
  } catch { /* fall through */ }
  return e.action.replace(/[._]/g, ' ');
}

const PAGE = 100;
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
};

async function renderAudit(ctx) {
  const base = p`/api/orgs/${ctx.orgId}`;
  const [{ members }, { instances }, { teams }] = await Promise.all([
    api.get(`${base}/members`),
    api.get(`${base}/instances`).catch(() => ({ instances: [] })),
    api.get(`${base}/teams`).catch(() => ({ teams: [] })),
  ]);
  if (!ctx.alive()) return;
  const n = namer(members, instances, teams);
  const f = { category: ctx.query.get('category') || '', actorId: ctx.query.get('person') || '', action: ctx.query.get('action') || '' };
  if (!CATEGORIES.some(([k]) => k === f.category)) f.category = '';
  let entries = [];
  let more = false;
  const groups = {};
  for (const a of Object.keys(ACTIONS)) (groups[a.split('.')[0]] ??= []).push(a);
  const GROUP_LABEL = { org: 'Org', member: 'Members', invitation: 'Invitations', team: 'Teams', instance: 'Instances', auth: 'Sign-in', domain: 'Domains', sso: 'Single sign-on', confirmation: 'Email confirmations', user: 'People' };

  ctx.set(html`<div class="page">
    ${head('Audit log', `Every change in ${ctx.org.name || 'this org'}, kept for 30 days.`, html`<button class="btn" id="csv" disabled>${icon('download')}Export CSV</button>`)}
    <div class="oa-filters">
      <div class="seg" role="group" aria-label="Category">${CATEGORIES.map(([k, l]) => html`<button type="button" data-cat="${k}" class="${f.category === k ? 'on' : ''}" aria-pressed="${f.category === k ? 'true' : 'false'}">${l}</button>`)}</div>
      <div class="oa-selects">
        <label class="oa-sr" for="f-person">Person</label>
        <select class="inp" id="f-person"><option value="">Everyone</option>${members.map((m) => html`<option value="${m.userId}" ${f.actorId === m.userId ? 'selected' : ''}>${m.name || m.email}</option>`)}</select>
        <label class="oa-sr" for="f-action">Action</label>
        <select class="inp" id="f-action"><option value="">Any action</option>${Object.entries(groups).map(([g, list]) => html`<optgroup label="${GROUP_LABEL[g] || g}"><option value="${g}." ${f.action === `${g}.` ? 'selected' : ''}>All ${(GROUP_LABEL[g] || g).toLowerCase()}</option>${list.map((a) => html`<option value="${a}" ${f.action === a ? 'selected' : ''}>${actionLabel(a)}</option>`)}</optgroup>`)}</select>
      </div>
    </div>
    <div class="card oa-auditcard"><div id="audit-body"><div class="empty"><span class="g slate spin">${icon('loader')}</span></div></div></div>
    <div class="oa-center" id="more-wrap" hidden><button class="btn" id="more">Load older</button></div>
  </div>`);
  const el = ctx.el;
  const body = $('#audit-body', el);

  const query = (before) => {
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (f.category) q.set('category', f.category);
    if (f.actorId) q.set('actorId', f.actorId);
    if (f.action) q.set('action', f.action);
    if (before) q.set('before', String(before));
    return `${base}/audit?${q}`;
  };
  const draw = () => {
    $('#csv', el).disabled = entries.length === 0;
    $('#more-wrap', el).hidden = !more;
    if (!entries.length) {
      const filtered = f.category || f.actorId || f.action;
      setHtml(body, html`<div class="empty">${filtered ? 'Nothing matches these filters in the last 30 days.' : 'Nothing has happened in the last 30 days.'}</div>`);
      return;
    }
    setHtml(body, html`<div class="tablewrap"><table class="oa-audit"><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th></tr></thead>
      <tbody>${entries.map((e) => {
        const det = detailsText(e);
        return html`<tr data-action="${e.action}"><td class="muted oa-when" title="${dateTime(e.at)}">${relTime(e.at)}</td><td class="oa-who">${n.actor(e)}</td>
          <td><div class="oa-what">${describe(e, n)}</div>${det ? html`<div class="oa-det">${det}</div>` : ''}</td></tr>`;
      })}</tbody></table></div>`);
  };
  const load = async (append) => {
    const before = append && entries.length ? entries[entries.length - 1].at : undefined;
    const res = await api.get(query(before));
    if (!ctx.alive()) return;
    entries = append ? [...entries, ...res.entries] : res.entries;
    more = res.entries.length === PAGE;
    draw();
  };
  const reload = async () => {
    const q = new URLSearchParams();
    if (f.category) q.set('category', f.category);
    if (f.actorId) q.set('person', f.actorId);
    if (f.action) q.set('action', f.action);
    history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}`);
    try {
      await load(false);
    } catch (err) {
      setHtml(body, html`<div class="empty">Couldn't load the log: ${errorText(err)}</div>`);
    }
  };
  for (const b of $$('[data-cat]', el)) {
    b.addEventListener('click', () => {
      f.category = b.dataset.cat;
      for (const x of $$('[data-cat]', el)) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); }
      reload();
    });
  }
  $('#f-person', el).addEventListener('change', (e) => { f.actorId = e.target.value; reload(); });
  $('#f-action', el).addEventListener('change', (e) => { f.action = e.target.value; reload(); });
  $('#more', el).addEventListener('click', (e) => busy(e.currentTarget, () => load(true)));
  $('#csv', el).addEventListener('click', () => {
    const rows = [['time', 'who', 'who_id', 'category', 'action', 'description', 'target_type', 'target_id', 'details']];
    for (const e of entries) rows.push([new Date(e.at).toISOString(), n.actor(e), e.actorId || '', e.category, e.action, describe(e, n), e.targetType || '', e.targetId || '', e.details ? JSON.stringify(e.details) : '']);
    const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-${(ctx.org.name || ctx.orgId).replace(/[^\w.-]+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Exported ${plural(entries.length, 'entry', 'entries')}`);
  });
  await load(false);
}
/** Short label for the action filter. */
function actionLabel(a) {
  const LBL = {
    'org.created': 'Org created', 'org.renamed': 'Org renamed', 'org.deleted': 'Org deleted', 'org.tier_changed': 'Plan changed', 'org.key_rotated': 'Data key rotated',
    'org.policy_updated': 'Login policy changed', 'org.audit_viewed': 'Audit log viewed', 'member.role_changed': 'Role changed', 'member.removed': 'Member removed',
    'invitation.created': 'Invitation sent', 'invitation.canceled': 'Invitation canceled', 'invitation.resent': 'Invitation resent', 'team.created': 'Team created',
    'team.renamed': 'Team renamed', 'team.deleted': 'Team deleted', 'team.member_added': 'Added to a team', 'team.member_removed': 'Removed from a team',
    'instance.policy_updated': 'Instance sign-in rule changed', 'instance.stopped': 'Instance stopped', 'instance.stop_lifted': 'Instance allowed again',
    'instance.create_started': 'Instance creation started', 'instance.created': 'Instance ready', 'instance.create_failed': 'Instance setup failed',
    'instance.renamed': 'Instance renamed', 'instance.provider_settings_set': 'Hosting settings changed', 'instance.teams_changed': 'Instance access changed', 'instance.upgrade_started': 'Upgrade started',
    'instance.upgraded': 'Upgraded', 'instance.upgrade_rolled_back': 'Upgrade rolled back', 'instance.auto_update_set': 'Automatic updates changed', 'instance.size_set': 'Compute size changed', 'instance.suspended': 'Fell asleep', 'instance.delete_started': 'Deletion started',
    'instance.deleted': 'Instance deleted', 'instance.op_restarted': 'Operation restarted', 'instance.rotate_started': 'Credential renewal started', 'instance.secrets_rotated': 'Credentials renewed', 'auth.signed_in': 'Signed in', 'auth.sign_in_failed': 'Sign-in failed',
    'auth.signed_out': 'Signed out', 'auth.passkey_added': 'Passkey added', 'domain.added': 'Domain added', 'domain.verified': 'Domain verified',
    'domain.verify_failed': 'Domain check failed', 'domain.removed': 'Domain removed', 'sso.registered': 'SSO connected', 'sso.removed': 'SSO removed',
    'confirmation.started': 'Email confirmation asked', 'confirmation.completed': 'Email confirmation done', 'user.renamed': 'Name changed',
  };
  return LBL[a] || a;
}
// ---- Org settings ----------------------------------------------------------------------------

const KEY_ERRORS = {
  rotation_in_progress: 'The previous rotation is still re-encrypting. Try again when it has finished.',
  rotation_too_soon: 'The key was rotated less than an hour ago. You can rotate it once an hour.',
};

async function renderSettings(ctx) {
  const base = p`/api/orgs/${ctx.orgId}`;
  const [org, keys, { members }] = await Promise.all([
    api.get(base),
    api.get(`${base}/keys`),
    api.get(`${base}/members`).catch(() => ({ members: [] })),
  ]);
  if (!ctx.alive()) return;
  const who = new Map(members.map((m) => [m.userId, m.name || m.email]));
  const t = org.tier;
  const instances = ctx.org.instances ?? 0;
  const mb = (n) => (n >= 1024 ? `${+(n / 1024).toFixed(1)} GB` : `${n} MB`);

  ctx.set(html`<div class="page narrow">
    ${head('Org settings')}
    <section class="card stack" aria-label="Org">
      <form class="stack" id="name-form" novalidate>
        <div class="field"><label for="o-name">Org name</label><input class="inp" id="o-name" maxlength="100" autocomplete="off" value="${org.name || ''}"></div>
        <dl class="kv">
          ${features.tiers ? html`<dt>Plan</dt><dd>${t ? html`<b>${t.name || t.id}</b> · up to ${plural(t.instances, 'instance')} and ${plural(t.members, 'member')} · each instance ${t.vcpu} vCPU, ${mb(t.memoryMb)} memory, ${t.volumeGb} GB storage<div class="hint">Plans are changed by Worca support for now.</div>` : '—'}</dd>` : ''}
          <dt>Org id</dt><dd class="mono">${org.id}</dd>
          <dt>Created</dt><dd>${org.createdAt ? dateTime(org.createdAt) : '—'}</dd>
        </dl>
        ${alertBox('name-err')}
        <div class="flex oa-end"><button class="btn primary" id="name-save" type="submit" disabled>Save</button></div>
      </form>
    </section>
    <section class="card" aria-labelledby="key-h" id="key-card">${keyCard(keys, who, ctx.org.name)}</section>
    <section class="card danger-zone" aria-labelledby="del-h">
      <div class="card-head"><h2 id="del-h">Delete the org</h2></div>
      <div class="between"><span class="ink2 oa-measure">Deletes ${plural(instances, 'instance')} with their data, every member's access and the audit log, at once and for good. You confirm with the org name, your passkey and a link we email you.</span>
        <button class="btn danger" id="del-org">${icon('trash')}Delete org</button></div>
    </section>
  </div>`);
  const el = ctx.el;

  const inp = $('#o-name', el), save = $('#name-save', el);
  inp.addEventListener('input', () => { save.disabled = !inp.value.trim() || inp.value.trim() === org.name; });
  $('#name-form', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const name = inp.value.trim();
    if (!name || name === org.name) return;
    showAlert($('#name-err', el), '');
    busy(save, async () => {
      try {
        await api.patch(base, { name });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'invalid_body') fieldError(inp, 'Use 1 to 100 characters.');
        else showAlert($('#name-err', el), errorText(err));
        return false;
      }
      org.name = name;
      await loadMe().catch(() => {});
      repaintContext(); // the sidebar shows the org name too
      return true;
    }, { done: 'Saved', idleDisabled: () => !inp.value.trim() || inp.value.trim() === org.name });
  });

  const bindRotate = () => {
    const b = $('#rotate', el);
    if (!b) return;
    b.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'Rotate the data key?',
        body: `Creates a new key for ${ctx.org.name || 'the org'} and re-encrypts names, emails and settings with it in the background. Nothing becomes unavailable meanwhile. Needs your passkey.`,
        action: 'Rotate key',
        iconName: 'key',
      });
      if (!ok) return;
      await busy(b, async () => {
        try {
          const res = await protectedAction({ title: 'Rotate the data key', typed: false, danger: false, call: () => api.raw('POST', `${base}/keys/rotate`, {}) });
          if (res) {
            toast(`Rotating to key version ${res.body.version}`);
            watchOp({ type: 'keys', url: `${base}/keys`, href: p`/o/${ctx.orgId}/settings`, kind: 'rotate', version: res.body.version,
              ok: `${ctx.org.name || 'The org'}'s data now uses key version ${res.body.version}`,
              fail: `Re-encryption with key version ${res.body.version} didn't finish` });
            await refreshKey();
          }
        } catch (err) {
          toast(textFor(KEY_ERRORS, err), 'error');
        }
      });
    });
  };
  const refreshKey = async () => {
    const k = await api.get(`${base}/keys`);
    if (!ctx.alive()) return;
    const card = $('#key-card', el);
    setHtml(card, keyCard(k, who, ctx.org.name));
    sizeBars(card);
    bindRotate();
    return k;
  };
  bindRotate();
  sizeBars(el);
  ctx.poll(async () => {
    const card = $('#key-card', el);
    if (card && card.dataset.busy === '1') return;
    if (!$('#key-card [data-running]', el)) return;
    try {
      if (card) card.dataset.busy = '1';
      await refreshKey();
    } catch { /* next tick */ } finally {
      if (card) delete card.dataset.busy;
    }
  }, 3000);

  $('#del-org', el).addEventListener('click', (e) => busy(e.currentTarget, async () => {
    try {
      await protectedAction({
        title: 'Delete the org',
        consequence: html`This deletes <b>${org.name}</b>: ${plural(instances, 'instance')} with their data, every member's access and the audit log. It can't be undone. After this step we email you a link; nothing is deleted until you open it.`,
        name: org.name,
        nameLabel: 'the org name',
        actionLabel: 'Delete org',
        call: (confirmName) => api.raw('DELETE', base, { confirmName }),
      });
    } catch (err) {
      toast(err instanceof ApiError && err.code === 'confirm_name_mismatch' ? "The name didn't match. Nothing was deleted." : errorText(err), 'error');
    }
  }));
}

function keyCard(k, who, orgName) {
  const r = k.reencryption || { status: 'none', done: 0, total: 0, failed: 0 };
  const running = r.status === 'running' || r.status === 'verifying';
  const pct = r.total ? Math.min(100, Math.round((r.done / r.total) * 100)) : 0;
  let status;
  if (running) {
    status = html`<div class="oa-prog" data-running="1" role="status">
      <div class="between"><span><b>${r.status === 'verifying' ? 'Re-encrypted; checking that nothing was missed' : 'Re-encrypting'}</b>${r.status === 'verifying' ? html` <span class="muted">· a few minutes</span>` : ''}</span><span class="mono">${r.done} of ${r.total}</span></div>
      <div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="${r.total}" aria-valuenow="${r.done}" aria-label="Re-encryption progress"><i data-pct="${pct}"></i></div>
      ${r.failed ? html`<div class="banner amber">${icon('alert')}<div class="grow">${plural(r.failed, 'row')} couldn't be re-encrypted yet; they are retried.</div></div>` : html`<span class="hint">Everything stays available meanwhile.</span>`}</div>`;
  } else if (r.status === 'incomplete') {
    status = html`<div class="banner amber">${icon('alert')}<div class="grow"><b>Re-encryption didn't finish.</b> ${r.done} of ${r.total} done${r.failed ? html`, ${plural(r.failed, 'row')} failed` : ''}. The older key versions are kept, so nothing is lost. Contact Worca support if this stays.${r.error ? html`<div class="muted oa-small">${r.error}</div>` : ''}</div></div>`;
  } else if (r.status === 'done') {
    status = html`<div class="flex oa-small"><span class="g green">${icon('check')}</span><span class="ink2">All data uses the current key${r.failed ? html` · ${plural(r.failed, 'row')} failed` : ''}.</span></div>`;
  } else status = '';
  const card = html`<div class="card-head"><h2 id="key-h">Encryption</h2>${k.version ? html`<span class="pill line">Key version ${k.version}</span>` : ''}</div>
    <div class="stack">
      <div class="between"><span class="ink2 oa-measure">Names, emails and settings of ${orgName || 'the org'} are encrypted with a key of its own. Rotating it re-encrypts everything in the background.</span>
        <button class="btn" id="rotate" ${running ? 'disabled' : ''}>${icon('key')}Rotate key</button></div>
      ${status}
      <div class="muted oa-small">${k.rotatedAt ? html`Last rotated ${relTime(k.rotatedAt)}${k.rotatedBy ? html` by ${who.get(k.rotatedBy) || 'a former member'}` : ''}` : 'Not rotated yet'}</div>
    </div>`;
  return card;
}

/** Progress bar widths come from data-pct: set from JS, since the CSP blocks inline styles. */
function sizeBars(root) {
  for (const i of root.querySelectorAll('.oa-prog i[data-pct]')) i.style.width = `${i.dataset.pct}%`;
}

export default [
  { path: '/o/:orgId/security', nav: 'security', title: 'Sign-in and security', adminOnly: true, render: renderSecurity },
  { path: '/o/:orgId/audit', nav: 'audit', title: 'Audit log', adminOnly: true, render: renderAudit },
  { path: '/o/:orgId/settings', nav: 'settings', title: 'Org settings', adminOnly: true, render: renderSettings },
];
