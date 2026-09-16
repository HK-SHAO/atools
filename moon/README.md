# `dsp`

A spectral DSP kernel written in MoonBit and compiled to WebAssembly. It is the numeric core of [atools](https://github.com/HK-SHAO/atools)' audio ↔ spectrogram conversion: FFT analysis and synthesis, and reconstruction from a magnitude-only spectrum.

- Live demo: <https://atools.shao.fun/>
- Source: <https://github.com/HK-SHAO/atools>
- Documentation: <https://github.com/HK-SHAO/atools/tree/main/docs>

## Functionality

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

White-box tests live in `*_wbtest.mbt`, benchmarks in `*_bench_wbtest.mbt`.

## Host ABI

Exports are stable `dsp_*` functions; bump `dsp_abi` whenever an export or its semantics changes. Failures cross the boundary as values: `0` rejects a request, `-1` marks an invalid handle, booleans are `1`/`0`.

An exported `FixedArray` reaches the host as the address of its data. The startup probe verifies this convention in both directions before useful work begins, and the host checks `WebAssembly.Module.exports` against its kernel interface, so a stale module fails before processing user data.

## Memory

| Storage | Lifetime | Rule |
| --- | --- | --- |
| Plan | Process, per window size | Read-only and cached |
| Slot | One transform session | Pool of six; always release |
| Arena | One PGHI, RTISI, or stub job | Owns one double and one byte segment |

Opening any of these may grow linear memory and detach existing host views: obtain views after each allocation, and again after an `await`. Hot loops use unchecked access only where Plan, Slot, or Arena capacity proves the index range. In release builds, checked indexing on the kernel's non-provable index patterns measures 2–3× slower for reads and writes, and white-box tests cover each unchecked loop.

## Rules

- Keep the source on the MoonBit standard library alone: no `extern`, no host fallback, one numeric implementation.
- Preserve operation order around PGHI and short-window RTISI; tiny floating-point changes may select a different valid phase solution. Compare exact paths bitwise, and phase reconstruction over a distribution of inputs.
- Add or change exports only together with an ABI bump, a doc comment, and a boundary test.

## Build and verify

In this directory:

```sh
moon build --release --deny-warn --target wasm
moon test --release --deny-warn --target wasm
moon bench --release --deny-warn --target wasm
moon check --deny-warn --target js
moon check --deny-warn --target native
moon fmt --check
```
