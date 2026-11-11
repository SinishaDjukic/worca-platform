#!/usr/bin/env node
// Builds a deployment's console assets: the platform's ui/ with the deployment's branding/ files
// copied over it (docs/branding.md). Wrangler serves one assets directory, so a deployment that
// brings its own logo, favicon, mail logo or colours points `assets.directory` at the output of
// this script (the scaffolder wires it up as the Worker's build step); a deployment without a
// branding/ folder can point at ui/ directly.
//
//   node scripts/brand-assets.mjs --ui <platform ui dir> --branding <branding dir> --out <dir>
//
// The output directory is replaced on every run, but only when it is empty, missing, or was
// written by this script before (it carries a marker file), so a wrong --out can't wipe a folder.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** branding/<file> → its place under the assets directory. Old mail links the mail logos' paths. */
export const BRANDING_FILES = Object.freeze({
  'logo-mask.png': 'assets/worca-logo-mask.png',
  'mark-mask.png': 'assets/worca-mark-mask.png',
  'favicon.png': 'assets/favicon.png',
  'mail-logo-light.png': 'assets/mail/worca-logo-light.png',
  'mail-logo-dark.png': 'assets/mail/worca-logo-dark.png',
  'theme.css': 'assets/theme.css',
});
/** Files a branding/ folder may also hold that aren't console assets. */
const IGNORED = new Set(['README.md', '.DS_Store']);
const MARKER = '.brand-assets';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Copies ui → out, then the branding files over it. Returns the branding files it used. */
export function buildAssets({ ui, branding, out }) {
  ui = resolve(ui);
  out = resolve(out);
  if (!existsSync(join(ui, 'index.html'))) throw new Error(`brand-assets: ${ui} has no index.html (not the platform's ui/ folder)`);
  if (out === ui || out.startsWith(`${ui}/`) || ui.startsWith(`${out}/`)) throw new Error('brand-assets: --out must be outside --ui');
  const used = [];
  const files = branding && existsSync(branding) ? readdirSync(branding).filter((f) => !IGNORED.has(f)) : [];
  for (const f of files) {
    if (!(f in BRANDING_FILES)) throw new Error(`brand-assets: branding/${f} is not one of ${Object.keys(BRANDING_FILES).join(', ')}`);
    const path = join(branding, f);
    if (!statSync(path).isFile()) throw new Error(`brand-assets: branding/${f} is not a file`);
    if (f.endsWith('.png') && !readFileSync(path).subarray(0, 8).equals(PNG)) throw new Error(`brand-assets: branding/${f} is not a PNG`);
  }
  if (existsSync(out)) {
    const entries = readdirSync(out);
    if (entries.length && !entries.includes(MARKER)) throw new Error(`brand-assets: ${out} is not empty and wasn't written by this script; refusing to replace it`);
    rmSync(out, { recursive: true, force: true });
  }
  mkdirSync(out, { recursive: true });
  cpSync(ui, out, { recursive: true, filter: (src) => !src.endsWith('/README.md') });
  for (const f of files) {
    const dest = join(out, BRANDING_FILES[f]);
    mkdirSync(join(dest, '..'), { recursive: true });
    cpSync(join(branding, f), dest);
    used.push(f);
  }
  writeFileSync(join(out, MARKER), 'Written by @worca/platform scripts/brand-assets.mjs; replaced on every build.\n');
  return used;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ui = arg('ui');
  const out = arg('out');
  if (!ui || !out) {
    console.error('usage: brand-assets.mjs --ui <platform ui dir> --branding <branding dir> --out <dir>');
    process.exit(2);
  }
  try {
    const used = buildAssets({ ui, branding: arg('branding'), out });
    console.log(`brand-assets: ${out} (${used.length ? `branding: ${used.join(', ')}` : 'no branding files, platform defaults'})`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
