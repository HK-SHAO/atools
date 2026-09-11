// In-place radix-2 FFT, plus the one-sided-to-conjugate-symmetric mirror used by `real_ifft`.
// These are the foundation of the STFT and of phase reconstruction, and the product path has no
// other implementation.
//
// Hot loops use `unsafe_get` / `unsafe_set`, never `arr[i]`: the latter compiles to a
// `moonbit.check_range` plus a `moonbit.array_length` call, neither inlined, which made the same
// 512-point transform 7× slower than JavaScript. Indices are always below the table length.
//
// Twiddles and the Hann window come from `@math.cos/sin`, which differ from V8's `Math.cos/sin`
// by exactly 1 ulp on about 4% of inputs — far below Float32 precision, and orders of magnitude
// below any real algorithm error. See docs/algorithms.md.

///|
fn fft_at(
  pi : Int,
  arena : FixedArray[Double],
  re_off : Int,
  im_off : Int,
  inverse : Bool,
) -> Unit {
  let ix = plan_rev_of(pi)
  let tc = plan_cos_of(pi)
  let ts = plan_sin_of(pi)
  let n = ix.length()
  if n == 0 {
    return
  }
  for i = 0; i < n; i = i + 1 {
    let j = ix.unsafe_get(i)
    if j > i {
      let a = arena.unsafe_get(re_off + i)
      arena.unsafe_set(re_off + i, arena.unsafe_get(re_off + j))
      arena.unsafe_set(re_off + j, a)
      let b = arena.unsafe_get(im_off + i)
      arena.unsafe_set(im_off + i, arena.unsafe_get(im_off + j))
      arena.unsafe_set(im_off + j, b)
    }
  }
  let mut width = 2
  while width <= n {
    let half = width / 2
    let step = n / width
    let mut base = 0
    while base < n {
      let mut j = base
      let mut k = 0
      while j < base + half {
        let p = j + half
        let c = tc.unsafe_get(k)
        let s = if inverse { -ts.unsafe_get(k) } else { ts.unsafe_get(k) }
        let rp = arena.unsafe_get(re_off + p)
        let ip = arena.unsafe_get(im_off + p)
        let tre = rp * c + ip * s
        let tim = -rp * s + ip * c
        let rj = arena.unsafe_get(re_off + j)
        let ij = arena.unsafe_get(im_off + j)
        arena.unsafe_set(re_off + p, rj - tre)
        arena.unsafe_set(im_off + p, ij - tim)
        arena.unsafe_set(re_off + j, rj + tre)
        arena.unsafe_set(im_off + j, ij + tim)
        j = j + 1
        k = k + step
      }
      base = base + width
    }
    width = width * 2
  }
  if inverse {
    // Divide by n rather than multiply by 1/n: the reference divides, and 1/n is not exact.
    let nf = n.to_double()
    for i = 0; i < n; i = i + 1 {
      arena.unsafe_set(re_off + i, arena.unsafe_get(re_off + i) / nf)
      arena.unsafe_set(im_off + i, arena.unsafe_get(im_off + i) / nf)
    }
  }
}

///|
/// In-place complex forward FFT of one slot's workspace.
///
/// The workspace holds `re` at the slot base and `im` immediately after it.
///
/// @param s Slot index; invalid slots are ignored.
#export_name("dsp_fft")
pub fn forward(s : Int) -> Unit {
  if slot_live(s) {
    let pi = slot_plan.unsafe_get(s)
    let n = plan_rev_of(pi).length()
    fft_at(pi, slot_mem.unsafe_get(s), 0, n, false)
  }
}

///|
/// In-place complex inverse FFT of one slot, dividing by n.
///
/// Not used on the product path — a real signal goes through `real_ifft`, which mirrors and
/// inverts in one call. This stays as the round-trip reference in the white-box tests.
///
/// @param s Slot index; invalid slots are ignored.
pub fn inverse(s : Int) -> Unit {
  if slot_live(s) {
    let pi = slot_plan.unsafe_get(s)
    let n = plan_rev_of(pi).length()
    fft_at(pi, slot_mem.unsafe_get(s), 0, n, true)
  }
}

///|
/// Inverse FFT of a real signal: mirror the one-sided spectrum to conjugate symmetry, then run
/// the complex inverse in the same slot.
///
/// The mirror cannot be left to the caller. Skipping it makes the upper half of the spectrum
/// carry the previous frame's time samples, which then get transformed again — every frame from
/// 0 on is corrupted, far away from the actual mistake.
///
/// @param s Slot index.
/// @param bins One-sided rows, at most `n/2+1` where `n` is the window length. Fewer is legal
/// (an image-read exact spectrum is clamped) and the caller must zero the rest itself.
/// @return 1 if it ran; 0 if `s` or `bins` is invalid, leaving the workspace untouched.
#export_name("dsp_real_ifft")
pub fn real_ifft(s : Int, bins : Int) -> Int {
  if !slot_live(s) {
    return 0
  }
  let pi = slot_plan.unsafe_get(s)
  let n = plan_rev_of(pi).length()
  if n == 0 || bins < 1 || bins > n / 2 + 1 {
    return 0
  }
  let mem = slot_mem.unsafe_get(s)
  // DC and Nyquist are real lines, so their imaginary parts must be zero.
  mem.unsafe_set(n, 0.0)
  mem.unsafe_set(n + bins - 1, 0.0)
  for b = 1; b < bins - 1; b = b + 1 {
    mem.unsafe_set(n - b, mem.unsafe_get(b))
    mem.unsafe_set(2 * n - b, -mem.unsafe_get(n + b))
  }
  fft_at(pi, mem, 0, n, true)
  1
}
