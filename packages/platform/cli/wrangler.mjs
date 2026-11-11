// Every wrangler call of the CLI goes through here. WORCA_WRANGLER names another program (a .mjs/.js
// file runs with node), which is how the tests put a recording fake in wrangler's place.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function wranglerCommand(cwd) {
  const override = process.env.WORCA_WRANGLER;
  if (override) return /\.(m?js)$/.test(override) ? [process.execPath, [override]] : [override, []];
  const local = join(cwd, 'node_modules/.bin/wrangler');
  return [existsSync(local) ? local : 'wrangler', []];
}

/**
 * Runs wrangler with `args` in `cwd`. `input` goes to stdin (secrets travel this way, never as
 * arguments or files). `capture`: collect stdout/stderr instead of showing them. Resolves to
 * { code, stdout, stderr }; never rejects on a non-zero exit (callers decide).
 */
export function wrangler(args, { cwd, input, capture = false, env = {} } = {}) {
  const [cmd, pre] = wranglerCommand(cwd);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...pre, ...args], {
      cwd,
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', ...env },
      stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
      child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    }
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
  });
}

/** wrangler, failing with its output when it exits non-zero. */
export async function wranglerOk(args, opts = {}) {
  const res = await wrangler(args, opts);
  if (res.code !== 0) {
    const detail = `${res.stderr}\n${res.stdout}`.trim().split('\n').slice(-15).join('\n');
    throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed (exit ${res.code})${detail ? `:\n${detail}` : ''}`);
  }
  return res;
}

/** The first JSON value (array or object) in wrangler's output; it may print banners around it. */
export function parseJsonOutput(text) {
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error(`no JSON in wrangler output: ${text.slice(0, 200)}`);
  const close = text[start] === '[' ? ']' : '}';
  for (let end = text.lastIndexOf(close); end > start; end = text.lastIndexOf(close, end - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  throw new Error(`could not parse wrangler JSON output: ${text.slice(0, 200)}`);
}
