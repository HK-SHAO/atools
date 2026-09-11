///|
fn rel_peak_diff(
  arena : FixedArray[Double],
  off : Int,
  golden : FixedArray[Double],
  n : Int,
) -> Double {
  let mut peak = 0.0
  for i = 0; i < n; i = i + 1 {
    let a = golden.unsafe_get(i).abs()
    if a > peak {
      peak = a
    }
  }
  if peak == 0.0 {
    return 0.0
  }
  let mut worst = 0.0
  for i = 0; i < n; i = i + 1 {
    let d = (arena.unsafe_get(off + i) - golden.unsafe_get(i)).abs() / peak
    if d > worst {
      worst = d
    }
  }
  worst
}

///|
test "white box: Hann window is symmetric about the midpoint, peak at the midpoint" {
  let n = 256
  let i = plan(n)
  assert_true(i >= 0)
  let w = plan_hann_of(i)
  assert_true(w.unsafe_get(0).abs() < 1.0e-12)
  assert_true((w.unsafe_get(n / 2) - 1.0).abs() < 1.0e-12)
  let mut worst = 0.0
  for k = 1; k < n / 2; k = k + 1 {
    let d = (w.unsafe_get(n / 2 + k) - w.unsafe_get(n / 2 - k)).abs()
    if d > worst {
      worst = d
    }
  }
  assert_true(worst < 1.0e-12)
}

///|
test "white box: the overlap sum of the squared window is flat at hop = win/4" {
  let n = 256
  let hop = n / 4
  let i = plan(n)
  let w = plan_hann_of(i)
  let cover = FixedArray::make(n, 0.0)
  let mut f = 0
  while f * hop < n {
    for m = 0; m < n; m = m + 1 {
      let at = (f * hop + m) % n
      cover.unsafe_set(
        at,
        cover.unsafe_get(at) + w.unsafe_get(m) * w.unsafe_get(m),
      )
    }
    f = f + 1
  }
  let mut lo = cover.unsafe_get(0)
  let mut hi = cover.unsafe_get(0)
  for m = 1; m < n; m = m + 1 {
    let v = cover.unsafe_get(m)
    if v < lo {
      lo = v
    }
    if v > hi {
      hi = v
    }
  }
  assert_true(hi - lo < 1.0e-9)
}

///|
test "white box: forward transform matches a naive DFT (within 1e-12 relative peak)" {
  let n = 256
  release_all_slots()
  let src = noise_array(n, 0x2545f491)
  let s = open_fft(n, src)
  assert_true(s >= 0)
  forward(s)
  let arena = slot_mem.unsafe_get(s)

  let want_re = FixedArray::make(n, 0.0)
  let want_im = FixedArray::make(n, 0.0)
  let nn = n.to_double()
  for k = 0; k < n; k = k + 1 {
    let mut sr = 0.0
    let mut si = 0.0
    for t = 0; t < n; t = t + 1 {
      let a = -2.0 * @math.PI * k.to_double() * t.to_double() / nn
      let x = src.unsafe_get(t)
      sr = sr + x * @math.cos(a)
      si = si + x * @math.sin(a)
    }
    want_re.unsafe_set(k, sr)
    want_im.unsafe_set(k, si)
  }
  assert_true(rel_peak_diff(arena, 0, want_re, n) <= 1.0e-12)
  assert_true(rel_peak_diff(arena, n, want_im, n) <= 1.0e-12)
  slot_close(s)
}
