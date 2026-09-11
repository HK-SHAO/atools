// The kernel's own benchmarks: `moon bench --target wasm` runs the wasm artifact directly. They
// measure how fast the kernel code itself is, excluding the JS↔wasm boundary and host copying;
// for the comparison against the TS reference see the equivalence gates in app/lib/*.test.ts and
// the microbenchmark table in docs/algorithms.md.

///|
/// The harness's own floor: one closure call plus one `keep` (to defeat dead-code elimination).
///
/// Its purpose is to **separate framework overhead from engine differences**. The
/// `moon bench --target wasm` artifact runs under `moonrun` (linked `-wasi`, exporting the
/// test-driver entry), whereas the host runs V8 — two runtimes should not read the same wasm
/// identically. Measured on a 512-point transform: 3.98 µs inside the framework, 2.83 µs in V8
/// calling the same export directly; if this floor were only tens of nanoseconds, that 1.4×
/// would have to be engine-side.
test "bench harness floor" (it : @bench.T) {
  let s = open_fft(512, noise_array(512, 1))
  let arena = slot_mem.unsafe_get(s)
  it.bench(name="harness-noop", fn() { it.keep(arena.unsafe_get(0)) })
  slot_close(s)
}

///|
test "bench single in-place FFT" (it : @bench.T) {
  for win in probe_wins {
    let src = noise_array(win, 0x9e3779b9 + win)
    let s = open_fft(win, src)
    it.bench(name="forward-\{win}", fn() {
      fill_fft(s, win, src)
      forward(s)
      it.keep(slot_mem.unsafe_get(s).unsafe_get(0))
    })
    it.bench(name="inverse-\{win}", fn() {
      fill_fft(s, win, src)
      inverse(s)
      it.keep(slot_mem.unsafe_get(s).unsafe_get(0))
    })
    // Factoring "fill" out of the reading: the names above include one `fill_fft` (win reads +
    // win writes) while host-side microbenchmarks usually time only the transform. Mixing them
    // makes copy overhead look like "the toolchain is one tier slower" — measured 1.5 µs at 512
    // points and 14 µs at 4096, exactly this step's magnitude. The paired triple
    // (fill / forward-alone / forward) satisfies forward ≈ fill + forward-alone.
    it.bench(name="fill-\{win}", fn() {
      fill_fft(s, win, src)
      it.keep(src.unsafe_get(0))
    })
    it.bench(name="forward-alone-\{win}", fn() {
      forward(s)
      it.keep(slot_mem.unsafe_get(s).unsafe_get(0))
    })
    slot_close(s)
  }
}

///|
test "bench paired two-real transform" (it : @bench.T) {
  for win in probe_wins {
    let s = slot_open(win)
    let arena = slot_mem.unsafe_get(s)
    let y1 = noise_array(win, 0x9e3779b9 + win)
    let y2 = noise_array(win, 0x85ebca6b + win)
    let x1 = pair_off(4, win)
    let x2 = pair_off(5, win)
    let load = fn() {
      for i = 0; i < win; i = i + 1 {
        arena.unsafe_set(x1 + i, y1.unsafe_get(i))
        arena.unsafe_set(x2 + i, y2.unsafe_get(i))
      }
    }
    it.bench(name="pair-forward-\{win}", fn() {
      load()
      pair_forward(s)
      it.keep(arena.unsafe_get(pair_off(0, win)))
    })
    it.bench(name="pair-inverse-\{win}", fn() {
      load()
      pair_inverse(s)
      it.keep(arena.unsafe_get(x1))
    })
    slot_close(s)
  }
}
