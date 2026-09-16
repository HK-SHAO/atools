# Cloudflare deployment (atools)

A pure static assets deployment: no Worker source, no main, no bindings.
`assets.directory` in `wrangler.jsonc` points at `../dist` (produced by `bun run build:web` in the repository root), resolved relative to this directory;
`not_found_handling: single-page-application` provides the fallback route. The app is a single page with no server-side logic.

## Commands

| Command | Purpose |
|---|---|
| `bun run deploy` (repository root) | build:web → `wrangler deploy` |
| `bunx wrangler deploy --config cloudflare/wrangler.jsonc` | deploy only (dist must already be built) |

The first run needs `bunx wrangler login`. `workers_dev` is on by default, so a deployment gets a `*.workers.dev` domain;
set `workers_dev: false` and configure routes once a custom domain is attached.

## Notes

- `upload_source_maps: false` is deliberate: turning on sourcemaps in the build would upload the source publicly
- wrangler is pulled on demand through `bunx` and stays out of dependencies and bun.lock; pin the version in the script when a breaking upgrade lands (for example `bunx wrangler@^4`)
- no bindings, so `wrangler types` is unnecessary
