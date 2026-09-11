// FFT plans: bit-reversal, twiddles and the Hann window.
//
// A plan depends only on the window length, is read-only once built, and is cached per length
// (256 / 512 / 1024 / 2048 / 4096). Plans do not occupy session slots: they never collide
// between concurrent computations, and they never need releasing.

///|
/// Largest supported window. The three fineness levels top out at 1024; the image-reading path
/// infers up to 4096 from geometry.
pub let max_win : Int = 4096

///|
let min_win : Int = 256

///|
/// Number of plan groups: 256, 512, 1024, 2048, 4096.
let plan_count : Int = 5

///|
/// Bit-identical to JavaScript's `Math.PI`, not `@math.PI` (deprecated): the twiddles must match
/// the reference implementation bit for bit.
let pi : Double = 3.141592653589793

///|
/// The four tables of one window length.
priv struct Plan {
  rev : FixedArray[Int]
  cos : FixedArray[Double]
  sin : FixedArray[Double]
  hann : FixedArray[Double]
}

///|
let plans : FixedArray[Plan?] = FixedArray::make(plan_count, None)

///|
/// Plan-group index for a window length; -1 when unsupported.
fn plan_of(win : Int) -> Int {
  if win < min_win || win > max_win || (win & (win - 1)) != 0 {
    return -1
  }
  let mut i = 0
  let mut v = min_win
  while v < win {
    v = v * 2
    i = i + 1
  }
  // Guards `min_win` / `max_win` / `plan_count`, three independent constants: a mismatch would
  // silently index past the table array (256…4096 is five powers of two, not four).
  if i >= plan_count {
    return -1
  }
  i
}

///|
/// Built plan group `i`, or `None` when `i` is out of range or not built yet.
fn plan_at(i : Int) -> Plan? {
  if i < 0 || i >= plan_count {
    None
  } else {
    plans.unsafe_get(i)
  }
}

///|
/// Builds the plan tables for a window length and caches them; idempotent.
///
/// @param win Power of two in [256, 4096].
/// @return Plan-group index (>= 0); -1 if `win` is unsupported.
#export_name("dsp_plan")
pub fn plan(win : Int) -> Int {
  let i = plan_of(win)
  if i < 0 {
    return -1
  }
  match plans.unsafe_get(i) {
    Some(_) => i
    None => {
      let mut levels = 0
      while 1 << levels < win {
        levels = levels + 1
      }
      let rev = FixedArray::make(win, 0)
      for k = 0; k < win; k = k + 1 {
        let mut r = 0
        for b = 0; b < levels; b = b + 1 {
          if (k & (1 << b)) != 0 {
            r = r | (1 << (levels - 1 - b))
          }
        }
        rev.unsafe_set(k, r)
      }
      let half = win / 2
      let n = win.to_double()
      let cos = FixedArray::make(half, 0.0)
      let sin = FixedArray::make(half, 0.0)
      for k = 0; k < half; k = k + 1 {
        // Same expression and association order as the reference: (2π·k)/n. IEEE 754 fixes every
        // step, so equal order means equal bits; do not fold this into 2π/n·k.
        let angle = 2.0 * pi * k.to_double() / n
        cos.unsafe_set(k, @math.cos(angle))
        sin.unsafe_set(k, @math.sin(angle))
      }
      let hann = FixedArray::make(win, 0.0)
      for k = 0; k < win; k = k + 1 {
        hann.unsafe_set(k, 0.5 - 0.5 * @math.cos(2.0 * pi * k.to_double() / n))
      }
      let p : Plan = { rev, cos, sin, hann, }
      plans.unsafe_set(i, Some(p))
      i
    }
  }
}

// The tables are handed out as arrays and the host derives their addresses. Plans are read-only
// and never move once built, so one slice per host call is enough — unlike job arenas.

///|
/// Bit-reversal index table of plan group `i` (`win` entries).
///
/// @return A live view into kernel memory, or an empty array if `i` is invalid or unbuilt.
#export_name("dsp_plan_rev")
pub fn plan_rev_of(i : Int) -> FixedArray[Int] {
  match plan_at(i) {
    Some(p) => p.rev
    None => FixedArray::make(0, 0)
  }
}

///|
/// Cosine twiddle table of plan group `i` (`win/2` entries).
///
/// @return A live view into kernel memory, or an empty array if `i` is invalid or unbuilt.
#export_name("dsp_plan_cos")
pub fn plan_cos_of(i : Int) -> FixedArray[Double] {
  match plan_at(i) {
    Some(p) => p.cos
    None => FixedArray::make(0, 0.0)
  }
}

///|
/// Sine twiddle table of plan group `i` (`win/2` entries).
///
/// @return A live view into kernel memory, or an empty array if `i` is invalid or unbuilt.
#export_name("dsp_plan_sin")
pub fn plan_sin_of(i : Int) -> FixedArray[Double] {
  match plan_at(i) {
    Some(p) => p.sin
    None => FixedArray::make(0, 0.0)
  }
}

///|
/// Hann window of plan group `i` (`win` entries).
///
/// @return A live view into kernel memory, or an empty array if `i` is invalid or unbuilt.
#export_name("dsp_plan_hann")
pub fn plan_hann_of(i : Int) -> FixedArray[Double] {
  match plan_at(i) {
    Some(p) => p.hann
    None => FixedArray::make(0, 0.0)
  }
}
