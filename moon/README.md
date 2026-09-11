# `dsp` — the numeric kernel of atools

MoonBit source for the single numeric implementation behind the audio ↔ spectrogram tool.
It is compiled to `wasm/dsp.wasm` and loaded by both threads of the web app (worker + main).
There is **no JavaScript fallback**: if a host cannot load this module, it must fail loudly
rather than silently switch to a second implementation nobody maintains.

```
moon/            source (this directory)         →  scripts/moon.ts  →  dist/wasm/dsp.wasm
app/lib/dsp.ts   host loader: fetch, handshake, typed-view slicing
```

## Why a kernel at all

1. **One implementation.** The host keeps only the glue: it moves bytes across the boundary.
   Every numeric loop that used to exist twice (once in TS, once here) is gone.
2. **Hot loops are written with `unsafe_get` / `unsafe_set`.** `arr[i]` compiles to two
   non-inlined calls (`check_range` + `array_length`); in a butterfly with 8 accesses that
   made the same algorithm **7× slower** than the JS version. After switching to the unsafe
   accessors it is **1.5× faster** (see `docs/algorithms.md`).
3. **No imports, no `extern`.** `moon.pkg` allows only the standard library, so the same
   source type-checks for `wasm`, `js` and `native` (`bun run moon:ports`).

## Three kinds of memory

| Layer | Lifetime | Where | Notes |
| --- | --- | --- | --- |
| **Plan tables** | process, per window size | `plan.mbt` | read-only: bit-reversal, twiddles, Hann window. Cached by `win`, never moved. |
| **Session slots** | one long computation | `session.mbt` | fixed-size workspace + the plan tables it binds to. Pool of `max_slots` (6) — you must return it. |
| **Job arenas** | one job | `arena.mbt` | a job owns its arrays: one `Double` buffer + one `Byte` segment, addressed by a handle. |

A job arena exists because `memory.grow` **detaches every typed view** the host previously
sliced. Views therefore must never be held: `dsp_job_d` / `dsp_job_b` / `dsp_slot_mem` /
`dsp_plan_*` hand out the array *now*, and the host re-slices after every `await`.

## Layout

| File | Role |
| --- | --- |
| `engine.mbt` | ABI version + the boot-time probe that proves the host/guest addressing convention |
| `plan.mbt` | per-window tables: bit reversal, twiddles, Hann window |
| `session.mbt` | session slot pool |
| `pair.mbt` | two real transforms packed into one complex transform (halves the FFT count of RTISI) |
| `fft.mbt` | complex FFT, inverse, and `real_ifft` (one-sided spectrum → conjugate-symmetric, then inverse) |
| `arena.mbt` | job arenas (variable-size, one per job) |
| `rtisi.mbt` | RTISI-LA phase reconstruction (the whole iterative loop) |
| `pghi.mbt` | PGHI phase initialisation: the magnitude spectrum in, a phase guess out |
| `stub.mbt` | the barcode "stub" at the bottom of a spectrogram: pure integer encode/decode |

Tests live next to the sources: `*_wbtest.mbt` are white-box tests (`bun run test:kernel`),
`*_bench_wbtest.mbt` are kernels-side benchmarks (`bun run bench:kernel`).

## Host boundary

Exactly one convention crosses the language boundary, and it is not documented behaviour of
the toolchain:

> When an exported function returns a `FixedArray`, the integer the host receives **is the
> address of its data area.** The reverse does not hold — a `Float64Array` passed in from the
> host arrives as a bare `i32` and will read out of bounds.

`loadDsp` therefore performs a two-way handshake at boot (`dsp_probe_*`): the kernel writes a
pattern and the host reads it back through two views, then the host writes and the kernel reads
back. If the toolchain ever changes the layout, this fails at startup instead of producing
plausible-but-wrong numbers later. The guest reports **element offsets**, never addresses; the
host adds the base in exactly one place (`app/lib/dsp.ts`'s `jobSlice` / `jobBytes`).

Failure is expressed in return values, never by throwing across the boundary:

- `0` from an `*_open` / `*_fits` / `*_paint` / `*_decode` call = the request was rejected
  (pool full, size illegal, table too short). The host must not proceed.
- `-1` from an offset accessor = invalid slot / handle.
- `dsp_real_ifft` returns `1` when it ran, `0` when it refused.

Exports are grouped by layer: `dsp_abi` · `dsp_probe_*` · `dsp_plan_*` · `dsp_slot_*` ·
`dsp_pair_*` · `dsp_job_*` · `dsp_pghi_*` · `dsp_rtisi_*` · `dsp_stub_*`. Every one of them
carries an English doc comment in the source; `dsp_*` names are the ABI (fixed) while the
MoonBit identifier may be named differently (e.g. `dsp_job_words` ↔ `job_words_of`).

The surface is the ABI: `dsp_abi` is `7`. Anything the host never calls is **not exported** —
`inverse`, `pair_forward` and `pair_inverse` are still the functions RTISI and the benchmarks
call, but they are plain `fn`s now, so a grep for `dsp_` in `app/` and `bench/` is the list.

## Build and verify

```bash
bun run build:wasm       # compile this directory → wasm/dsp.wasm (--force for a full rebuild)
bun run test:kernel      # white-box tests:      moon test  --release --deny-warn --target wasm
bun run bench:kernel     # kernel benchmarks:    moon bench --release --deny-warn --target wasm
bun run moon:ports       # moon check --target js / native  (proves "standard library only")
```

`--deny-warn` is part of the contract: a warning is a piece of code nobody understood. Nothing is
tolerated today, so `moon.pkg` carries no `warn_list`; if something ever has to be, it goes there
as a decision somebody took rather than a silent debt.

`moon fmt` is the formatter of record, the same way it is in `~/.moon/lib/core`: blocks are
separated by `///|`, the order of blocks does not matter, and a formatting pass is therefore
safe to run at any point.

It does strip redundant parentheses, so "this association order matches the reference" cannot be
said with brackets — write it in a comment instead (`plan.mbt`'s twiddle loop does). Note that
the tables are **not** bit-identical to a JS recomputation anyway: `@math.cos` and V8's
`Math.cos` disagree in the last bit on roughly 4% of the points, which is measured in
`docs/algorithms.md` and is far below the precision the encoders store.

## Adding a module

The migration recipe, in this order:

0. **Measure the case, then A/B it in the same round.** Keep the retired implementation in a
   scratch directory (never in the repo), drive both with the same input in the same process, and
   compare **bits before times**. A number rescaled from another measurement is not an A/B: two
   entries in `docs/algorithms.md` were first written that way and both were wrong (PGHI recorded
   as "twice as slow as the JS"; `resample`'s blocker recorded as its phase table).
1. Move the implementation here; the host keeps a single "move the data" call (one `set`).
2. Move the behaviour tests into `<module>_wbtest.mbt`, and keep the *property* they assert
   rather than the numbers of the day (a memo table is bit-identical to computing inline; a
   table is not bit-identical to a JS recomputation — that one belongs in a measurement, not
   in an assertion).
3. Leave the host with nothing numeric — no reference implementation, no fallback branch.
4. Re-export through `dsp_*` with an English doc comment, and bump `dsp_abi` if the export
   surface or its semantics changed.
5. Before moving anything, check its domain against the segment caps (`max_job_words`,
   `max_job_bytes`). Those are sized for **pixels**; a module that works in the **sample**
   domain (`resample` wants `src + dst` in one segment, and a 96 kHz source reaches that cap at
   ~650 s) turns a large input into a hard failure. An arena is only a good home when the data
   already has to be there.
