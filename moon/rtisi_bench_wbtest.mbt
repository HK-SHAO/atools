// Kernel-side benchmark: `moon bench --target wasm` runs the wasm artifact itself.
//
// RTISI-LA is the only hot path in the chain (78% of the inverse stage, about 80% of that being
// the FFT itself; see docs/algorithms.md). This measures per-frame advancement — data movement,
// opening the job area and the finish-step normalization are all outside it, and each of those
// happens either once per frame or once in total.
//
// The shape is the one from the profile: 8 s at 8 kHz, win 512, 501 frames, iters 8.
//
// Absolute numbers are NOT real-world timings. The artifact built by `moon bench --target wasm`
// runs under `moonrun` (linked with `-wasi`, exporting the test-driver entry), while the host
// runs V8 — two runtimes measure the same wasm differently, and by how much depends on whether
// the code uses `v128`. See the attribution table in docs/algorithms.md.
//
// So this benchmark is a regression anchor within one runtime. Statements like "the kernel is N×
// faster than TS" must come from the host-side A/B in bench/kernel.ts.

///|
/// `out` is cleared before each round: otherwise it accumulates across rounds (the values do not
/// change the instruction count, but the reading no longer describes the same working set).
/// Clearing costs 2% here, and advancing 7 frames per chunk is bit-identical to one pass at 0.2%
/// difference — both measured.
test "bench RTISI-LA per-frame advancement (501 frames / win 512 / iters 8)" (
  it : @bench.T,
) {
  let fx = make_fx(501, 512, 128, 440.0)
  let h = rtisi_open(
    fx.frames,
    fx.bins,
    fx.win,
    fx.hop,
    fx.samples,
    8,
    1,
    0,
    0.0,
  )
  assert_true(h >= 1)
  let job = job_of(h)
  let fb = fx.frames * fx.bins
  // Views are taken after `open`: the job's buffers only exist once the handle does.
  let mem = job_d(h)
  for i = 0; i < fb; i = i + 1 {
    mem.unsafe_set(job.off_mag + i, fx.mag.unsafe_get(i))
    mem.unsafe_set(job.off_warm + i, fx.warm.unsafe_get(i))
  }
  it.bench(name="run", fn() {
    for i = 0; i < job.padded; i = i + 1 {
      mem.unsafe_set(job.off_out + i, 0.0)
    }
    ignore(rtisi_run(h, 0, fx.frames))
    it.keep(mem.unsafe_get(job.off_out))
  })
  rtisi_close(h)
}
