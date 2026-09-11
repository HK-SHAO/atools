// White-box invariants of the PGHI phase initialiser.
//
// Two of these used to live in `app/lib/phase.test.ts`: the chirp phase RMS and the silent-spectrum
// case. They moved here because the numerics did — and moving them made the gates stricter, not
// looser. The host versions built their magnitude spectrum with a host helper; these drive the
// kernel's own session slot and Hann table, so what is measured is the spectrum the product
// actually feeds in.
//
// The tuning constants are hardcoded to the product's values (`TUNE.gamma` / `TUNE.tol` in
// app/lib/phase.ts). That is deliberate: the thresholds below were measured at that tuning, and
// the kernel takes the constants as arguments precisely so the host stays the only place they are
// chosen.

///|
/// Coupling and acceptance thresholds, equal to `TUNE.gamma` / `TUNE.tol` in app/lib/phase.ts.
let wb_gamma : Double = 0.25645

///|
let wb_tol_hi : Double = 0.1

///|
let wb_tol_lo : Double = 1.0e-10

///|
/// Signed angular distance, computed independently of `pghi_wrap` (through `atan2`).
fn ang_gap(a : Double, b : Double) -> Double {
  @math.atan2(@math.sin(a - b), @math.cos(a - b))
}

///|
/// Linear-frequency sweep, same expression as the host generator so the two spectra are the same.
fn wb_chirp(
  n : Int,
  sr : Double,
  from : Double,
  to : Double,
) -> FixedArray[Double] {
  let x = FixedArray::make(n, 0.0)
  for i = 0; i < n; i = i + 1 {
    let t = i.to_double() / n.to_double()
    let phase = 2.0 *
      pi *
      n.to_double() *
      (from * t + 0.5 * (to - from) * t * t) /
      sr
    x.unsafe_set(i, @math.sin(phase))
  }
  x
}

///|
/// Magnitude and phase of `frames` frames, using the kernel's own transform, session slot and Hann
/// table. Padding is `pad[win/2 + i] = x[i]` and frame `f` reads from `f*hop` — the product's
/// convention, so a convention error shows up here exactly as it would in the app.
fn wb_stft(
  x : FixedArray[Double],
  win : Int,
  hop : Int,
  frames : Int,
) -> (FixedArray[Double], FixedArray[Double], Int) raise {
  let bins = win / 2 + 1
  let s = slot_open(win)
  assert_true(s >= 0)
  let arena = slot_mem_of(s)
  let w = plan_hann_of(plan(win))
  let pad = FixedArray::make(x.length() + win, 0.0)
  for i = 0; i < x.length(); i = i + 1 {
    pad.unsafe_set(win / 2 + i, x.unsafe_get(i))
  }
  let mag = FixedArray::make(frames * bins, 0.0)
  let ph = FixedArray::make(frames * bins, 0.0)
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
      ph.unsafe_set(f * bins + b, @math.atan2(im, re))
    }
  }
  slot_close(s)
  (mag, ph, bins)
}

///|
/// Hands `mag` to a fresh job, runs PGHI and returns a copy of the phase region. The copy is taken
/// before `close`, which hands the region back to the pool.
fn wb_run(
  mag : FixedArray[Double],
  frames : Int,
  bins : Int,
  win : Int,
  hop : Int,
) -> FixedArray[Double] raise {
  let n = frames * bins
  let h = pghi_open(frames, bins, win, hop, wb_gamma, wb_tol_hi, wb_tol_lo)
  assert_true(h >= 1)
  let base = pghi_off(h, 0)
  let at = pghi_off(h, 1)
  let d = job_d(h)
  for i = 0; i < n; i = i + 1 {
    d.unsafe_set(base + i, mag.unsafe_get(i))
  }
  assert_eq(pghi_run(h), 1)
  let out = FixedArray::make(n, 0.0)
  for i = 0; i < n; i = i + 1 {
    out.unsafe_set(i, job_d(h).unsafe_get(at + i))
  }
  pghi_close(h)
  out
}

///|
/// Weighted circular RMS after removing the best constant offset: the statistic the host gate
/// used, so its threshold carries over unchanged.
fn circ_rms_deg(
  got : FixedArray[Double],
  truth : FixedArray[Double],
  weight : FixedArray[Double],
) -> Double {
  let n = got.length()
  let mut cr = 0.0
  let mut ci = 0.0
  for i = 0; i < n; i = i + 1 {
    let d = got.unsafe_get(i) - truth.unsafe_get(i)
    cr = cr + weight.unsafe_get(i) * @math.cos(d)
    ci = ci + weight.unsafe_get(i) * @math.sin(d)
  }
  let k = @math.atan2(ci, cr)
  let mut num = 0.0
  let mut den = 0.0
  for i = 0; i < n; i = i + 1 {
    let e = ang_gap(got.unsafe_get(i) - truth.unsafe_get(i), k)
    num = num + weight.unsafe_get(i) * e * e
    den = den + weight.unsafe_get(i)
  }
  (num / den).sqrt() * 180.0 / pi
}

///|
/// `pghi_wrap` is the reference expression verbatim, and it is bit-identical to it — that is a
/// measured claim, not a structural one: over 485 400 samples (four synthetic signals × three
/// window lengths, plus four hand-built spectra) the kernel agrees with the JavaScript reference
/// on every element. The version that folded the modulus by "divide, truncate, multiply back"
/// drifted by up to 3e-12 rad, and this test does not catch that — the range is still valid there.
/// What it does pin is the range and the seam, which is where a correction that only works for
/// positive arguments shows up.
test "white box: wrap lands in [−π, π] and agrees with atan2" {
  assert_eq(pghi_wrap(0.0), 0.0)
  assert_eq(pghi_wrap(pi), -pi)
  assert_eq(pghi_wrap(-pi), -pi)
  assert_true((pghi_wrap(0.5 * pi) - 0.5 * pi).abs() < 1.0e-15)
  let mut worst = 0.0
  for i = -400; i <= 400; i = i + 1 {
    let a = i.to_double() * 0.05 * pi
    let v = pghi_wrap(a)
    assert_true(v >= -pi && v <= pi)
    let d = ang_gap(v, @math.atan2(@math.sin(a), @math.cos(a))).abs()
    if d > worst {
      worst = d
    }
  }
  assert_true(worst < 1.0e-9)
}

///|
/// The region contract: `mag` is the host's input and must come back untouched, `phase` is the
/// output, and the job holds exactly the two of them.
test "white box: the magnitude region comes in and the phase region comes out" {
  let frames = 6
  let bins = 5
  let n = frames * bins
  let h = pghi_open(frames, bins, 256, 64, wb_gamma, wb_tol_hi, wb_tol_lo)
  assert_true(h >= 1)
  assert_eq(pghi_off(h, 0), 0)
  assert_eq(pghi_off(h, 1), n)
  assert_eq(pghi_off(h, 2), -1)
  assert_eq(job_words_of(h), 2 * n)
  let d = job_d(h)
  for i = 0; i < n; i = i + 1 {
    d.unsafe_set(i, 1.0 + i.to_double())
  }
  assert_eq(pghi_run(h), 1)
  for i = 0; i < n; i = i + 1 {
    assert_eq(job_d(h).unsafe_get(i), 1.0 + i.to_double())
  }
  pghi_close(h)
  assert_eq(pghi_off(h, 0), -1)
  assert_eq(pghi_run(h), 0)
}

///|
/// Two runs over the same spectrum must be bit-identical. Half the frames are silent, so the
/// unvisited-bin fill runs too — without it this test would only cover the propagation path and
/// would leave the pseudo-random fill free to carry state across runs.
test "white box: two runs over the same spectrum are bit-identical" {
  let win = 256
  let hop = 64
  let frames = 40
  let bins = win / 2 + 1
  let x = wb_chirp(4000, 8000.0, 300.0, 3000.0)
  let (mag, _, _) = wb_stft(x, win, hop, frames)
  for i = 0; i < 20 * bins; i = i + 1 {
    mag.unsafe_set(i, 0.0)
  }
  let a = wb_run(mag, frames, bins, win, hop)
  let b = wb_run(mag, frames, bins, win, hop)
  for i = 0; i < a.length(); i = i + 1 {
    assert_eq(a.unsafe_get(i), b.unsafe_get(i))
  }
}

///|
/// No energy and a one-frame spectrogram both leave the phase at zero and still report success:
/// one failure mode for the host, not two.
test "white box: a spectrum with no energy, and a single frame, leave the phase at zero" {
  let silent = wb_run(FixedArray::make(64 * 33, 0.0), 64, 33, 64, 16)
  for i = 0; i < silent.length(); i = i + 1 {
    assert_eq(silent.unsafe_get(i), 0.0)
  }
  let one = wb_run(FixedArray::make(33, 1.0), 1, 33, 64, 16)
  for i = 0; i < one.length(); i = i + 1 {
    assert_eq(one.unsafe_get(i), 0.0)
  }
}

///|
/// Illegal parameters are rejected at open time rather than clamped; a stale handle is rejected by
/// every accessor, and closing twice is not an error. Nothing here may crash — deciding what a
/// rejection means is the host's job.
test "white box: illegal parameters and stale handles are rejected, not crashed on" {
  assert_eq(pghi_open(0, 33, 64, 16, wb_gamma, wb_tol_hi, wb_tol_lo), 0)
  assert_eq(pghi_open(64, 1, 64, 16, wb_gamma, wb_tol_hi, wb_tol_lo), 0)
  assert_eq(pghi_open(64, 33, 1, 16, wb_gamma, wb_tol_hi, wb_tol_lo), 0)
  assert_eq(pghi_open(64, 33, 64, 0, wb_gamma, wb_tol_hi, wb_tol_lo), 0)
  assert_eq(pghi_off(0, 0), -1)
  assert_eq(pghi_off(9999, 1), -1)
  assert_eq(pghi_run(0), 0)
  pghi_close(0)
  pghi_close(9999)
}

///|
/// A full job pool refuses, and closing releases the slot for the next job.
test "white box: a full job pool makes pghi_open return 0" {
  let hs = FixedArray::make(max_jobs, 0)
  for i = 0; i < max_jobs; i = i + 1 {
    hs.unsafe_set(i, pghi_open(8, 8, 64, 16, wb_gamma, wb_tol_hi, wb_tol_lo))
  }
  assert_true(hs.unsafe_get(max_jobs - 1) >= 1)
  assert_eq(pghi_open(8, 8, 64, 16, wb_gamma, wb_tol_hi, wb_tol_lo), 0)
  pghi_close(hs.unsafe_get(0))
  let again = pghi_open(8, 8, 64, 16, wb_gamma, wb_tol_hi, wb_tol_lo)
  assert_true(again >= 1)
  pghi_close(again)
  for i = 1; i < max_jobs; i = i + 1 {
    pghi_close(hs.unsafe_get(i))
  }
  assert_eq(job_live_count(), 0)
}

///|
/// A loud bin with nothing around it takes the isolated branch (`best < 0`) and keeps an exact
/// zero phase; every other bin falls through to the pseudo-random fill, which must stay in range
/// and actually look random. This is the one branch with no reference numerics behind it — the
/// outside sees a valid phase array either way.
test "white box: an isolated loud bin keeps a zero phase, the rest gets the fill" {
  let frames = 5
  let bins = 5
  let n = frames * bins
  let peak = 2 * bins + 2
  let mag = FixedArray::make(n, 0.0)
  mag.unsafe_set(peak, 1.0)
  let out = wb_run(mag, frames, bins, 64, 16)
  assert_eq(out.unsafe_get(peak), 0.0)
  let mut distinct = false
  for i = 0; i < n; i = i + 1 {
    if i != peak {
      assert_true(out.unsafe_get(i) >= -pi && out.unsafe_get(i) <= pi)
      if out.unsafe_get(i) != out.unsafe_get(0) {
        distinct = true
      }
    }
  }
  assert_true(distinct)
}

///|
/// The numeric gate: a chirp's magnitude spectrum, with the phase thrown away entirely, must come
/// back within 25° weighted RMS. Propagating from the loud bins is the whole point — with a pure
/// random fill the same statistic lands near 100°, so the two lines are far apart.
test "white box: a chirp's phase comes back almost exactly" {
  let win = 512
  let hop = 128
  let frames = 126
  let bins = win / 2 + 1
  let x = wb_chirp(16000, 16000.0, 300.0, 4000.0)
  let (mag, ph, got_bins) = wb_stft(x, win, hop, frames)
  assert_eq(got_bins, bins)
  let got = wb_run(mag, frames, bins, win, hop)
  let weight = FixedArray::make(mag.length(), 0.0)
  for i = 0; i < mag.length(); i = i + 1 {
    weight.unsafe_set(i, mag.unsafe_get(i) * mag.unsafe_get(i))
  }
  assert_true(circ_rms_deg(got, ph, weight) < 25.0)
}
