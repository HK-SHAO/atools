///|
test "bench RTISI-LA per-frame advancement (501 frames / win 512 / iters 8)" (
  it : @bench.T,
) {
  let fx = make_fx(501, 512, 128, 440.0)
  let warm = wb_run(fx.mag, fx.frames, fx.bins, fx.win, fx.hop)
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
    mem.unsafe_set(job.off_warm + i, warm.unsafe_get(i))
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

///|
test "bench PGHI initialization (501 frames / win 512)" (it : @bench.T) {
  let fx = make_fx(501, 512, 128, 440.0)
  let n = fx.frames * fx.bins
  let h = pghi_open(
    fx.frames,
    fx.bins,
    fx.win,
    fx.hop,
    wb_gamma,
    wb_tol_hi,
    wb_tol_lo,
  )
  assert_true(h >= 1)
  let mag = pghi_off(h, 0)
  let phase = pghi_off(h, 1)
  let mem = job_d(h)
  for i = 0; i < n; i = i + 1 {
    mem.unsafe_set(mag + i, fx.mag.unsafe_get(i))
  }
  ignore(pghi_run(h))
  it.bench(name="run", fn() {
    ignore(pghi_run(h))
    it.keep(mem.unsafe_get(phase))
  })
  pghi_close(h)
}
