// npm run pack:platform: builds @worca/platform and packs it (prepack builds dist/ and copies
// LICENSE/NOTICE), for trying a change on a real deployment before it is released:
//   npm i <printed path>   in the deployment, then deploy its dev environment.
// Publishes nothing (docs/RELEASING.md, "Trying a change before a release").
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dest = join(root, '.packs');
mkdirSync(dest, { recursive: true });
const out = execFileSync('npm', ['pack', '--json', '--pack-destination', dest], { cwd: join(root, 'packages/platform'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const [info] = JSON.parse(out.slice(out.indexOf('[')));
console.log(join(dest, info.filename));
