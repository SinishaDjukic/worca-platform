// Writes .dev.vars with fresh local secrets for both Workers (they share the project directory).
// Never used outside local development. Refuses to overwrite unless --force. --out <file> writes
// elsewhere. The keys come from the CLI's generator (packages/platform/cli/keys.mjs).
import { existsSync, writeFileSync } from 'node:fs';
import { generateSecrets } from '../packages/platform/cli/keys.mjs';
import { resolve } from 'node:path';

const outAt = process.argv.indexOf('--out');
const path = outAt > 0 ? resolve(process.argv[outAt + 1]) : new URL('../.dev.vars', import.meta.url);
if (existsSync(path) && !process.argv.includes('--force')) {
  console.log(`${path} exists; pass --force to replace it`);
  process.exit(0);
}
const lines = await generateSecrets(undefined, { kidPrefix: 'dev' });
writeFileSync(path, Object.entries(lines).map(([k, v]) => `${k}='${v}'`).join('\n') + '\n', { mode: 0o600 });
console.log(`wrote ${path}`);
