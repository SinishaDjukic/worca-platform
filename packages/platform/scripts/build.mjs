// Builds dist/ (tsc -p tsconfig.build.json) and gives every relative import in it an explicit .js
// specifier, so dist/ doesn't depend on a bundler resolving extensionless or directory imports.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const dist = join(pkg, 'dist');
rmSync(dist, { recursive: true, force: true });
const tsc = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url));
execFileSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.build.json')], { stdio: 'inherit' });

const SPEC = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]*)\2/g;
function fix(file) {
  const dir = dirname(file);
  const text = readFileSync(file, 'utf8');
  // Line by line, so example code in comments (`// import … from '../worca.config'`) stays as is.
  const out = text.split('\n').map((line) => /^\s*(\/\/|\*|\/\*)/.test(line) ? line : line.replace(SPEC, (all, lead, q, spec) => {
    if (/\.(m?js|json)$/.test(spec)) return all;
    const abs = resolve(dir, spec);
    if (existsSync(`${abs}.js`)) return `${lead}${q}${spec}.js${q}`;
    if (existsSync(join(abs, 'index.js'))) return `${lead}${q}${spec}/index.js${q}`;
    throw new Error(`build: can't resolve ${spec} in ${file}`);
  })).join('\n');
  if (out !== text) writeFileSync(file, out);
}
(function walk(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js') || p.endsWith('.d.ts')) fix(p);
  }
})(dist);
console.log(`built ${dist}`);
