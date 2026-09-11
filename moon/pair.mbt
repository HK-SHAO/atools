// Two real transforms in one complex transform: z = x1 + i·x2, then split by conjugate symmetry.
//
// Slot workspace layout, in elements, with S = win and H = S/2+1:
//
// | offset | buffer | length |
// | --- | --- | --- |
// | 0 | zr | S |
// | S | zi | S |
// | 2S | r1 | H |
// | 2S+H | i1 | H |
// | 2S+2H | r2 | H |
// | 2S+3H | i2 | H |
// | 2S+4H | x1 | S |
// | 3S+4H | x2 | S |
//
// The total is 4S+4H, which is `slot_words` at S = max_win — the slot capacity is sized from it.
// The host never computes these offsets: `dsp_pair_off` reports them.

///|
/// Full transform size of the slot's window.
fn pair_size(s : Int) -> Int {
  plan_rev_of(slot_plan.unsafe_get(s)).length()
}

///|
/// Element offset of table `which` (0 r1, 1 i1, 2 r2, 3 i2, 4 x1, 5 x2).
fn pair_off(which : Int, size : Int) -> Int {
  let half = size / 2 + 1
  if which < 4 {
    2 * size + which * half
  } else if which == 4 {
    2 * size + 4 * half
  } else {
    3 * size + 4 * half
  }
}

///|
/// Element offset of one of the six tables within the slot workspace.
///
/// @param s Slot index.
/// @param which 0 = r1, 1 = i1, 2 = r2, 3 = i2, 4 = x1, 5 = x2.
/// @return Offset in elements from the workspace base; -1 if `s` or `which` is invalid.
#export_name("dsp_pair_off")
pub fn pair_off_of(s : Int, which : Int) -> Int {
  if !slot_live(s) || which < 0 || which > 5 {
    return -1
  }
  pair_off(which, pair_size(s))
}

///|
/// Half-spectrum length H = S/2 + 1, for sizing host views.
///
/// @return H; 0 if `s` is invalid.
#export_name("dsp_pair_half")
pub fn pair_half_of(s : Int) -> Int {
  if !slot_live(s) {
    0
  } else {
    pair_size(s) / 2 + 1
  }
}

///|
/// Full transform size S (the window length), for sizing x1/x2 views.
///
/// @return S; 0 if `s` is invalid.
#export_name("dsp_pair_size")
pub fn pair_size_of(s : Int) -> Int {
  if !slot_live(s) {
    0
  } else {
    pair_size(s)
  }
}

///|
/// Packs two real waveforms (written by the caller into x1/x2) into two half-spectra.
///
/// @param s Slot index; invalid slots are ignored.
pub fn pair_forward(s : Int) -> Unit {
  if !slot_live(s) {
    return
  }
  let size = pair_size(s)
  let half = size / 2 + 1
  let arena = slot_mem.unsafe_get(s)
  let zi_off = size
  // zr = x1, zi = x2.
  arena.blit_to(arena, len=size, src_offset=pair_off(4, size), dst_offset=0)
  arena.blit_to(
    arena,
    len=size,
    src_offset=pair_off(5, size),
    dst_offset=zi_off,
  )
  fft_at(slot_plan.unsafe_get(s), arena, 0, zi_off, false)
  let r1 = pair_off(0, size)
  let i1 = pair_off(1, size)
  let r2 = pair_off(2, size)
  let i2 = pair_off(3, size)
  // k and m = size-k read the original spectrum and write the four output tables, so they do not
  // overlap.
  for k = 0; k < half; k = k + 1 {
    let m = if k == 0 { 0 } else { size - k }
    let a = arena.unsafe_get(k)
    let b = arena.unsafe_get(zi_off + k)
    let c = arena.unsafe_get(m)
    let d = arena.unsafe_get(zi_off + m)
    arena.unsafe_set(r1 + k, 0.5 * (a + c))
    arena.unsafe_set(i1 + k, 0.5 * (b - d))
    arena.unsafe_set(r2 + k, 0.5 * (b + d))
    arena.unsafe_set(i2 + k, -0.5 * (a - c))
  }
}

///|
/// Reconstructs two real waveforms (written back to x1/x2) from two half-spectra.
///
/// The imaginary parts at DC and Nyquist are zeroed first: without it the two waveforms drift,
/// because the amplitudes written by the caller are not conjugate-consistent there.
///
/// @param s Slot index; invalid slots are ignored.
pub fn pair_inverse(s : Int) -> Unit {
  if !slot_live(s) {
    return
  }
  let size = pair_size(s)
  let half = size / 2 + 1
  let last = half - 1
  let arena = slot_mem.unsafe_get(s)
  let zi_off = size
  let r1 = pair_off(0, size)
  let i1 = pair_off(1, size)
  let r2 = pair_off(2, size)
  let i2 = pair_off(3, size)
  arena.unsafe_set(i1, 0.0)
  arena.unsafe_set(i2, 0.0)
  arena.unsafe_set(i1 + last, 0.0)
  arena.unsafe_set(i2 + last, 0.0)
  // Z = X1 + i·X2 has no Hermitian symmetry, so its second half must be derived from X1 and X2
  // separately (Z[N-k] = conj(X1[k]) + i·conj(X2[k])) rather than by mirroring Z itself.
  arena.unsafe_set(0, arena.unsafe_get(r1))
  arena.unsafe_set(zi_off, arena.unsafe_get(r2))
  arena.unsafe_set(last, arena.unsafe_get(r1 + last))
  arena.unsafe_set(zi_off + last, arena.unsafe_get(r2 + last))
  for k = 1; k < last; k = k + 1 {
    let m = size - k
    let a = arena.unsafe_get(r1 + k)
    let b = arena.unsafe_get(i1 + k)
    let c = arena.unsafe_get(r2 + k)
    let d = arena.unsafe_get(i2 + k)
    arena.unsafe_set(k, a - d)
    arena.unsafe_set(zi_off + k, b + c)
    arena.unsafe_set(m, a + d)
    arena.unsafe_set(zi_off + m, c - b)
  }
  fft_at(slot_plan.unsafe_get(s), arena, 0, zi_off, true)
  arena.blit_to(arena, len=size, src_offset=0, dst_offset=pair_off(4, size))
  arena.blit_to(
    arena,
    len=size,
    src_offset=zi_off,
    dst_offset=pair_off(5, size),
  )
}
