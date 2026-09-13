# `dsp` MoonBit kernel

This package is the numeric kernel for atools. Bun compiles it to `moon/_build/wasm/release/build/dsp.wasm`; the pipeline Worker is its only browser consumer. There is no JavaScript fallback or WASI dependency.

## Responsibilities

| File | Role |
| --- | --- |
| `engine.mbt` | ABI version and host-memory handshake |
| `plan.mbt` | Cached FFT tables |
| `session.mbt` | Fixed FFT workspace pool |
| `pair.mbt` | Two real transforms in one complex transform |
| `fft.mbt` | Complex FFT and one-sided real inverse |
| `arena.mbt` | Variable-size job memory |
| `pghi.mbt` | PGHI phase initialization |
| `rtisi.mbt` | RTISI-LA phase reconstruction |
| `stub.mbt` | Image metadata strip codec |

White-box tests live in `*_wbtest.mbt`; kernel benchmarks live in `*_bench_wbtest.mbt`.

## Host ABI

`app/lib/dsp.ts` is the only host binding. Every `#export_name` function has a concise English doc comment and a stable `dsp_*` name. Change `dsp_abi` whenever an export or its semantics changes.

An exported `FixedArray` reaches JavaScript as the address of its data. The startup probe verifies this toolchain convention in both directions before useful work begins. The guest returns element offsets; the host converts them to byte addresses in one place.

Failures use values across the boundary:

- `0` from open, fit, paint, or decode rejects the request.
- `-1` from an offset accessor means an invalid handle.
- Boolean operations return `1` or `0`.

The host compares `WebAssembly.Module.exports` with its `Kernel` interface at startup, so an incomplete or stale module fails before processing user data.

## Memory

| Storage | Lifetime | Rule |
| --- | --- | --- |
| Plan | Process, per window size | Read-only and cached |
| Slot | One transform session | Pool of six; always release |
| Arena | One PGHI, RTISI, or stub job | Owns one double and one byte segment |

Opening any of these may grow linear memory and detach existing typed arrays. Host views are therefore temporary: obtain them after allocation and obtain them again after every `await`.

Hot loops use unchecked array access only where Plan, Slot, or Arena capacity proves the index range. White-box tests cover FFT round trips, Parseval, supported shapes, handle reuse, and rejection paths.

## Engineering rules

- Prefer the MoonBit standard library and keep `extern` out of the package.
- Keep one numeric implementation; do not retain a host fallback.
- Move work into the kernel only when its data already belongs in kernel memory and same-round benchmarks show a worthwhile gain.
- Preserve operation order when PGHI or short-window RTISI is involved; tiny floating-point changes may select a different valid phase solution.
- Compare exact paths bitwise. Compare phase reconstruction over a distribution of inputs.
- Add or change exports only with their host binding, ABI version, English doc comment, and boundary test.

## Build and verify

```sh
bun run build:wasm
bun run test:kernel
bun run bench:kernel
bun run moon:ports
moon fmt --check
```

`test:kernel` and the production build use `--release --deny-warn --target wasm`. `moon:ports` checks JavaScript and native targets to keep the source limited to the standard library. End-to-end quality and performance commands are documented in [bench/README.md](../bench/README.md).
