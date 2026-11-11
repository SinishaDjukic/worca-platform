/// <reference types="vite/client" />
// Wrangler configs are what a worca.config.ts generates: the names of every Worker, database and
// Workflow, and both Workers' vars, per environment. Checked for the contributors' stack (dev.config.ts
// and the root wrangler.*.jsonc) and for every deployment kept in deployments/, if any (a maintainer's
// own deployment can live there, outside the public repo, hence the glob).
import { describe, expect, it } from 'vitest';
import devControl from '../../../wrangler.control.jsonc?raw';
import devGate from '../../../wrangler.gate.jsonc?raw';
import devConfig from '../../../dev.config';
import { parsePlatformConfig, resourceNames, wranglerVars, type Environment, type PlatformConfigInput } from '../../../packages/platform/src/shared/config';

interface WranglerEnv {
  name: string;
  vars: Record<string, string>;
  d1_databases?: { database_name: string }[];
  services?: { service: string }[];
  workflows?: { name: string; class_name: string }[];
}
type Wrangler = { env: Record<string, WranglerEnv> };
const parse = (text: string) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as Wrangler;

const configs = import.meta.glob<PlatformConfigInput>('../../../deployments/*/worca.config.ts', { eager: true, import: 'default' });
const texts = import.meta.glob<string>('../../../deployments/*/wrangler.*.jsonc', { eager: true, query: '?raw', import: 'default' });

const cases: { label: string; config: PlatformConfigInput; control: Wrangler; gate: Wrangler }[] = [
  { label: 'dev.config.ts', config: devConfig, control: parse(devControl), gate: parse(devGate) },
  ...Object.entries(configs).map(([path, config]) => {
    const dir = path.replace(/worca\.config\.ts$/, '');
    return { label: path.replace('../../../', ''), config, control: parse(texts[`${dir}wrangler.control.jsonc`]!), gate: parse(texts[`${dir}wrangler.gate.jsonc`]!) };
  }),
];

describe.each(cases)('$label', ({ config, control, gate }) => {
  const parsed = parsePlatformConfig(config);
  const envs = Object.keys(parsed.environments) as Environment[];

  it('has a wrangler env for each of its environments, and no other', () => {
    expect(Object.keys(control.env).sort()).toEqual([...envs].sort());
    expect(Object.keys(gate.env).sort()).toEqual([...envs].sort());
  });

  it.each(envs)('%s: generates the wrangler vars of both Workers', (env) => {
    const vars = wranglerVars(parsed, env);
    expect(control.env[env]!.vars).toEqual(vars.control);
    expect(gate.env[env]!.vars).toEqual(vars.gate);
  });

  it.each(envs)('%s: names every Worker, database and Workflow', (env) => {
    const n = resourceNames(parsed, env);
    expect(control.env[env]!.name).toBe(n.control);
    expect(gate.env[env]!.name).toBe(n.gate);
    expect(control.env[env]!.d1_databases?.[0]?.database_name).toBe(n.database);
    expect(control.env[env]!.services?.[0]?.service).toBe(n.gate);
    expect(gate.env[env]!.services?.[0]?.service).toBe(n.control);
    expect(Object.fromEntries((control.env[env]!.workflows ?? []).map((w) => [w.class_name, w.name]))).toEqual({
      InstanceOpsWorkflow: n.instanceOps,
      KeyRotationWorkflow: n.keyRotation,
      NewsletterSendWorkflow: n.newsletterSend,
    });
  });
});

it('finds worca-run when its deployment folder is present', () => {
  // Guards the glob: in worca-run the folder exists and must be checked, not silently skipped.
  if (Object.keys(texts).length) expect(Object.keys(configs)).toContain('../../../deployments/worca-run/worca.config.ts');
});
