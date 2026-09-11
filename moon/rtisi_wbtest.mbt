///|
fn job_of(h : Int) -> RtJob {
  match rt_at(h) {
    Some(job) => job
    None => abort("stale RTISI handle")
  }
}

///|
fn peak_of(a : FixedArray[Double]) -> Double {
  let mut p = 0.0
  for i = 0; i < a.length(); i = i + 1 {
    let v = a.unsafe_get(i).abs()
    if v > p {
      p = v
    }
  }
  p
}

///|
fn corr_of(a : FixedArray[Double], b : FixedArray[Double]) -> Double {
  let mut n = 0.0
  let mut da = 0.0
  let mut db = 0.0
  for i = 0; i < a.length(); i = i + 1 {
    n = n + a.unsafe_get(i) * b.unsafe_get(i)
    da = da + a.unsafe_get(i) * a.unsafe_get(i)
    db = db + b.unsafe_get(i) * b.unsafe_get(i)
  }
  n / (da * db).sqrt()
}

///|
priv struct Fx {
  x : FixedArray[Double]
  mag : FixedArray[Double]
  warm : FixedArray[Double]
  frames : Int
  bins : Int
  win : Int
  hop : Int
  samples : Int
}

///|
fn make_fx(frames : Int, win : Int, hop : Int, freq : Double) -> Fx raise {
  let bins = win / 2 + 1
  let samples = frames * hop
  let x = FixedArray::make(samples, 0.0)
  for i = 0; i < samples; i = i + 1 {
    x.unsafe_set(
      i,
      0.6 * @math.sin(2.0 * @math.PI * freq * i.to_double() / 8000.0),
    )
  }
  let pad = FixedArray::make(samples + win, 0.0)
  for i = 0; i < samples; i = i + 1 {
    pad.unsafe_set(win / 2 + i, x.unsafe_get(i))
  }
  let s = slot_open(win)
  assert_true(s >= 0)
  let w = plan_hann_of(plan(win))
  let arena = slot_mem_of(s)
  let mag = FixedArray::make(frames * bins, 0.0)
  let warm = FixedArray::make(frames * bins, 0.0)
  for f = 0; f < frames; f = f + 1 {
    for m = 0; m < win; m = m + 1 {
      arena.unsafe_set(m, pad.unsafe_get(f * hop + m) * w.unsafe_get(m))
      arena.unsafe_set(win + m, 0.0)
    }
    forward(s)
    for b = 0; b < bins; b = b + 1 {
      let re = arena.unsafe_get(b)
      let im = arena.unsafe_get(win + b)
      mag.unsafe_set(f * bins + b, (re * re + im * im).sqrt())
      warm.unsafe_set(f * bins + b, @math.atan2(im, re))
    }
  }
  slot_close(s)
  { x, mag, warm, frames, bins, win, hop, samples, }
}

///|
fn run_rtisi(
  fx : Fx,
  iters : Int,
  chunk : Int,
  budget : Double,
  warm : Bool,
  band : FixedArray[Double]?,
  levels : FixedArray[Int]?,
) -> FixedArray[Double] raise {
  let has_band = if band is Some(_) { 1 } else { 0 }
  let h = rtisi_open(
    fx.frames,
    fx.bins,
    fx.win,
    fx.hop,
    fx.samples,
    iters,
    if warm {
      1
    } else {
      0
    },
    has_band,
    budget,
  )
  assert_true(h >= 1)
  let job = job_of(h)
  let arena = job_d(h)
  let bseg = job_b(h)
  let fb = fx.frames * fx.bins
  for i = 0; i < fb; i = i + 1 {
    arena.unsafe_set(job.off_mag + i, fx.mag.unsafe_get(i))
  }
  if warm {
    for i = 0; i < fb; i = i + 1 {
      arena.unsafe_set(job.off_warm + i, fx.warm.unsafe_get(i))
    }
  }
  match band {
    Some(table) =>
      for i = 0; i < 512; i = i + 1 {
        arena.unsafe_set(job.off_band + i, table.unsafe_get(i))
      }
    None => ()
  }
  match levels {
    Some(lv) => {
      let off = rtisi_levels(h, 0)
      for i = 0; i < fb; i = i + 1 {
        bseg.unsafe_set(off + i, lv.unsafe_get(i).to_byte())
      }
    }
    None => ()
  }
  let mut at = 0
  while at < fx.frames {
    let to = if at + chunk < fx.frames { at + chunk } else { fx.frames }
    ignore(rtisi_run(h, at, to))
    at = to
  }
  rtisi_finish(h)
  let y = FixedArray::make(fx.samples, 0.0)
  for i = 0; i < fx.samples; i = i + 1 {
    y.unsafe_set(i, arena.unsafe_get(job.off_y + i))
  }
  rtisi_close(h)
  y
}

///|
fn shrink_of(
  frames : Int,
  win : Int,
  hop : Int,
  iters : Int,
  budget : Double,
) -> (Int, Int) raise {
  let bins = win / 2 + 1
  let h = rtisi_open(frames, bins, win, hop, frames * hop, iters, 0, 0, budget)
  assert_true(h >= 1)
  let job = job_of(h)
  let k = job.k
  let it = job.iters
  rtisi_close(h)
  (k, it)
}

///|
fn layout_of(job : RtJob) -> FixedArray[Int] {
  [
    job.off_mag,
    job.off_warm,
    job.off_y,
    job.off_out,
    job.off_cover,
    job.off_local,
    job.off_work,
    job.off_workim,
    job.off_cos,
    job.off_sin,
    job.off_amp,
    job.off_pcos,
    job.off_psin,
    job.off_pamp,
    job.off_band,
  ]
}

///|
fn walk_layout(h : Int, frames : Int, win : Int, samples : Int) -> Unit raise {
  let job = job_of(h)
  let bins = win / 2 + 1
  let fb = frames * bins
  let padded = samples + win
  let state = (job.k + 1) * bins
  let size : FixedArray[Int] = [
    fb,
    fb,
    samples,
    padded,
    padded,
    job.span,
    win,
    win,
    state,
    state,
    state,
    state,
    state,
    state,
    512,
  ]
  let offs = layout_of(job)
  let mut at = 0
  for i = 0; i < size.length(); i = i + 1 {
    assert_eq(offs.unsafe_get(i), at)
    at = at + size.unsafe_get(i)
  }
  assert_eq(at, job_words_of(h))
  assert_eq(rtisi_levels(h, 0), 0)
  assert_eq(rtisi_levels(h, 1), fb)
  assert_eq(job_bytes_of(h), fb)
}

///|
test "white box: job regions are back to back, and the total matches both segment lengths" {
  let win = 256
  let hop = 64
  let frames = 33
  let h = rtisi_open(frames, win / 2 + 1, win, hop, frames * hop, 4, 0, 1, 0.0)
  assert_true(h >= 1)
  walk_layout(h, frames, win, frames * hop)
  rtisi_close(h)
}

///|
test "white box: the layout is unchanged while another job is open" {
  let win = 512
  let hop = 128
  let frames = 17
  let pad = job_open(1000, 0)
  assert_true(pad >= 1)
  let h = rtisi_open(frames, win / 2 + 1, win, hop, frames * hop, 4, 0, 1, 0.0)
  assert_true(h >= 1)
  walk_layout(h, frames, win, frames * hop)
  assert_true(job_d(pad).length() == 1000)
  assert_eq(job_bytes_of(pad), 0)
  rtisi_close(h)
  job_close(pad)
  assert_eq(job_live_count(), 0)
}

///|
test "white box: levels are read from byte 0 of the byte segment in the frame loop" {
  let win = 256
  let hop = 64
  let frames = 9
  let bins = win / 2 + 1
  let samples = frames * hop
  let h = rtisi_open(frames, bins, win, hop, samples, 4, 1, 1, 0.0)
  assert_true(h >= 1)
  let job = job_of(h)
  let arena = job_d(h)
  let bseg = job_b(h)
  let fb = frames * bins
  let off_levels = rtisi_levels(h, 0)
  arena.unsafe_set(job.off_band, 1.0)
  arena.unsafe_set(job.off_band + 256, 1.0e300)
  for i = 0; i < fb; i = i + 1 {
    bseg.unsafe_set(off_levels + i, b'\x01')
    arena.unsafe_set(job.off_mag + i, 1.0)
    arena.unsafe_set(job.off_warm + i, 0.0)
  }
  ignore(rtisi_run(h, 0, frames))
  rtisi_finish(h)
  for i = 0; i < samples; i = i + 1 {
    assert_eq(arena.unsafe_get(job.off_y + i), 0.0)
  }
  rtisi_close(h)
}

///|
test "white box: chunked advancement is bit-identical to one pass" {
  let fx = make_fx(129, 256, 64, 440.0)
  let whole = run_rtisi(fx, 8, 100000, 0.0, false, None, None)
  for chunk in [1, 5, 64, 128, 129] {
    let part = run_rtisi(fx, 8, chunk, 0.0, false, None, None)
    for i = 0; i < fx.samples; i = i + 1 {
      assert_true(whole.unsafe_get(i) == part.unsafe_get(i))
    }
  }
}

///|
test "white box: two runs with the same parameters are bit-identical" {
  let fx = make_fx(64, 512, 128, 440.0)
  let a = run_rtisi(fx, 8, 13, 0.0, false, None, None)
  let b = run_rtisi(fx, 8, 13, 0.0, false, None, None)
  for i = 0; i < fx.samples; i = i + 1 {
    assert_true(a.unsafe_get(i) == b.unsafe_get(i))
  }
}

///|
test "white box: true phases are a fixed point, absent phases clearly are not" {
  let fx = make_fx(501, 512, 128, 440.0)
  let with_warm = run_rtisi(fx, 8, 100000, 0.0, true, None, None)
  let cold = run_rtisi(fx, 8, 100000, 0.0, false, None, None)
  let cw = corr_of(with_warm, fx.x)
  let cc = corr_of(cold, fx.x)
  assert_true(cw > 0.99)
  assert_true(cc < 0.9)
  let px = peak_of(fx.x)
  let py = peak_of(with_warm)
  assert_true(py > 0.2 * px && py < 5.0 * px)
}

///|
test "white box: the magnitude soft constraint goes through levels bytes and a 256-entry table" {
  let fx = make_fx(9, 256, 64, 440.0)
  let fb = fx.frames * fx.bins
  let alive = FixedArray::make(512, 0.0)
  alive.unsafe_set(0, 1.0)
  alive.unsafe_set(256, 1.0e300)
  let dead = FixedArray::make(512, 0.0)
  let zeros = FixedArray::make(fb, 0)
  let ones = FixedArray::make(fb, 1)
  let band = run_rtisi(fx, 4, 100000, 0.0, true, Some(alive), Some(zeros))
  assert_true(peak_of(band) > 0.0)
  assert_eq(
    peak_of(run_rtisi(fx, 4, 100000, 0.0, true, Some(dead), Some(zeros))),
    0.0,
  )
  assert_eq(
    peak_of(run_rtisi(fx, 4, 100000, 0.0, true, Some(alive), Some(ones))),
    0.0,
  )
  let hard = run_rtisi(fx, 4, 100000, 0.0, true, None, None)
  assert_true(peak_of(hard) > 0.0)
  let mut same = 0
  for i = 0; i < fx.samples; i = i + 1 {
    if hard.unsafe_get(i) == band.unsafe_get(i) {
      same = same + 1
    }
  }
  assert_true(same < fx.samples)
}

///|
test "white box: the finish-step overlap normalization recomputes independently" {
  let win = 256
  let hop = 64
  let frames = 33
  let bins = win / 2 + 1
  let samples = frames * hop
  let padded = samples + win
  let h = rtisi_open(frames, bins, win, hop, samples, 4, 1, 0, 0.0)
  assert_true(h >= 1)
  let job = job_of(h)
  let arena = job_d(h)
  let fb = frames * bins
  for i = 0; i < fb; i = i + 1 {
    arena.unsafe_set(job.off_mag + i, 1.0 + (i % 7).to_double())
    arena.unsafe_set(job.off_warm + i, 0.25 * (i % 11).to_double())
  }
  ignore(rtisi_run(h, 0, frames))
  let expect = FixedArray::make(padded, 0.0)
  for f = 0; f < frames; f = f + 1 {
    let s = f * hop
    for mh = 0; mh < win; mh = mh + 1 {
      expect.unsafe_set(
        s + mh,
        expect.unsafe_get(s + mh) +
        job.hann.unsafe_get(mh) * job.hann.unsafe_get(mh),
      )
    }
  }
  rtisi_finish(h)
  for i = 0; i < padded; i = i + 1 {
    assert_true(expect.unsafe_get(i) == arena.unsafe_get(job.off_cover + i))
  }
  let mut top = 0.0
  for i = 0; i < padded; i = i + 1 {
    if expect.unsafe_get(i) > top {
      top = expect.unsafe_get(i)
    }
  }
  let floor = top * 0.05
  let half = win / 2
  for i = 0; i < samples; i = i + 1 {
    let c = expect.unsafe_get(half + i)
    let want = if c > floor {
      arena.unsafe_get(job.off_out + half + i) / c
    } else {
      0.0
    }
    assert_true(want == arena.unsafe_get(job.off_y + i))
  }
  rtisi_close(h)
}

///|
test "white box: the budget shrinks K and iters until they fit" {
  let win = 512
  let hop = 128
  let frames = 501
  let bound = 8
  let ceil_k = win / hop - 1
  let unit = frames.to_double() * win.to_double() * @math.log2(win.to_double())
  let (k1, it1) = shrink_of(frames, win, hop, bound, 5.0e7)
  assert_true(k1 >= 1 && k1 <= ceil_k)
  assert_true(it1 >= 1 && it1 <= bound)
  assert_true(
    unit * (k1 + 1).to_double() * it1.to_double() <= 5.0e7 ||
    k1 == 1 ||
    it1 == 1,
  )
  let (k2, it2) = shrink_of(frames, win, hop, bound, 1.0e7)
  assert_true(k2 <= k1 && it2 <= it1)
  let (k3, it3) = shrink_of(frames, win, hop, bound, 1.0e18)
  assert_eq(k3, ceil_k)
  assert_eq(it3, bound)
  let (k4, it4) = shrink_of(frames, win, hop, bound, 1.0)
  assert_eq(k4, 1)
  assert_eq(it4, 1)
}

///|
test "white box: @math.log2 is the exact step count on every reachable window length" {
  let mut w = min_win
  let mut idx = 0
  while w <= max_win {
    let mut steps = 0
    while 1 << steps < w {
      steps = steps + 1
    }
    assert_eq(@math.log2(w.to_double()), steps.to_double())
    assert_eq(plan(w), idx)
    w = w * 2
    idx = idx + 1
  }
  assert_eq(idx, plan_count)
  let mut off = 0
  while 1 << off < 3000 {
    off = off + 1
  }
  assert_eq(off, 12)
  assert_true(@math.log2(3000.0) != off.to_double())
  assert_eq(@math.log2(3000.0).to_int(), 11)
}

///|
test "white box: K rounds rather than divides when hop does not divide the window" {
  let (k, _) = shrink_of(501, 512, 130, 1, 1.0e18)
  assert_eq(k, 3)
  let (k2, _) = shrink_of(501, 512, 100, 1, 1.0e18)
  assert_eq(k2, 4)
  let (k3, _) = shrink_of(3, 512, 128, 1, 1.0e18)
  assert_eq(k3, 2)
}

///|
test "white box: illegal parameters are rejected, not crashed on" {
  assert_eq(rtisi_open(4, 1, 256, 64, 256, 8, 0, 0, 0.0), 0)
  assert_eq(rtisi_open(4, 129, 100, 25, 256, 8, 0, 0, 0.0), 0)
  assert_eq(rtisi_open(0, 129, 256, 64, 0, 8, 0, 0, 0.0), 0)
  assert_eq(rtisi_open(-3, 129, 256, 64, 0, 8, 0, 0, 0.0), 0)
  assert_eq(rtisi_open(4, 129, 8192, 2048, 1024, 8, 0, 0, 0.0), 0)
  assert_eq(rtisi_off(0, 0), -1)
  assert_eq(rtisi_off(max_jobs + 1, 2), -1)
  assert_eq(rtisi_off(0, 3), -1)
  assert_eq(rtisi_levels(0, 0), -1)
  assert_eq(job_words_of(0), 0)
  assert_eq(rtisi_run(0, 0, 4), 0)
  rtisi_finish(0)
  rtisi_close(0)
}

///|
test "white box: a full job pool makes rtisi_open return 0" {
  let hs = FixedArray::make(max_jobs, 0)
  for i = 0; i < max_jobs; i = i + 1 {
    hs.unsafe_set(i, rtisi_open(8, 129, 256, 64, 8 * 64, 4, 0, 0, 0.0))
  }
  assert_true(hs.unsafe_get(max_jobs - 1) >= 1)
  assert_eq(rtisi_open(8, 129, 256, 64, 8 * 64, 4, 0, 0, 0.0), 0)
  for h in hs {
    rtisi_close(h)
  }
  let again = rtisi_open(8, 129, 256, 64, 8 * 64, 4, 0, 0, 0.0)
  assert_true(again >= 1)
  rtisi_close(again)
}
