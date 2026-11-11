#!/usr/bin/env node
// A recording stand-in for wrangler, for the CLI tests (WORCA_WRANGLER points here). Keeps an
// account's D1 databases, KV namespaces, Workers and their secrets in FAKE_WRANGLER_STATE (JSON) and
// appends every call to it, answering in wrangler's output shapes. Secret values arrive on stdin
// and are stored, never logged in `calls`.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const STATE = process.env.FAKE_WRANGLER_STATE;
if (!STATE) {
  console.error('FAKE_WRANGLER_STATE is not set');
  process.exit(2);
}
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { d1: [], kv: [], workers: {}, calls: [] };
const args = process.argv.slice(2);
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const stdin = () => {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
};
/** The Worker a -c/--env pair names (the env's name in the jsonc config). */
const workerName = () => {
  const text = readFileSync(opt('-c'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const cfg = JSON.parse(text);
  return cfg.env?.[opt('--env')]?.name ?? cfg.name;
};
const notFound = (name) => {
  console.error(`✘ [ERROR] A request to the Cloudflare API failed.\n  This Worker does not exist on your account. [code: 10007] (${name})`);
  save();
  process.exit(1);
};

const call = { args: [...args] };
state.calls.push(call);
const [a, b, c] = args;

if (a === 'whoami') {
  console.log('You are logged in with an OAuth Token, associated with the email fake@example.test.');
} else if (a === 'd1' && b === 'list') {
  console.log(JSON.stringify(state.d1.map((d) => ({ uuid: d.uuid, name: d.name, created_at: d.created_at, version: 'production' }))));
} else if (a === 'd1' && b === 'create') {
  const uuid = randomUUID();
  state.d1.push({ name: c, uuid, created_at: new Date().toISOString() });
  console.log(`✅ Successfully created DB '${c}' in region WEUR\n{\n  "d1_databases": [{ "binding": "DB", "database_name": "${c}", "database_id": "${uuid}" }]\n}`);
} else if (a === 'kv' && b === 'namespace' && c === 'list') {
  console.log(JSON.stringify(state.kv, null, 2));
} else if (a === 'kv' && b === 'namespace' && c === 'create') {
  const id = randomUUID().replace(/-/g, '');
  state.kv.push({ id, title: args[3], supports_url_encoding: true });
  console.log(`🌀 Creating namespace with title "${args[3]}"\n✨ Success!\n{ "kv_namespaces": [{ "binding": "${args[3]}", "id": "${id}" }] }`);
} else if (a === 'secret' && b === 'list') {
  const name = workerName();
  if (!state.workers[name]) notFound(name);
  console.log(JSON.stringify(Object.keys(state.workers[name].secrets).map((n) => ({ name: n, type: 'secret_text' }))));
} else if (a === 'secret' && b === 'bulk') {
  const name = workerName();
  const values = JSON.parse(stdin());
  call.keys = Object.keys(values);
  if (!state.workers[name]) notFound(name);
  Object.assign(state.workers[name].secrets, values);
  console.log(`✨ ${call.keys.length} secrets successfully uploaded`);
} else if (a === 'secret' && b === 'put') {
  const name = workerName();
  const value = stdin().trim();
  call.keys = [c];
  state.workers[name] ??= { secrets: {}, deploys: 0 };
  state.workers[name].secrets[c] = value;
  console.log(`✨ Success! Uploaded secret ${c}`);
} else if (a === 'd1' && b === 'migrations' && c === 'apply') {
  if (!args.includes('--remote')) {
    console.error('fake wrangler: only --remote migrations are recorded');
    process.exit(2);
  }
  console.log(`Migrations to be applied: (fake)\n✅ ${args[3]} migrations applied`);
} else if (a === 'deploy') {
  if (args.includes('--dry-run')) {
    console.error('fake wrangler: use the real wrangler for --dry-run');
    process.exit(2);
  }
  const name = workerName();
  state.workers[name] ??= { secrets: {}, deploys: 0 };
  state.workers[name].deploys += 1;
  console.log(`Uploaded ${name}\nDeployed ${name} triggers\nCurrent Version ID: ${randomUUID()}`);
} else {
  console.error(`fake wrangler: unsupported command: ${args.join(' ')}`);
  save();
  process.exit(2);
}
save();
