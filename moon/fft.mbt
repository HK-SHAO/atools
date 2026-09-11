///|
fn fft_at(
  plan_id : Int,
  arena : FixedArray[Double],
  re_off : Int,
  im_off : Int,
  inverse : Bool,
) -> Unit {
  let ix = plan_rev_of(plan_id)
  let tc = plan_cos_of(plan_id)
  let ts = plan_sin_of(plan_id)
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
    let nf = n.to_double()
    for i = 0; i < n; i = i + 1 {
      arena.unsafe_set(re_off + i, arena.unsafe_get(re_off + i) / nf)
      arena.unsafe_set(im_off + i, arena.unsafe_get(im_off + i) / nf)
    }
  }
}

///|
#export_name("dsp_fft")
pub fn forward(s : Int) -> Unit {
  if slot_live(s) {
    let plan_id = slot_plan.unsafe_get(s)
    let n = plan_rev_of(plan_id).length()
    fft_at(plan_id, slot_mem.unsafe_get(s), 0, n, false)
  }
}

///|
pub fn inverse(s : Int) -> Unit {
  if slot_live(s) {
    let plan_id = slot_plan.unsafe_get(s)
    let n = plan_rev_of(plan_id).length()
    fft_at(plan_id, slot_mem.unsafe_get(s), 0, n, true)
  }
}

///|
#export_name("dsp_real_ifft")
pub fn real_ifft(s : Int, bins : Int) -> Int {
  if !slot_live(s) {
    return 0
  }
  let plan_id = slot_plan.unsafe_get(s)
  let n = plan_rev_of(plan_id).length()
  if n == 0 || bins < 1 || bins > n / 2 + 1 {
    return 0
  }
  let mem = slot_mem.unsafe_get(s)
  mem.unsafe_set(n, 0.0)
  mem.unsafe_set(n + bins - 1, 0.0)
  for b = 1; b < bins - 1; b = b + 1 {
    mem.unsafe_set(n - b, mem.unsafe_get(b))
    mem.unsafe_set(2 * n - b, -mem.unsafe_get(n + b))
  }
  fft_at(plan_id, mem, 0, n, true)
  1
}
