///|
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
