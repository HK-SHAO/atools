// 两条实序列共用一个复变换：z = x1 + i·x2 做一次复变换，再按共轭对称拆回两条半谱。
//
// 槽工作区布局（元素偏移；S = win，H = S/2+1）：
//
// | 偏移 | 缓冲 | 长 |
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
// 合计 4S+4H —— 正好是 `session.mbt` 的 `slot_words` 在 S = max_win 时的值，槽的容量就是照它定的。
// 每张表的偏移都由 `dsp_pair_off` 给出（宿主不自己算），改布局时宿主会跟着编译期一起响。
// 偏移是**元素**偏移，相对槽工作区首 —— 宿主把它加到 `dsp_slot_mem(s)` 那个地址上。

///|
fn pair_size(s : Int) -> Int {
  plan_rev.unsafe_get(slot_plan.unsafe_get(s)).length()
}

///|
/// 第 `which` 张表的元素偏移。0=r1 1=i1 2=r2 3=i2 4=x1 5=x2。
fn pair_off(which : Int, size : Int) -> Int {
  let half = size / 2 + 1
  match which {
    0 => 2 * size
    1 => 2 * size + half
    2 => 2 * size + 2 * half
    3 => 2 * size + 3 * half
    4 => 2 * size + 4 * half
    _ => 3 * size + 4 * half
  }
}

///|
/// 第 `which` 张表的**元素**偏移：0=r1 1=i1 2=r2 3=i2 4=x1 5=x2。槽非法给 -1。
#export_name("dsp_pair_off")
pub fn pair_off_of(s : Int, which : Int) -> Int {
  if !slot_ok(s) || which < 0 || which > 5 {
    return -1
  }
  pair_off(which, pair_size(s))
}

///|
/// 半谱长度 H = S/2+1。宿主拿它定视图长度，不自己算。
#export_name("dsp_pair_half")
pub fn pair_half_of(s : Int) -> Int {
  if !slot_ok(s) {
    return 0
  }
  pair_size(s) / 2 + 1
}

///|
/// 槽内整幅谱长 S（= 窗长）。宿主拿它定 x1/x2 的视图长度。
#export_name("dsp_pair_size")
pub fn pair_size_of(s : Int) -> Int {
  if !slot_ok(s) {
    return 0
  }
  pair_size(s)
}

///|
/// 两条实波形（宿主已写进 x1 / x2）→ 两条半谱（r1/i1 与 r2/i2）。
#export_name("dsp_pair_forward")
pub fn pair_forward(s : Int) -> Unit {
  if !slot_ok(s) {
    return
  }
  let size = pair_size(s)
  let half = size / 2 + 1
  let arena = slot_mem.unsafe_get(s)
  let zi_off = size
  // zr = x1，zi = x2：TS 的 `zr.set(y1.subarray(0, size))` 是同一件事
  arena.blit_to(arena, len=size, src_offset=pair_off(4, size), dst_offset=0)
  arena.blit_to(arena, len=size, src_offset=pair_off(5, size), dst_offset=zi_off)
  fft_at(slot_plan.unsafe_get(s), arena, 0, zi_off, false)
  let r1 = pair_off(0, size)
  let i1 = pair_off(1, size)
  let r2 = pair_off(2, size)
  let i2 = pair_off(3, size)
  // k 与 m = size-k 都在原谱上取值，写的是另外四张表，不打架。
  for k = 0; k < half; k = k + 1 {
    let m = if k == 0 { 0 } else { size - k }
    let a = arena.unsafe_get(k)
    let b = arena.unsafe_get(zi_off + k)
    let c = arena.unsafe_get(m)
    let d = arena.unsafe_get(zi_off + m)
    arena.unsafe_set(r1 + k, 0.5 * (a + c))
    arena.unsafe_set(i1 + k, 0.5 * (b - d))
    arena.unsafe_set(r2 + k, 0.5 * (b + d))
    arena.unsafe_set(i2 + k, (-0.5) * (a - c))
  }
}

///|
/// 两条半谱 → 两条实波形（写回 x1 / x2）。
///
/// 与 `mirrorSpectrum(re, im, full, size)` 同一套约定：DC 与奈奎斯特点的虚部置零。
/// 这一步不能省 —— `lay` 填的 `amp·cos`、`amp·sin` 在 DC 上并不共轭自洽，
/// 原来的实现就是靠 mirror 把它们拉回实信号的谱。少了它，两条波形的直流会飘。
#export_name("dsp_pair_inverse")
pub fn pair_inverse(s : Int) -> Unit {
  if !slot_ok(s) {
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
  // Z = X1 + i·X2。Z 是**复**信号的谱，没有 Hermite 对称，所以第二半得从 X1、X2 各推一次
  // （Z[N-k] = conj(X1[k]) + i·conj(X2[k])），不能像 mirrorSpectrum 那样只翻 Z 自己。
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
  arena.blit_to(arena, len=size, src_offset=zi_off, dst_offset=pair_off(5, size))
}
