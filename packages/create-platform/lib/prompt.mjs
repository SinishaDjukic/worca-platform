// Questions on a terminal; flags and environment variables answer them in CI. A copy of
// @worca/platform/cli/prompt.mjs (the scaffolder runs before that package is installed).
import { createInterface } from 'node:readline/promises';

export const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.env.CI !== '1' && process.env.CI !== 'true';

let rl = null;
function lineReader() {
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}
export function closePrompts() {
  rl?.close();
  rl = null;
}

/** Asks once; empty input takes `def`. `validate` returns an error message or null. */
export async function ask(question, { def, validate } = {}) {
  for (;;) {
    const answer = (await lineReader().question(`${question}${def ? ` (${def})` : ''}: `)).trim() || def || '';
    const problem = validate?.(answer);
    if (!problem) return answer;
    console.log(`  ${problem}`);
  }
}

/** A secret value: typed without echo when the terminal allows it. */
export async function askSecret(question) {
  const r = lineReader();
  const out = process.stdout;
  const write = out.write.bind(out);
  let muted = false;
  out.write = (chunk, ...rest) => (muted ? true : write(chunk, ...rest));
  const pending = r.question(`${question}: `);
  muted = true;
  try {
    return (await pending).trim();
  } finally {
    muted = false;
    out.write = write;
    write('\n');
  }
}

export async function confirm(question, def = false) {
  const a = (await ask(`${question} [${def ? 'Y/n' : 'y/N'}]`)).toLowerCase();
  return a ? a.startsWith('y') : def;
}
