// prepack: LICENSE, NOTICE and THIRD_PARTY_NOTICES.md live at the repo root; npm pack only takes
// files inside the package, so copy them in (gitignored). A file missing at the root is skipped.
import { copyFileSync, existsSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
  const from = new URL(name, root);
  if (existsSync(from)) copyFileSync(from, new URL(name, `file://${process.cwd()}/`));
  else console.warn(`copy-legal: no ${name} at the repo root`);
}
