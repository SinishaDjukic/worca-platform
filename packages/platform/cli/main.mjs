#!/usr/bin/env node
// worca-platform: the commands of a deployment of @worca/platform. A generated deployment's
// package.json scripts call it (npm run setup, deploy, dev, smoke, secrets, admin, upgrade).
//
//   worca-platform configure                 wrangler configs from worca.config.ts + worca.resources.json
//   worca-platform setup [--env prod]        resources, secrets, migrations, deploy (re-runnable)
//   worca-platform deploy [--env prod] [--dry-run]
//   worca-platform dev [--env dev]           the local stack with the fake providers
//   worca-platform smoke [--env prod|dev] [--email a@b] [--inbox ./inbox.mjs] [--timeout-s 1800]
//   worca-platform secrets [set NAME] [--env prod]
//   worca-platform admin you@example.com [--env prod]
//   worca-platform upgrade [--tag latest] [--env prod] [--no-deploy]
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, localEnvs, readEnvFile, remoteEnvs, writeWranglerConfigs } from './deployment.mjs';
import { closePrompts } from './prompt.mjs';

const USAGE = `usage: worca-platform <configure|setup|deploy|dev|smoke|secrets|admin|upgrade> [options]
  --env <name>      environment of worca.config.ts (default: prod, or the local one for dev)
  --dry-run         deploy: bundle both Workers into .dry/ and touch nothing
  --email, --inbox  smoke: the smoke account and a module exporting getMail(to) (deployed stacks)
  --timeout-s <n>   smoke: how long an instance may take to run (default 1800)
  --tag <tag>       upgrade: the npm dist-tag or version (default latest)
  --no-deploy       upgrade: install only`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      env: { type: 'string' },
      'dry-run': { type: 'boolean' },
      email: { type: 'string' },
      inbox: { type: 'string' },
      'timeout-s': { type: 'string' },
      tag: { type: 'string' },
      'no-deploy': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, ...rest] = positionals;
  const dir = process.cwd();
  if (!cmd || values.help) return console.log(USAGE);
  switch (cmd) {
    case 'configure': {
      await writeWranglerConfigs(dir);
      return console.log('wrote wrangler.control.jsonc and wrangler.gate.jsonc');
    }
    case 'setup':
      return (await import('./setup.mjs')).setup(dir, { env: values.env });
    case 'deploy':
      return (await import('./deploy.mjs')).deploy(dir, { env: values.env, dryRun: values['dry-run'] });
    case 'dev':
      return (await import('./dev.mjs')).dev(dir, { env: values.env });
    case 'smoke':
      return smoke(dir, values);
    case 'secrets': {
      const c = await import('./commands.mjs');
      if (rest[0] === 'set') return c.secretsSet(dir, { env: values.env, name: rest[1] });
      return c.secretsStatus(dir, { env: values.env });
    }
    case 'admin':
      return (await import('./commands.mjs')).admin(dir, { env: values.env, email: rest[0] ?? values.email });
    case 'upgrade':
      return (await import('./commands.mjs')).upgrade(dir, { env: values.env, tag: values.tag, deployAfter: !values['no-deploy'] });
    default:
      throw new Error(`unknown command "${cmd}"\n${USAGE}`);
  }
}

/** The smoke against a local environment (mail capture, .dev.vars) or a deployed one (--inbox). */
async function smoke(dir, values) {
  const { runSmoke, devCaptureInbox, moduleInbox } = await import('../smoke/index.mjs');
  const config = await loadConfig(dir);
  const env = values.env ?? (remoteEnvs(config).includes('prod') ? 'prod' : remoteEnvs(config)[0] ?? localEnvs(config)[0]);
  const e = config.environments[env];
  if (!e) throw new Error(`no environment "${env}" in worca.config.ts`);
  let appOrigin = e.appOrigin;
  let suffix = e.instanceOriginSuffix;
  let secrets;
  if (e.local) {
    const app = new URL(e.appOrigin);
    if (process.env.CONTROL_PORT) app.port = process.env.CONTROL_PORT;
    appOrigin = app.origin;
    if (process.env.GATE_PORT) suffix = `:${process.env.GATE_PORT}`;
    secrets = readEnvFile(join(dir, '.dev.vars'));
  } else {
    secrets = readEnvFile(join(dir, env === 'prod' ? '.secrets.env' : `.secrets.${env}.env`));
  }
  const email = values.email ?? process.env.SMOKE_EMAIL ?? (e.local ? 'smoke-admin@example.test' : null);
  if (!email) throw new Error('smoke against a deployed environment: --email (or SMOKE_EMAIL), an address whose mail --inbox can read');
  const inboxFile = values.inbox ?? process.env.SMOKE_INBOX;
  const inbox = inboxFile ? await moduleInbox(join(dir, inboxFile)) : e.local ? devCaptureInbox(appOrigin) : null;
  if (!inbox) throw new Error('smoke against a deployed environment: --inbox ./inbox.mjs (or SMOKE_INBOX), a module exporting getMail(to)');
  console.log(`smoke: ${env} at ${appOrigin} as ${email}`);
  await runSmoke({
    appOrigin,
    instanceOrigin: (host) => `${e.instanceScheme}://${host}${suffix}`,
    email,
    inbox,
    setupToken: secrets.SETUP_TOKEN,
    turnstileBypassToken: process.env.TURNSTILE_BYPASS_TOKEN ?? secrets.TURNSTILE_BYPASS_TOKEN,
    passkeyFile: join(dir, '.wrangler/smoke', `passkey-${new URL(appOrigin).host.replace(/[^a-z0-9.-]/gi, '_')}.json`),
    timeoutMs: Number(values['timeout-s'] ?? process.env.SMOKE_TIMEOUT_S ?? 1800) * 1000,
    mailTimeoutMs: e.local ? 20_000 : 120_000,
    pollMs: e.local ? 500 : 5000,
  });
}

main()
  .then(() => closePrompts())
  .catch((e) => {
    closePrompts();
    console.error(`\nworca-platform: ${e.message}`);
    process.exit(1);
  });
