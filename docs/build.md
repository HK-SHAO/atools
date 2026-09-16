# Build and Run

## Toolchain

Bun installs dependencies and runs TypeScript, tests, the dev server, and the production build; MoonBit compiles the numeric kernel only.

```sh
bun install --frozen-lockfile
bun dev
bun run typecheck
bun run lint
bun run test
bun run test:kernel
bun run build:web
```

The server listens on `http://127.0.0.1:3000` by default; `PORT` changes it. MoonBit is located through `MOON`, `PATH`, or `~/.moon/bin`. The gate scripts (`bun run offline`, `bun run ui`) start their own servers against `dist/`, and deployment is `bun run deploy`.

## Production build

`scripts/build.ts` runs two Bun builds in dependency order:

1. `index.html` → the app, CSS, and the on-demand audio decoders; in the same build `scripts/worker-plugin.ts` answers the `./pipeline.worker.ts?worker&url` import and emits the Worker plus the Wasm into the `dist/` root under content hashes.
2. `sw.ts` → `sw.js` with the app shell manifest and content fingerprint injected.

App code declares the Worker as `import workerUrl from "./pipeline.worker.ts?worker&url"`, with the URL injected by the plugin, so dev and build share one form. The build rejects missing shell files, a Worker the entry never references by relative URL, an uninjected Service Worker manifest, and any Wasm kernel handshake that reaches the app output (the main thread holds no numerics, see docs/architecture.md).

Audio decoders and the demo audio download on demand and land in the runtime cache; they are not part of the first offline app shell. Full responsibilities and gates are in [architecture.md](architecture.md).

`app/public/_headers` is copied verbatim to `dist/_headers` (response headers for Cloudflare's static assets) and sets only Referrer-Policy, X-Content-Type-Options, and Permissions-Policy. **There is no CSP**: the Google Analytics gtag script and the beacon Cloudflare Web Analytics injects (an external loader plus an inline bootstrap) both fall outside `'self'`, so a CSP would have to degrade to `'unsafe-inline'` plus a domain allowlist and would constrain nothing.

## Dev server

`app/index.ts` is the dev server entry, and `bun dev` runs it directly (Bun HTML routes plus HMR). Worker builds and routes come from `scripts/worker-plugin.ts` (registered through bunfig `[serve.static]`): requesting the Worker entry rebuilds it from source, and changes under `moon/` rebuild the kernel (`watchKernel` in `scripts/moon.ts`). The dev environment registers no Service Worker.

## Offline and updates

The first install caches the app shell. A new version activates only after the old page closes, so a running conversion is never interrupted, and activation deletes only old caches of the current deployment path.

Navigations prefer the network and fall back to the current version's home page when offline; other same-origin GET requests prefer the current version's cache. Successful non-HTML responses may enter the runtime cache, and Range requests are never cached. Caches of different deployment paths neither read nor clear one another.

`bun run offline` verifies installation, the waiting update, cache isolation, the runtime cache, and a reload after the server is gone. `bun run ui` verifies the main interactions; `UI_BASELINE=/path/to/old/dist bun run ui` compares two builds.

## Browser baseline

**Chrome / Edge 108+ · Firefox 128+ · Safari 16.4+**

The hard requirements are WebAssembly SIMD, module Workers, OffscreenCanvas, CompressionStream / DecompressionStream, container queries, container-relative units, and `@property`. Firefox 128 is the first with complete `@property` support and Safari 16.4 the first with the Wasm SIMD instructions used here; Chrome 108 guarantees dynamic viewport units, and the other hard requirements land earlier.

The automated gates use the local Chrome. Chromium 152 and WebKit 26.6 have both run the real `dist/`; the Firefox baseline comes from feature support and has no end-to-end run on hardware yet.
