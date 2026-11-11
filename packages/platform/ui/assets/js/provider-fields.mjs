// Provider settings fields (src/control/providers/settings.ts, docs/providers.md "Settings"): the
// compute provider declares them as data, and this renders and reads them, whatever the provider.
// Used on Operations (deployment fields), the new-instance form and the instance page (instance fields).
import { $, fieldError, html } from './core.mjs';

const idOf = (prefix, key) => `${prefix}-${key}`;

/**
 * The fields as form markup. `values`: what to show (saved, else the default); `secretsSet`: for
 * secret fields, whether the named Worker secret exists (never its value).
 */
export function providerFields(fields, { values = {}, secretsSet = {}, prefix = 'pf', disabled = false } = {}) {
  return html`${fields.map((f) => {
    const id = idOf(prefix, f.key);
    const v = values[f.key] ?? f.default;
    const help = f.help ? html`<span class="hint" id="${id}-hint">${f.help}</span>` : '';
    const dis = disabled ? 'disabled' : '';
    if (f.kind === 'boolean') {
      return html`<div class="field"><label class="check"><input type="checkbox" id="${id}" data-pf="${f.key}" ${v === true ? 'checked' : ''} ${dis}><span class="t"><b>${f.label}</b></span></label>${help}</div>`;
    }
    if (f.kind === 'select') {
      return html`<div class="field"><label for="${id}">${f.label}</label><select class="inp" id="${id}" data-pf="${f.key}" ${dis}>
        ${f.required || f.default !== undefined ? '' : html`<option value="" ${v === undefined ? 'selected' : ''}>Not set</option>`}
        ${(f.options || []).map((o) => html`<option value="${o.value}" ${o.value === v ? 'selected' : ''}>${o.label}</option>`)}</select>${help}</div>`;
    }
    const opt = f.required ? '' : html` <span class="opt">optional</span>`;
    if (f.kind === 'number') {
      return html`<div class="field"><label for="${id}">${f.label}${opt}</label><input class="inp" type="number" id="${id}" data-pf="${f.key}" value="${v ?? ''}"
        min="${f.min ?? ''}" max="${f.max ?? ''}" step="${f.integer ? '1' : 'any'}" ${dis}>${help}</div>`;
    }
    if (f.kind === 'secret') {
      const set = secretsSet[f.key];
      const state = set === undefined ? '' : set ? html`<span class="pill green" id="${id}-set">secret is set</span>` : html`<span class="pill amber" id="${id}-set">no such secret on the Worker</span>`;
      return html`<div class="field"><label for="${id}">${f.label} <span class="opt">name of a Worker secret</span></label>
        <div class="flex"><input class="inp mono" id="${id}" data-pf="${f.key}" value="${v ?? ''}" maxlength="64" autocomplete="off" spellcheck="false" placeholder="SECRET_NAME" ${dis}>${state}</div>
        ${help}<span class="hint">Only the name is stored. Set the value with <span class="mono">wrangler secret put</span>.</span></div>`;
    }
    return html`<div class="field"><label for="${id}">${f.label}${opt}</label><input class="inp" id="${id}" data-pf="${f.key}" value="${v ?? ''}" maxlength="${f.maxLength || 200}" autocomplete="off" ${dis}>${help}</div>`;
  })}`;
}

/** What the form holds, as the API takes it: empty text means "not set" (the default applies). */
export function readProviderFields(fields, root, prefix = 'pf') {
  const out = {};
  for (const f of fields) {
    const el = $(`#${idOf(prefix, f.key)}`, root);
    if (!el) continue;
    if (f.kind === 'boolean') out[f.key] = el.checked;
    else if (f.kind === 'number') out[f.key] = el.value === '' ? null : Number(el.value);
    else out[f.key] = el.value.trim() === '' ? null : el.value.trim();
  }
  return out;
}

/** The API's invalid_provider_settings problems under their fields; true when any was shown. */
export function showFieldProblems(problems, root, prefix = 'pf') {
  let shown = false;
  for (const [key, text] of Object.entries(problems || {})) {
    const el = $(`#${idOf(prefix, key)}`, root);
    if (!el) continue;
    fieldError(el, `${text.charAt(0).toUpperCase()}${text.slice(1)}.`, { focus: !shown });
    shown = true;
  }
  return shown;
}

/** One line for a read-only summary: "Label: value" per field that has one. */
export function fieldsLine(fields, values) {
  const parts = fields
    .filter((f) => values[f.key] !== undefined && values[f.key] !== '')
    .map((f) => {
      const v = values[f.key];
      const shown = f.kind === 'boolean' ? (v ? 'on' : 'off') : f.kind === 'select' ? (f.options || []).find((o) => o.value === v)?.label ?? v : v;
      return `${f.label}: ${shown}`;
    });
  return parts.length ? parts.join(' · ') : 'Defaults';
}

export const hasFields = (fields) => Array.isArray(fields) && fields.length > 0;
