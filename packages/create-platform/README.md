# @worca/create-platform

Writes a deployment of [`@worca/platform`](https://www.npmjs.com/package/@worca/platform):

```sh
npm create @worca/platform my-platform
cd my-platform
npm run dev      # the local stack with fake providers
npm run setup    # Cloudflare resources, secrets and the first deploy
```

It asks for the deployment's name, the console origin, the instance domain, Cloudflare account
and zone ids, the compute provider, the mail sender and the optional modules. Every question
also takes a flag or an environment variable, and `--yes` never asks (for CI):
`npm create @worca/platform -- --help` lists them.

It refuses a folder that isn't empty, unless it is a deployment already: then `--repair` writes
only its missing files. It also refuses to run inside a checkout of the platform's own repository.

The guide: `docs/deploy.md` in https://github.com/SinishaDjukic/worca-platform. Released together
with `@worca/platform`, same version: `create-platform@x` writes deployments of `platform@^x`.
