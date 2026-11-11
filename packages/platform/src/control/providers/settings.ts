// Provider settings, declared not coded (docs/providers.md "Settings"): a compute provider lists
// its own fields as data (ComputeProviderInfo.settings), the console renders them generically,
// the platform validates what is saved against the declaration and hands the values to the
// provider on every call. Deployment-level values live in platform_settings
// (`compute_settings`), instance-level ones in instances.provider_settings (0032), each as
// {"provider": name, "values": {...}}: values saved for another provider are ignored.
//
// A `secret` field holds the NAME of a Worker secret (e.g. RAILWAY_TOKEN), never its value: the
// provider reads env[name]. Nothing here ever stores or returns a secret's value.

export type SettingKind = 'text' | 'number' | 'boolean' | 'select' | 'secret';
export type SettingValue = string | number | boolean;
export type SettingValues = Record<string, SettingValue>;

export interface SettingField {
  /** Stored under this key; lowercase camelCase. Never rename one: saved values are kept by key. */
  key: string;
  kind: SettingKind;
  label: string;
  /** A sentence under the field. */
  help?: string;
  /** Used while nothing is saved. A `secret` field's default is a secret name. */
  default?: SettingValue;
  /** Must have a value (saved or default). */
  required?: boolean;
  /** text: a pattern the whole value must match, and its message. */
  pattern?: string;
  patternMessage?: string;
  /** text: at most this many characters (default 200). */
  maxLength?: number;
  /** number: bounds and whether it must be whole. */
  min?: number;
  max?: number;
  integer?: boolean;
  /** select: the choices. */
  options?: readonly { value: string; label: string }[];
}

export interface SettingsDeclaration {
  /** Set once per deployment by a superadmin (Operations → Provider settings). */
  deployment?: readonly SettingField[];
  /** Set per instance by its tenant admins (new-instance form, instance page). */
  instance?: readonly SettingField[];
}

export type SettingsScope = keyof SettingsDeclaration;

/** A Worker secret's name, as wrangler takes it. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const KEY = /^[a-z][a-zA-Z0-9]{0,39}$/;

/** Problems with a declaration itself (the conformance checks run this). Empty when it is fine. */
export function declarationProblems(decl: SettingsDeclaration | undefined): string[] {
  const out: string[] = [];
  for (const scope of ['deployment', 'instance'] as const) {
    const seen = new Set<string>();
    for (const f of decl?.[scope] ?? []) {
      const at = `${scope}.${f.key}`;
      if (!KEY.test(f.key)) out.push(`${at}: key must be camelCase letters and digits`);
      if (seen.has(f.key)) out.push(`${at}: duplicate key`);
      seen.add(f.key);
      if (!['text', 'number', 'boolean', 'select', 'secret'].includes(f.kind)) out.push(`${at}: unknown kind ${f.kind}`);
      if (!f.label?.trim()) out.push(`${at}: a label`);
      if (f.kind === 'select' && !f.options?.length) out.push(`${at}: a select needs options`);
      if (f.pattern) {
        try {
          new RegExp(f.pattern);
        } catch {
          out.push(`${at}: pattern is not a regular expression`);
        }
      }
      if (f.default !== undefined) {
        const problem = fieldProblem(f, f.default);
        if (problem) out.push(`${at}: default ${JSON.stringify(f.default)}: ${problem}`);
      }
    }
  }
  return out;
}

/** Why `value` doesn't fit `field`, or null when it does. */
export function fieldProblem(f: SettingField, value: unknown): string | null {
  switch (f.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
      if (f.integer && !Number.isInteger(value)) return 'must be a whole number';
      if (f.min !== undefined && value < f.min) return `must be at least ${f.min}`;
      if (f.max !== undefined && value > f.max) return `must be at most ${f.max}`;
      return null;
    }
    case 'select':
      return typeof value === 'string' && (f.options ?? []).some((o) => o.value === value) ? null : 'must be one of the options';
    case 'secret':
      return typeof value === 'string' && SECRET_NAME.test(value) ? null : 'must be the name of a Worker secret (A–Z, digits, _), never its value';
    case 'text': {
      if (typeof value !== 'string') return 'must be text';
      if (value.length > (f.maxLength ?? 200)) return `at most ${f.maxLength ?? 200} characters`;
      if (/[\u0000-\u001f]/.test(value)) return 'no control characters';
      if (f.pattern && value !== '' && !new RegExp(`^(?:${f.pattern})$`).test(value)) return f.patternMessage ?? 'is not in the expected form';
      return null;
    }
  }
  return 'unknown kind';
}

export class SettingsError extends Error {
  constructor(readonly problems: Record<string, string>) {
    super(`invalid provider settings: ${Object.entries(problems).map(([k, v]) => `${k} ${v}`).join('; ')}`);
  }
}

/**
 * What a client sent, checked against the fields: unknown keys refused, each value of the right
 * kind, empty text and null meaning "not set" (dropped, so the default applies), required fields
 * set or defaulted. Returns the values to store. Throws SettingsError naming each problem.
 */
export function validateSettings(fields: readonly SettingField[] | undefined, input: unknown): SettingValues {
  const list = fields ?? [];
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new SettingsError({ '': 'must be an object' });
  const problems: Record<string, string> = {};
  const out: SettingValues = {};
  for (const key of Object.keys(input)) if (!list.some((f) => f.key === key)) problems[key] = 'is not a setting of this provider';
  for (const f of list) {
    const raw = (input as Record<string, unknown>)[f.key];
    if (raw === undefined || raw === null || raw === '') {
      if (f.required && f.default === undefined) problems[f.key] = 'is required';
      continue;
    }
    const value = f.kind === 'text' || f.kind === 'secret' ? (typeof raw === 'string' ? raw.trim() : raw) : raw;
    const problem = fieldProblem(f, value);
    if (problem) problems[f.key] = problem;
    else out[f.key] = value as SettingValue;
  }
  if (Object.keys(problems).length) throw new SettingsError(problems);
  return out;
}

/** The values a provider gets: defaults, then what is saved (only keys still declared, still valid). */
export function effectiveSettings(fields: readonly SettingField[] | undefined, saved: SettingValues | null | undefined): SettingValues {
  const out: SettingValues = {};
  for (const f of fields ?? []) {
    if (f.default !== undefined) out[f.key] = f.default;
    const v = saved?.[f.key];
    if (v !== undefined && fieldProblem(f, v) === null) out[f.key] = v;
  }
  return out;
}

/** A stored {"provider", "values"} blob → the values, when they were saved for this provider. */
export function storedValues(raw: string | null | undefined, provider: string): SettingValues | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { provider?: unknown; values?: unknown };
    if (parsed?.provider !== provider || !parsed.values || typeof parsed.values !== 'object') return null;
    return parsed.values as SettingValues;
  } catch {
    return null;
  }
}

export const storeValues = (provider: string, values: SettingValues): string => JSON.stringify({ provider, values });

/** For the console: each secret field's whether the named secret is set on the Worker (never its value). */
export function secretsSet(fields: readonly SettingField[] | undefined, values: SettingValues, env: object): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of fields ?? []) {
    if (f.kind !== 'secret') continue;
    const name = values[f.key];
    out[f.key] = typeof name === 'string' && !!(env as Record<string, unknown>)[name];
  }
  return out;
}
