# Architecture

atools is a browser-local audio ↔ spectrogram tool: a static PWA with no backend, database, or accounts. The format contract is in [format-spec.md](format-spec.md), algorithmic trade-offs in [algorithms.md](algorithms.md), and building and deployment in [build.md](build.md).

## Data flow

```text
file ─┬─ audio → decode on the main thread ────┐
      └─ image → identify container ───┐       │
                                       ▼       ▼
                                 Pipeline Worker
                                 ├ resample and spectrogram encode
                                 ├ image encode/decode and audit
                                 ├ phase reconstruction and waveform synthesis
                                 └ MoonBit Wasm kernel
                                       │
                                       ▼
                                 playback and interaction
```

The main thread keeps only file input, audio decoding, playback, and the DOM. Headless-friendly heavy work lives in the Worker, which is the only side in the browser that loads the Wasm kernel.

## Boundaries

**Worker protocol.** `app/ui/pipeline.ts` defines requests, responses, cancellation, and scopes. The Worker runs heavy jobs serially through a single-flight queue, and cancelled queued jobs never reach the kernel, so several DSP work areas cannot contend for memory. Returned array buffers transfer ownership; input PCM the main thread still needs for playback stays usable. A Worker crash rejects every pending request and drops the instance, and the next request reconnects.

**Wasm ABI.** `app/lib/dsp.ts` is the single host binding. At startup it checks the ABI version, the export set, and linear-memory reads and writes. Creating a Plan, Slot, or Job can trigger `memory.grow`, so array views are taken on demand and never held across an `await`.

**Capacity.** The kernel reports Plan, Slot, and Job addresses and capacities; the host does not copy the memory layout. Exhausted pools or invalid shapes are rejected by return value. Audio is capped at 8 million samples; images are additionally bounded by 16 million output pixels, 24 million input pixels, 65535 per side, and a 64 MiB PNG input. PNG structure, CRC, dimensions, and expected decompressed size are validated before decompression, and the sample count declared in the metadata must not exceed what the frames cover.

**PWA cache.** The Service Worker cache name includes the deployment path and a content fingerprint of the app shell. An update clears only old versions of the same path; other subpaths and other apps' caches are untouched.

**Language.** `app/lib/i18n.ts` is a dependency-free leaf: it picks `en` or `zh` from `navigator.languages` once at load, holds both dictionaries, and exports `t()`. The markup ships English (`<html lang="en">`, title, description, manifest), and `applyHead()` in `app/frontend.tsx` switches `lang` and `title` for Chinese clients. Both the main thread and the Worker read the same module, so copy produced inside the Worker follows the client language too.

## Layout

| Path | Responsibility |
| --- | --- |
| `app/lib/` | audio, spectrum, images, PNG, metrics, kernel binding, copy tables |
| `app/ui/` | React interaction, Worker client, and Worker entry |
| `app/styles/` | reset, tokens, base controls, page layout, and the About dialog |
| `app/sw.ts` | Service Worker with no third-party runtime |
| `moon/` | MoonBit numeric kernel and white-box tests |
| `bench/` | quality, performance, browser, and offline gates |
| `scripts/` | Bun build, dev server, and the MoonBit driver |

## Gates

| Command | Boundary it holds |
| --- | --- |
| `bun run typecheck` / `bun run lint` | TypeScript and React static rules |
| `bun run test` | format, algorithms, decoding, and the Wasm host boundary |
| `bun run test:kernel` | FFT, memory pools, PGHI, RTISI, and the parameter ticket |
| `bun run quality -- --gate` | reconstruction quality on deterministic material |
| `bun run kernel` | the full numeric chain below `0.05×` real time |
| `bun run perf` | the resampling cache must beat a per-sample computation |
| `bun run build:web` | flat output, complete shell, SW injection, no kernel on the main thread |
| `bun run ui` | demo, playback, verify, fine render, exact mode, Advanced, About dialog, and 320-wide narrow screens |
| `bun run offline` | install, update, cache isolation, and reload with the network gone |

`SUBPATH=/path bun run ui` verifies a subpath deployment; `UI_BASELINE=/old/dist bun run ui` compares two builds. The evaluation method for real material through PNG, JPEG, and resizing is in [bench/README.md](../bench/README.md).
