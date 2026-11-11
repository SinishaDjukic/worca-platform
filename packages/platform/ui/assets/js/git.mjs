// Git credentials per instance (D79): the instance page's row and the tenant admins' dialog.
// Routes in src/control/instances/routes.ts (GET/PUT …/instances/:id/git), docs/instance-lifecycle.md
// "Git credentials". Secrets are write-only: the dialog shows what is stored and its last four
// characters, and a field left empty keeps the stored secret.
import { api, html, icon, $, $$, openModal, closeModal, protectedAction, ApiError, errorText, setHtml, fieldError, clearFieldErrors, alertBox, showAlert, toast, busy, watchOp } from './core.mjs';

export const PUSH_AS_TEXT = {
  instance: "The instance's credential",
  prefer: 'The person who acted, when they connected GitHub',
  required: 'Only the person who acted',
};

/** "GitHub App acme-worca · Azure DevOps", or what is missing. */
export function gitLine(g) {
  if (!g) return 'No credential of the instance: members use their own GitHub';
  const hosts = [];
  if (g.github?.kind === 'app') hosts.push(`GitHub App ${g.github.appSlug || g.github.appId}`);
  else if (g.github?.kind === 'token') hosts.push(g.github.login ? `GitHub token of ${g.github.login}` : 'GitHub token');
  if (g.azure) hosts.push('Azure DevOps');
  if (g.bitbucket) hosts.push('Bitbucket');
  return hosts.length ? hosts.join(' · ') : 'No credential of the instance: members use their own GitHub';
}

/** The row on the instance page: tenant admins open the dialog, members learn whether pushes go out as them. */
export function gitRow(inst, admin, g) {
  if (!g) return '';
  const pending = g.pending && inst.op?.status !== 'running'
    ? html`<span class="muted" id="git-pending">${inst.status === 'running' ? 'Not applied yet: save again to retry.' : 'Applies when the instance next starts.'}</span>`
    : '';
  if (!admin) {
    if (g.pushAs === 'instance') return '';
    const how = g.signIn ? 'sign in with GitHub or paste a token' : 'paste a GitHub token';
    const until = g.pushAs === 'required' ? ' Until then, your pushes fail.' : g.github ? " Until then, the instance's credential is used." : ' Until then, only public repositories can be cloned and pushes fail.';
    return html`<div class="row" id="git-row">${icon('key')}<div class="t"><b>Your GitHub</b><span id="git-line">Worca clones, pushes and opens pull requests as you once you ${how} on the <a href="${inst.keyUrl}" target="_blank" rel="noopener">key page</a>.${until}</span></div></div>`;
  }
  const push = g.pushAs !== 'instance' ? html`<span class="muted">Members' own GitHub: ${g.pushAs === 'required' ? 'required for pushes' : 'used when connected'}</span>` : '';
  const body = html`${icon('key')}<div class="t"><b>Git credentials</b><span id="git-line">${gitLine(g.configured ? g : null)}</span>${push}${pending}</div>`;
  if (inst.status === 'creating' || inst.status === 'deleting') return html`<div class="row" id="git-row">${body}</div>`;
  return html`<button type="button" class="row click inst-rowbtn" id="edit-git">${body}<div class="r">Change ${icon('chev')}</div></button>`;
}

const stored = (what, setAt) => `Stored${what ? ` (${what})` : ''}${setAt ? ` since ${new Date(setAt).toLocaleDateString()}` : ''}. Leave empty to keep it.`;
const radio = (name, value, checked, title, sub = '') =>
  html`<label class="check"><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''}><span class="t"><b>${title}</b>${sub ? html`<span>${sub}</span>` : ''}</span></label>`;

/** Field ids for the API's `field` in a refusal. */
const FIELD_IDS = {
  'github.appId': 'gt-app-id', 'github.privateKey': 'gt-app-key', 'github.installationId': 'gt-app-inst', 'github.clientSecret': 'gt-app-secret',
  'github.token': 'gt-token', 'azure.token': 'gt-ado', 'bitbucket.token': 'gt-bb-token', 'bitbucket.email': 'gt-bb-email',
  'identity.name': 'gt-id-name', 'identity.email': 'gt-id-email', cloneAllow: 'gt-clone',
};
const REFUSED = {
  git_secret_required: 'Paste it: none of this kind is stored yet.',
  git_app_id_invalid: "The App ID is a number, on the App's settings page.",
  git_private_key_invalid: 'Paste the whole private key file (.pem), from -----BEGIN to -----END.',
  git_installation_invalid: 'The installation ID is a number, from the URL of the installation (…/installations/123456).',
  git_token_invalid: 'This doesn’t look like a token: paste it without spaces.',
  git_email_invalid: 'Enter an email address.',
  git_identity_invalid: 'Enter a name (with the email address).',
  git_clone_allow_invalid: 'One per line: a host and path such as github.com/acme/* or dev.azure.com/acme/project/repo.',
  git_app_rejected: "GitHub doesn't accept this key for this App ID. Check both, or create a new private key on the App's page.",
  git_installation_not_found: 'This App has no installation with that ID. Leave it empty to find it from each repository.',
  git_app_not_installed: 'The App is not installed on any account yet. Install it on your GitHub organization first.',
  git_token_rejected: 'GitHub refused this token: it may have expired or been revoked.',
};
const GENERAL = {
  git_changed: 'Someone changed the git credentials meanwhile. These are the current ones; check them and try again.',
  instance_busy: 'Something else is under way on this instance. Try again when it has finished.',
  git_check_failed: "GitHub didn't answer, so the credential couldn't be checked. Try again in a moment.",
};

/**
 * The tenant admins' dialog, then a confirmation step in the same dialog. Adding or replacing a
 * credential may ask for a passkey first (protectedAction steps up on mfa_required).
 */
export function gitModal({ inst, git: g, path, href, name, reload, alive, alert = '' }) {
  const running = inst.status === 'running';
  const gh = g.github;
  const app = gh?.kind === 'app' ? gh : null;
  const tok = gh?.kind === 'token' ? gh : null;
  const m = openModal(html`<h2>Git credentials</h2>
    <div id="gt-pick" class="form">
      <p>What Worca on ${name} clones, pushes and opens pull requests with. Agents never see them; Worca adds them only to its own git calls. Once saved, a secret is never shown again.</p>
      <fieldset class="field inst-fieldset"><legend>GitHub</legend><div class="checks">
        ${radio('gt-gh', 'none', !gh, 'None')}
        ${radio('gt-gh', 'app', !!app, 'Your GitHub App', 'Recommended: short-lived tokens per call, only the repositories you install it on, pull requests from the App')}
        ${radio('gt-gh', 'token', !!tok, 'A token', 'A fine-grained personal access token with Contents and Pull requests read and write')}
      </div></fieldset>
      <div id="gt-app" class="stack">
        <div class="field"><label for="gt-app-id">App ID</label><input class="inp" id="gt-app-id" inputmode="numeric" autocomplete="off" value="${app?.appId || ''}"></div>
        <div class="field"><label for="gt-app-key">Private key</label><textarea class="inp eg-list" id="gt-app-key" rows="4" spellcheck="false" autocomplete="off" placeholder="-----BEGIN RSA PRIVATE KEY-----"></textarea>
          <span class="hint">${app ? stored(app.appName || app.appSlug, app.setAt) : "The .pem file from the App's page, Private keys › Generate a private key."}</span></div>
        <div class="field"><label for="gt-app-inst">Installation ID <span class="opt">optional</span></label><input class="inp" id="gt-app-inst" inputmode="numeric" autocomplete="off" value="${app?.installationId || ''}">
          <span class="hint">Leave empty and Worca finds it from each repository.</span></div>
        <label class="row" for="gt-app-signin">${icon('user')}<div class="t"><b>Members can sign in with GitHub</b><span>On the key page, through this App (turn on Device flow on the App's page). Without it they paste a token there.</span></div>
          <div class="r"><span class="switch"><input type="checkbox" id="gt-app-signin" ${app?.signIn ? 'checked' : ''}><i></i></span></div></label>
        <div class="field" id="gt-app-secret-f"><label for="gt-app-secret">Client secret</label><input class="inp" id="gt-app-secret" type="password" autocomplete="off">
          <span class="hint">${app?.signIn ? stored('', null) : "From the App's page, Client secrets › Generate a new client secret. Worca renews members' tokens with it."}</span></div>
      </div>
      <div id="gt-tok" class="field"><label for="gt-token">Token</label><input class="inp" id="gt-token" type="password" autocomplete="off" placeholder="github_pat_…">
        <span class="hint">${tok ? stored(`${tok.login ? `${tok.login}, ` : ''}…${tok.last4}`, tok.setAt) : 'Pushes and pull requests show the account that owns it, often a bot account.'}</span></div>

      <fieldset class="field inst-fieldset"><legend>Azure DevOps</legend><div class="checks">
        ${radio('gt-az', 'none', !g.azure, 'None')}${radio('gt-az', 'pat', !!g.azure, 'A personal access token', 'Code read and write; Work items read for Boards')}
      </div></fieldset>
      <div class="field" id="gt-ado-f"><label for="gt-ado">Personal access token</label><input class="inp" id="gt-ado" type="password" autocomplete="off">
        <span class="hint">${g.azure ? stored(`…${g.azure.last4}`, g.azure.setAt) : 'For repositories on dev.azure.com.'}</span></div>

      <fieldset class="field inst-fieldset"><legend>Bitbucket</legend><div class="checks">
        ${radio('gt-bb', 'none', !g.bitbucket, 'None')}
        ${radio('gt-bb', 'access-token', g.bitbucket?.kind === 'access-token', 'An access token', 'Of a repository, project or workspace')}
        ${radio('gt-bb', 'api-token', g.bitbucket?.kind === 'api-token', 'An Atlassian API token', 'With the email address of its account')}
      </div></fieldset>
      <div class="stack" id="gt-bb-f">
        <div class="field" id="gt-bb-email-f"><label for="gt-bb-email">Atlassian account email</label><input class="inp" id="gt-bb-email" type="email" autocomplete="off" value="${g.bitbucket?.email || ''}"></div>
        <div class="field"><label for="gt-bb-token">Token</label><input class="inp" id="gt-bb-token" type="password" autocomplete="off">
          <span class="hint">${g.bitbucket ? stored(`…${g.bitbucket.last4}`, g.bitbucket.setAt) : 'For repositories on bitbucket.org.'}</span></div>
      </div>

      <fieldset class="field inst-fieldset"><legend>Commit identity <span class="opt">optional</span></legend>
        <div class="field"><label for="gt-id-name">Name</label><input class="inp" id="gt-id-name" maxlength="100" autocomplete="off" placeholder="Acme Worca" value="${g.identity?.name || ''}"></div>
        <div class="field"><label for="gt-id-email">Email</label><input class="inp" id="gt-id-email" type="email" autocomplete="off" placeholder="worca@acme.com" value="${g.identity?.email || ''}">
          <span class="hint">What agents commit as on this instance.</span></div>
      </fieldset>

      <div class="field"><label for="gt-clone">Repositories that may be cloned <span class="opt">optional</span></label>
        <textarea class="inp eg-list" id="gt-clone" rows="3" spellcheck="false" autocomplete="off" placeholder="github.com/acme/*&#10;dev.azure.com/acme/shop/*">${g.cloneAllow.join('\n')}</textarea>
        <span class="hint">One per line. Empty: any repository the credentials reach.</span></div>

      <fieldset class="field inst-fieldset"><legend>Who Worca acts as on GitHub</legend><div class="checks">
        ${radio('gt-push', 'prefer', g.pushAs === 'prefer', PUSH_AS_TEXT.prefer, 'The instance’s credential for everyone who hasn’t, and for scheduled runs nobody started')}
        ${radio('gt-push', 'required', g.pushAs === 'required', PUSH_AS_TEXT.required, 'A push by someone who hasn’t connected GitHub fails and says how to connect')}
        ${radio('gt-push', 'instance', g.pushAs === 'instance', PUSH_AS_TEXT.instance)}
      </div><span class="hint">GitHub only. Members connect their GitHub on the key page; their clones and fetches use it too.</span></fieldset>
      ${alertBox('gt-err-pick')}
      <div class="acts"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="gt-next">Continue</button></div>
    </div>
    <div id="gt-confirm" hidden>
      <p id="gt-summary"></p>
      ${alertBox('gt-err')}
      <div class="acts"><button type="button" class="btn" id="gt-back">Back</button><button type="button" class="btn primary" id="gt-go"></button></div>
    </div>`, { wide: true });

  const val = (id) => $(`#${id}`, m).value.trim();
  const pick = (n) => $(`input[name="${n}"]:checked`, m)?.value;
  const sync = () => {
    $('#gt-app', m).hidden = pick('gt-gh') !== 'app';
    $('#gt-tok', m).hidden = pick('gt-gh') !== 'token';
    $('#gt-app-secret-f', m).hidden = !$('#gt-app-signin', m).checked;
    $('#gt-ado-f', m).hidden = pick('gt-az') !== 'pat';
    $('#gt-bb-f', m).hidden = pick('gt-bb') === 'none';
    $('#gt-bb-email-f', m).hidden = pick('gt-bb') !== 'api-token';
  };
  for (const el of $$('input[type=radio], #gt-app-signin', m)) el.addEventListener('change', sync);
  sync();
  showAlert($('#gt-err-pick', m), alert);

  /** The wanted state; empty secret fields keep what is stored. */
  const want = () => {
    const body = { version: g.version };
    const secret = (id) => val(id) || undefined;
    const ghPick = pick('gt-gh');
    if (ghPick === 'none') body.github = null;
    else if (ghPick === 'app') {
      body.github = { kind: 'app', appId: val('gt-app-id'), privateKey: secret('gt-app-key'), installationId: val('gt-app-inst') || null, signIn: $('#gt-app-signin', m).checked ? { clientSecret: secret('gt-app-secret') } : null };
    } else body.github = { kind: 'token', token: secret('gt-token') };
    body.azure = pick('gt-az') === 'pat' ? { token: secret('gt-ado') } : null;
    const bb = pick('gt-bb');
    body.bitbucket = bb === 'none' ? null : { token: secret('gt-bb-token'), email: bb === 'api-token' ? val('gt-bb-email') : null };
    body.identity = val('gt-id-name') || val('gt-id-email') ? { name: val('gt-id-name'), email: val('gt-id-email') } : null;
    body.cloneAllow = $('#gt-clone', m).value.split('\n').map((s) => s.trim()).filter(Boolean);
    body.pushAs = pick('gt-push');
    return body;
  };

  const back = () => { $('#gt-confirm', m).hidden = true; $('#gt-pick', m).hidden = false; };
  $('#gt-next', m).addEventListener('click', () => {
    clearFieldErrors(m);
    showAlert($('#gt-err-pick', m), '');
    setHtml($('#gt-summary', m), html`The git credentials of ${name} change.${running ? ' Worca restarts now; active runs pause and resume.' : ' Nothing restarts now; they apply when the instance next starts.'}
      ${running && $('#gt-app-signin', m).checked !== !!app?.signIn ? ' The key page restarts too.' : ''}`);
    setHtml($('#gt-go', m), running ? 'Save and restart Worca' : 'Save');
    $('#gt-pick', m).hidden = true;
    $('#gt-confirm', m).hidden = false;
    $('#gt-go', m).focus();
  });
  $('#gt-back', m).addEventListener('click', back);
  $('#gt-go', m).addEventListener('click', (e) => busy(e.currentTarget, async () => {
    showAlert($('#gt-err', m), '');
    let res;
    try {
      res = await protectedAction({ title: 'Change the git credentials', typed: false, danger: false, call: () => api.raw('PUT', path, want()) });
    } catch (x) {
      const field = x instanceof ApiError ? FIELD_IDS[x.body?.field] : null;
      if (m.isConnected && field && REFUSED[x.code]) {
        back();
        fieldError($(`#${field}`, m), REFUSED[x.code]);
        return;
      }
      const text = (x instanceof ApiError && (GENERAL[x.code] || REFUSED[x.code])) || errorText(x);
      await reload().catch(() => {});
      if (!alive()) return;
      if (x?.code === 'git_changed' || !m.isConnected) return void gitModal({ inst, git: g, path, href, name, reload, alive, alert: text });
      showAlert($('#gt-err', m), text);
      return;
    }
    if (!res) return;
    if (m.isConnected) closeModal();
    const result = res.body?.result;
    if (result === 'applying') watchOp({ url: path.replace(/\/git$/, ''), href, kind: 'reconfigure', ok: `The git credentials are applied on ${name}`, fail: `The git credentials couldn't be applied on ${name}` });
    toast({ applying: 'Saved; Worca is restarting', saved: 'Saved; applies when the instance next starts', unchanged: 'Nothing changed' }[result] || 'Saved');
    await reload();
  }));
}

