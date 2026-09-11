// White-box properties of the table group (Hann window and twiddle factors).
//
// These three used to live in `app/lib/phase.test.ts`, comparing against a host rebuild of the
// Hann window; that implementation (`hannWindow` in `app/lib/fft.ts`) was deleted when the
// numerics became kernel-only. Moving them here made the gates stricter, not looser: they measure
// the actual table the kernel uses rather than a copy of it.

///|
/// Max absolute deviation scaled by the reference peak.
///
/// The gate must be relative: absolute error grows like `eps · log₂n · Σ|x|` with length, so an
/// ulp bound false-alarms on long windows (measured ~60 ulp at 256 points, i.e. 1.4e-14
/// relative). A wrong implementation (one bad sign, index, or summation order) lands at 1e-2
/// relative, so a 1e-12 bound still leaves ten orders of margin.
fn rel_peak_diff(
  arena : FixedArray[Double],
  off : Int,
  golden : FixedArray[Double],
  n : Int,
) -> Double {
  let mut peak = 0.0
  for i = 0; i < n; i = i + 1 {
    let a = abs_f(golden.unsafe_get(i))
    if a > peak {
      peak = a
    }
  }
  if peak == 0.0 {
    return 0.0
  }
  let mut worst = 0.0
  for i = 0; i < n; i = i + 1 {
    let d = abs_f(arena.unsafe_get(off + i) - golden.unsafe_get(i)) / peak
    if d > worst {
      worst = d
    }
  }
  worst
}

///|
/// Hann window: symmetric about the midpoint, 1 there, 0 at both ends. Getting any of these wrong
/// skews the windowed-overlap normalization globally.
test "white box: Hann window is symmetric about the midpoint, peak at the midpoint" {
  let n = 256
  let i = plan(n)
  assert_true(i >= 0)
  let w = plan_hann_of(i)
  assert_true(abs_f(w.unsafe_get(0)) < 1.0e-12)
  assert_true(abs_f(w.unsafe_get(n / 2) - 1.0) < 1.0e-12)
  let mut worst = 0.0
  for k = 1; k < n / 2; k = k + 1 {
    let d = abs_f(w.unsafe_get(n / 2 + k) - w.unsafe_get(n / 2 - k))
    if d > worst {
      worst = d
    }
  }
  assert_true(worst < 1.0e-12)
}

///|
/// At `hop = win/4` the overlap sum of the squared window is **constant over the whole period**,
/// which is why WOLA normalization needs only a scalar denominator. It pins both the overlap
/// factor and the window: changing either makes the sum non-flat.
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
/// Forward transform ≡ naive DFT. The only implementation-independent gate on the transform: it
/// covers twiddle indices, bit reversal, and butterfly summation order. Relative criterion, see
/// `rel_peak_diff`.
test "white box: forward transform matches a naive DFT (within 1e-12 relative peak)" {
  let n = 256
  release_all_slots()
  let src = noise_array(n, 0x2545f491)
  let s = open_fft(n, src)
  assert_true(s >= 0)
  forward(s)
  let arena = slot_mem.unsafe_get(s)

  // Naive DFT real/imaginary parts: written straight from the definition, no optimization.
  let want_re = FixedArray::make(n, 0.0)
  let want_im = FixedArray::make(n, 0.0)
  let nn = n.to_double()
  for k = 0; k < n; k = k + 1 {
    let mut sr = 0.0
    let mut si = 0.0
    for t = 0; t < n; t = t + 1 {
      let a = -2.0 * 3.141592653589793 * k.to_double() * t.to_double() / nn
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
