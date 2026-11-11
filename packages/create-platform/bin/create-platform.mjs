#!/usr/bin/env node
// npm create @worca/platform my-deploy: writes a deployment of @worca/platform (lib/scaffold.mjs).
import { parseArgs } from 'node:util';
import { closePrompts } from '../lib/prompt.mjs';
import { main } from '../lib/scaffold.mjs';

main(process.argv.slice(2), { parseArgs })
  .then((code) => {
    closePrompts();
    process.exitCode = code;
  })
  .catch((e) => {
    closePrompts();
    console.error(`\ncreate-platform: ${e.message}`);
    process.exit(1);
  });
