// packages/platform/scripts/brand-assets.mjs: a deployment's branding/ over the platform's ui/ (docs/branding.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRANDING_FILES, buildAssets } from '../../packages/platform/scripts/brand-assets.mjs';

const UI = new URL('../../packages/platform/ui', import.meta.url).pathname;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'brand-assets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('without branding the output is the platform ui', (t) => {
  const out = join(scratch(t), 'out');
  assert.deepEqual(buildAssets({ ui: UI, branding: undefined, out }), []);
  assert.deepEqual(readFileSync(join(out, 'index.html')), readFileSync(join(UI, 'index.html')));
  assert.deepEqual(readFileSync(join(out, 'assets/favicon.png')), readFileSync(join(UI, 'assets/favicon.png')));
  assert.equal(existsSync(join(out, 'README.md')), false);
});

test('branding files replace their assets, mail logos keep their old paths', (t) => {
  const dir = scratch(t);
  const branding = join(dir, 'branding');
  mkdirSync(branding);
  writeFileSync(join(branding, 'favicon.png'), PNG);
  writeFileSync(join(branding, 'mail-logo-light.png'), PNG);
  writeFileSync(join(branding, 'theme.css'), ':root{--ink:#0B3D2E}');
  writeFileSync(join(branding, 'README.md'), 'notes');
  const out = join(dir, 'out');
  assert.deepEqual(buildAssets({ ui: UI, branding, out }).sort(), ['favicon.png', 'mail-logo-light.png', 'theme.css']);
  assert.deepEqual(readFileSync(join(out, 'assets/favicon.png')), PNG);
  assert.deepEqual(readFileSync(join(out, 'assets/mail/worca-logo-light.png')), PNG);
  assert.equal(readFileSync(join(out, 'assets/theme.css'), 'utf8'), ':root{--ink:#0B3D2E}');
  // Untouched defaults stay.
  assert.deepEqual(readFileSync(join(out, 'assets/mail/worca-logo-dark.png')), readFileSync(join(UI, 'assets/mail/worca-logo-dark.png')));
  // A second build replaces its own output.
  assert.doesNotThrow(() => buildAssets({ ui: UI, branding, out }));
});

test('every mapped target exists in the platform ui', () => {
  for (const target of Object.values(BRANDING_FILES)) assert.ok(existsSync(join(UI, target)), target);
});

test('refuses unknown files, non-PNG images and a foreign output folder', (t) => {
  const dir = scratch(t);
  const branding = join(dir, 'branding');
  mkdirSync(branding);
  writeFileSync(join(branding, 'logo.png'), PNG);
  assert.throws(() => buildAssets({ ui: UI, branding, out: join(dir, 'a') }), /branding\/logo\.png is not one of/);
  rmSync(join(branding, 'logo.png'));
  writeFileSync(join(branding, 'favicon.png'), 'not a png');
  assert.throws(() => buildAssets({ ui: UI, branding, out: join(dir, 'b') }), /not a PNG/);
  rmSync(join(branding, 'favicon.png'));
  const foreign = join(dir, 'foreign');
  mkdirSync(foreign);
  writeFileSync(join(foreign, 'keep.txt'), 'mine');
  assert.throws(() => buildAssets({ ui: UI, branding, out: foreign }), /refusing to replace it/);
  assert.equal(readFileSync(join(foreign, 'keep.txt'), 'utf8'), 'mine');
  assert.throws(() => buildAssets({ ui: UI, branding, out: join(UI, 'x') }), /outside --ui/);
});
