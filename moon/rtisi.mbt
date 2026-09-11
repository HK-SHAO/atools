// RTISI-LA 相位重建的内核实现。推导、为什么只走紧凑档、以及消融口都写在参照实现
// `app/lib/rtisi.ts` 里 —— 这里只记「搬进内核」带来的结构差别。
//
// **内层不再跨边界。** 参照实现每次 `lay` / `read` 都要在 JS 里铺一遍 `local`、写一遍
// `pair.x1/x2`、再走一次内核调用：中档（frames 1876、win 512、K+1 = 4、iters 8）算下来是
// 每帧约 4.9 万个元素操作、全链九千多万个，而 FFT 早已在内核里 —— 于是真正贵的是
// **那些围着内核调用的 JS 循环**。搬进来之后这些循环一个都不剩。
//
// 三块内存各就各位：表组（旋转因子 / 汉宁窗，只读缓存）、会话槽（`pair_*` 的双实变换
// 工作区，定长）、作业区（`mag` / `warm` / `levels` / `y` / `local` / `out` 与六个状态表，
// 变长，见 arena.mbt）。
//
// 分块推进：`dsp_rtisi_run(h, from, to)` 只处理 [from, to) 帧，宿主在两块之间让出事件循环
// 报进度、看取消。状态全在作业区里，块边界因此是自由的 —— 内核里没有 `await`，
// 也就不需要「让出一半再回来」那套状态机。

///|
/// 迭代预算的**兜底**值。宿主（`app/lib/rtisi.ts`）每次都会把 `budget` 显式传进来镜像
/// 参照实现；这里只在传入非正数时生效（白盒用例就这么用）。两处写的是同一个数：
/// 它决定 K，K 不同结果就不同，不是可以四舍五入的性能旋钮。
let rtisi_budget : Double = 5.0e7

///|
/// 以 2 为底的对数，**精确**版：`win` 恒为 2 的幂，而预算判据要与参照实现逐位同判。
/// `@math.log(v) / @math.log(2.0)` 对 4096 可能给 11.999999，那就把 K 判到另一档去了。
fn log2_exact(n : Int) -> Double {
  let mut v = 1
  let mut e = 0
  while v < n {
    v = v * 2
    e = e + 1
  }
  e.to_double()
}

///|
/// 每条作业的参数表（下标 = 句柄 - 1）。
/// 0 frames · 1 bins · 2 win · 3 hop · 4 samples · 5 K · 6 iters · 7 表组 · 8 会话槽
/// 9 padded · 10 span · 11 full
/// 12 mag · 13 warm · 14 y · 15 levels（**字节**偏移）· 16 out · 17 local · 18 work
/// 19 workIm · 20 cos · 21 sin · 22 amp · 23 prevCos · 24 prevSin · 25 prevAmp
/// 26 band 表 · 27 有 warm · 28 有 band · 29 已推进到的帧 · 30 cover
let rtisi_fields : Int = 32

///|
let rtisi_hdr : FixedArray[FixedArray[Int]] = FixedArray::makei(
  max_jobs,
  _ => FixedArray::make(rtisi_fields, 0),
)

///|
/// 字段里存的偏移全部**相对本作业自己的那段缓冲**，段首即下标 0。作业区改成
/// 「一个作业一段自己的数组」（见 arena.mbt）之后，早先那套「开户时把段基址一次性
/// 并进各字段」就没有了 —— 也就没有了「第一段恒为 0、忘了加看不出来、到第二段才整片错」
/// 那一整类错。`levels` 是**字节段**（`dsp_job_b`）的字节偏移，其余是主缓冲的元素偏移。

///|
/// 建布局时的暂存 —— 尺寸算完之前还不知道句柄号，所以先落在这里再整体搬进 `rtisi_hdr`。
let rtisi_scratch : FixedArray[Int] = FixedArray::make(rtisi_fields, 0)

///|
/// 作业区内的布局。主缓冲给元素偏移，`levels` 给**字节偏移**（它住字节段）。
/// 宿主不自己算：一律问 `dsp_rtisi_off` / `dsp_rtisi_levels_off`。
/// 字节段的长度落在暂存字段 31（`levels` 要 `fb` 个字节）。
fn rtisi_layout(frames : Int, bins : Int, l : Int, a : Int, samples : Int, k : Int) -> Int {
  let fb = frames * bins
  let padded = samples + l
  let span = k * a + l
  let state = (k + 1) * bins
  let mut off = 0
  rtisi_scratch.unsafe_set(12, off)
  off = off + fb
  rtisi_scratch.unsafe_set(13, off)
  off = off + fb
  rtisi_scratch.unsafe_set(14, off)
  off = off + samples
  rtisi_scratch.unsafe_set(16, off)
  off = off + padded
  rtisi_scratch.unsafe_set(30, off)
  off = off + padded
  rtisi_scratch.unsafe_set(17, off)
  off = off + span
  rtisi_scratch.unsafe_set(18, off)
  off = off + l
  rtisi_scratch.unsafe_set(19, off)
  off = off + l
  rtisi_scratch.unsafe_set(20, off)
  off = off + state
  rtisi_scratch.unsafe_set(21, off)
  off = off + state
  rtisi_scratch.unsafe_set(22, off)
  off = off + state
  rtisi_scratch.unsafe_set(23, off)
  off = off + state
  rtisi_scratch.unsafe_set(24, off)
  off = off + state
  rtisi_scratch.unsafe_set(25, off)
  off = off + state
  rtisi_scratch.unsafe_set(26, off)
  off = off + 512
  // levels 一元素一字节，住**字节段**：塞进 Double 缓冲会白占 8 倍（16M 像素的剖面 = 128 MB）。
  rtisi_scratch.unsafe_set(15, 0)
  rtisi_scratch.unsafe_set(31, fb)
  off
}

///|
/// 开一次 RTISI 作业。`has_warm` / `has_band` 是 0/1；`budget` 非正数时用 `rtisi_budget`。
/// 返回句柄；0 = 池满、参数非法或窗长不被内核接受 —— 宿主据此走参照实现。
#export_name("dsp_rtisi_open")
pub fn rtisi_open(
  frames : Int,
  bins : Int,
  win : Int,
  hop : Int,
  samples : Int,
  iters : Int,
  has_warm : Int,
  has_band : Int,
  budget : Double
) -> Int {
  let l = win
  let a = if hop < 1 { 1 } else { hop }
  if frames < 1 || bins < 2 || l < 2 || samples < 0 {
    return 0
  }
  let plan_i = plan(l)
  if plan_i < 0 {
    return 0
  }
  // K 与 iters 的收缩：与参照实现 `app/lib/rtisi.ts` 同一条判据、同一个结合顺序，
  // 两处必须逐条对齐 —— K 不同则结果不同。
  // 尤其 `R = round(L/a)`：换成整除会在 hop 不整除窗长时差一档（hop 130、win 512：
  // round 给 4、整除给 3），而 hop 只在默认档才恰好是 win/4。
  let r = (l.to_double() / a.to_double() + 0.5).to_int()
  let r2 = if r < 1 { 1 } else { r }
  let mut k = if frames - 1 < r2 - 1 { frames - 1 } else { r2 - 1 }
  if k < 0 {
    k = 0
  }
  let mut it = if iters < 1 { 1 } else { iters }
  let b = if budget > 0.0 { budget } else { rtisi_budget }
  let unit = frames.to_double() * l.to_double() * log2_exact(l)
  while k > 1 && unit * (k + 1).to_double() * it.to_double() > b {
    k = k - 1
  }
  while it > 1 && unit * (k + 1).to_double() * it.to_double() > b {
    it = it - 1
  }

  let words = rtisi_layout(frames, bins, l, a, samples, k)
  let h = job_open(words, rtisi_scratch.unsafe_get(31))
  if h == 0 {
    return 0
  }
  let slot = slot_open(l)
  if slot < 0 {
    job_close(h)
    return 0
  }
  let j = h - 1
  let hdr = rtisi_hdr.unsafe_get(j)
  for i = 0; i < rtisi_fields; i = i + 1 {
    hdr.unsafe_set(i, rtisi_scratch.unsafe_get(i))
  }
  hdr.unsafe_set(0, frames)
  hdr.unsafe_set(1, bins)
  hdr.unsafe_set(2, l)
  hdr.unsafe_set(3, a)
  hdr.unsafe_set(4, samples)
  hdr.unsafe_set(5, k)
  hdr.unsafe_set(6, it)
  hdr.unsafe_set(7, plan_i)
  hdr.unsafe_set(8, slot)
  hdr.unsafe_set(9, samples + l)
  hdr.unsafe_set(10, k * a + l)
  hdr.unsafe_set(11, l / 2 + 1)
  hdr.unsafe_set(27, if has_warm != 0 { 1 } else { 0 })
  hdr.unsafe_set(28, if has_band != 0 { 1 } else { 0 })
  hdr.unsafe_set(29, 0)
  h
}

///|
/// 主缓冲里某段的**元素**偏移。`which`：0 mag · 1 warm · 2 y · 4 band 表（512 项）。
/// 宿主把它加到 `dsp_job_d(h)` 的地址上 —— 内核不碰地址，只报自己算出来的偏移。
#export_name("dsp_rtisi_off")
pub fn rtisi_off(h : Int, which : Int) -> Int {
  let j = job_seg(h)
  if j < 0 {
    return -1
  }
  let hdr = rtisi_hdr.unsafe_get(j)
  match which {
    0 => hdr.unsafe_get(12)
    1 => hdr.unsafe_get(13)
    2 => hdr.unsafe_get(14)
    4 => hdr.unsafe_get(26)
    _ => -1
  }
}

///|
/// `levels` 在**字节段**（`dsp_job_b`）里的字节偏移与长度。`which`：0 偏移、1 长度。
#export_name("dsp_rtisi_levels")
pub fn rtisi_levels(h : Int, which : Int) -> Int {
  let j = job_seg(h)
  if j < 0 {
    return -1
  }
  let hdr = rtisi_hdr.unsafe_get(j)
  if which == 0 {
    hdr.unsafe_get(15)
  } else if which == 1 {
    hdr.unsafe_get(31)
  } else {
    -1
  }
}

///|
/// 主缓冲里 `out`（波形输出，`samples+l` 个元素）与前缀 `mag`（`frames×bins` 个）的长度，
/// 宿主拿它定视图长度。`which`：0 mag 长、1 out 长。
#export_name("dsp_rtisi_len")
pub fn rtisi_len(h : Int, which : Int) -> Int {
  let j = job_seg(h)
  if j < 0 {
    return 0
  }
  let hdr = rtisi_hdr.unsafe_get(j)
  if which == 0 {
    hdr.unsafe_get(0) * hdr.unsafe_get(1)
  } else {
    hdr.unsafe_get(9)
  }
}

///|
#export_name("dsp_rtisi_close")
pub fn rtisi_close(h : Int) -> Unit {
  let j = job_seg(h)
  if j < 0 {
    return
  }
  let slot = rtisi_hdr.unsafe_get(j).unsafe_get(8)
  slot_close(slot)
  rtisi_hdr.unsafe_get(j).unsafe_set(29, 0)
  job_close(h)
}

///|
/// 一次调用的全部上下文。逐帧循环里要读十几处偏移，装成一个结构比一路传参干净。
priv struct Rt {
  arena : FixedArray[Double]
  slot : FixedArray[Double]
  slot_id : Int
  size : Int
  full : Int
  bins : Int
  l : Int
  a : Int
  padded : Int
  span : Int
  off_mag : Int
  off_warm : Int
  off_local : Int
  off_out : Int
  off_cos : Int
  off_sin : Int
  off_amp : Int
  off_pcos : Int
  off_psin : Int
  off_pamp : Int
  off_work : Int
  off_workim : Int
  off_band : Int
  off_levels : Int
  /// `levels` 住的字节段。放在这里是为了 `rt_fit` 一次下标读就够 —— 没有地址参与。
  levels : FixedArray[Byte]
  has_band : Bool
  hann : FixedArray[Double]
}

///|
/// 幅度落点的取法。有频带表时：`levels` 一个字节只有 256 种取值，于是「那两档边界」
/// 也最多 256 组 —— 表在 `dsp_rtisi_open` 之后由宿主按参照实现同一条表达式算好写进来，
/// 于是这里是一次字节读 + 两次表读，而不是每元素现算两个 `exp`。
/// 没频带表时退回硬投影：幅度恒取目标值（与加软约束之前逐位相同）。
fn rt_fit(c : Rt, d : Double, i : Int) -> Double {
  if !c.has_band {
    return c.arena.unsafe_get(c.off_mag + i)
  }
  let lv = c.levels.unsafe_get(c.off_levels + i).to_int()
  let lo = c.arena.unsafe_get(c.off_band + lv)
  if d < lo {
    return lo
  }
  let hi = c.arena.unsafe_get(c.off_band + 256 + lv)
  if d > hi {
    return hi
  }
  d
}

///|
/// 把 `local` 卸空、再把 `out[at …]` 灌进去。
fn rt_load(c : Rt, at : Int) -> Unit {
  for n = 0; n < c.span; n = n + 1 {
    c.arena.unsafe_set(c.off_local + n, 0.0)
  }
  let room = c.padded - at
  let avail = if c.span < room { c.span } else { room }
  if avail > 0 {
    for n = 0; n < avail; n = n + 1 {
      c.arena.unsafe_set(c.off_local + n, c.arena.unsafe_get(c.off_out + at + n))
    }
  }
}

///|
/// 只定相位：从 `warm[from …]` 取相位，幅度如实填 0。
/// 硬投影下幅度恒取目标值、不看 `amp`，所以这与没这一步时逐位相同；
/// 软约束下则让它从 0 起步，地板那一档这才真的能落到 0。
fn rt_put(c : Rt, kk : Int, from : Int) -> Unit {
  let at = kk * c.bins
  for b = 0; b < c.bins; b = b + 1 {
    let p = c.arena.unsafe_get(c.off_warm + from + b)
    c.arena.unsafe_set(c.off_cos + at + b, @math.cos(p))
    c.arena.unsafe_set(c.off_sin + at + b, @math.sin(p))
    c.arena.unsafe_set(c.off_amp + at + b, 0.0)
  }
}

///|
/// 把槽位 `kk` 的半谱填进 `pair` 的第 `side` 条（0 → r1/i1，1 → r2/i2）。
fn rt_fill(c : Rt, f : Int, kk : Int, side : Int) -> Unit {
  let base = f * c.bins
  let at = kk * c.bins
  let rr = if side == 0 { pair_off(0, c.size) } else { pair_off(2, c.size) }
  let ii = if side == 0 { pair_off(1, c.size) } else { pair_off(3, c.size) }
  for b = 0; b < c.bins; b = b + 1 {
    let g = rt_fit(c, c.arena.unsafe_get(c.off_amp + at + b), base + b)
    c.slot.unsafe_set(rr + b, g * c.arena.unsafe_get(c.off_cos + at + b))
    c.slot.unsafe_set(ii + b, g * c.arena.unsafe_get(c.off_sin + at + b))
  }
  // 行数可能小于 full（图读回来的精确谱被 win/2+1 夹过）。补零与 `mirrorSpectrum` 里那段同义。
  for b = c.bins; b < c.full; b = b + 1 {
    c.slot.unsafe_set(rr + b, 0.0)
    c.slot.unsafe_set(ii + b, 0.0)
  }
}

///|
/// 一次反变换铺两条。`k1 < 0`：只铺 `k0`，另一条喂零。
/// `m` 是本帧序号 —— 槽位 `kk` 对应的是**第 `m+kk` 帧**的幅度。
fn rt_lay(c : Rt, m : Int, k0 : Int, k1 : Int) -> Unit {
  rt_fill(c, m + k0, k0, 0)
  let x1 = pair_off(4, c.size)
  let x2 = pair_off(5, c.size)
  if k1 >= 0 {
    rt_fill(c, m + k1, k1, 1)
  } else {
    let r2 = pair_off(2, c.size)
    let i2 = pair_off(3, c.size)
    for b = 0; b < c.full; b = b + 1 {
      c.slot.unsafe_set(r2 + b, 0.0)
      c.slot.unsafe_set(i2 + b, 0.0)
    }
  }
  pair_inverse(c.slot_id)
  // kk ≤ K ⇒ from + L ≤ K·a + L = span，不必夹边界（与参照实现一致）。
  let from0 = k0 * c.a
  for n = 0; n < c.l; n = n + 1 {
    c.arena.unsafe_set(
      c.off_local + from0 + n,
      c.arena.unsafe_get(c.off_local + from0 + n) +
      c.slot.unsafe_get(x1 + n) *
      c.hann.unsafe_get(n),
    )
  }
  if k1 >= 0 {
    let from1 = k1 * c.a
    for n = 0; n < c.l; n = n + 1 {
      c.arena.unsafe_set(
        c.off_local + from1 + n,
        c.arena.unsafe_get(c.off_local + from1 + n) +
        c.slot.unsafe_get(x2 + n) *
        c.hann.unsafe_get(n),
      )
    }
  }
}

///|
/// 从 `pair` 的第 `side` 条半谱读回槽位 `kk` 的单位相量与幅度。
fn rt_unpack(c : Rt, kk : Int, side : Int) -> Unit {
  let rr = if side == 0 { pair_off(0, c.size) } else { pair_off(2, c.size) }
  let ii = if side == 0 { pair_off(1, c.size) } else { pair_off(3, c.size) }
  let at = kk * c.bins
  for b = 0; b < c.bins; b = b + 1 {
    let r = c.slot.unsafe_get(rr + b)
    let i = c.slot.unsafe_get(ii + b)
    let d = (r * r + i * i).sqrt()
    c.arena.unsafe_set(c.off_cos + at + b, if d > 0.0 { r / d } else { 1.0 })
    c.arena.unsafe_set(c.off_sin + at + b, if d > 0.0 { i / d } else { 0.0 })
    c.arena.unsafe_set(c.off_amp + at + b, d)
  }
}

///|
/// 一次正变换读两条。`k1 < 0`：只读 `k0`。
fn rt_read(c : Rt, k0 : Int, k1 : Int) -> Unit {
  let x1 = pair_off(4, c.size)
  let x2 = pair_off(5, c.size)
  let from0 = k0 * c.a
  for n = 0; n < c.l; n = n + 1 {
    c.slot.unsafe_set(x1 + n, c.arena.unsafe_get(c.off_local + from0 + n) * c.hann.unsafe_get(n))
  }
  if k1 >= 0 {
    let from1 = k1 * c.a
    for n = 0; n < c.l; n = n + 1 {
      c.slot.unsafe_set(
        x2 + n,
        c.arena.unsafe_get(c.off_local + from1 + n) * c.hann.unsafe_get(n),
      )
    }
  } else {
    for n = 0; n < c.l; n = n + 1 {
      c.slot.unsafe_set(x2 + n, 0.0)
    }
  }
  pair_forward(c.slot_id)
  rt_unpack(c, k0, 0)
  if k1 >= 0 {
    rt_unpack(c, k1, 1)
  }
}

///|
/// 打包时只留单数槽位：相邻两帧共用一个复变换。`k+1 >= act` 时凑不出第二条。
fn rt_second(kk : Int, act : Int) -> Int {
  if kk + 1 < act { kk + 1 } else { -1 }
}

///|
/// 推进 [from, to) 帧。返回实际推进到的帧号（调用方按它续块）。
#export_name("dsp_rtisi_run")
pub fn rtisi_run(h : Int, from : Int, to : Int) -> Int {
  let j = job_seg(h)
  if j < 0 {
    return 0
  }
  let hdr = rtisi_hdr.unsafe_get(j)
  let frames = hdr.unsafe_get(0)
  let bins = hdr.unsafe_get(1)
  let l = hdr.unsafe_get(2)
  let a = hdr.unsafe_get(3)
  let k = hdr.unsafe_get(5)
  let iters = hdr.unsafe_get(6)
  let plan_i = hdr.unsafe_get(7)
  let slot_id = hdr.unsafe_get(8)
  let has_warm = hdr.unsafe_get(27) != 0
  let arena = job_d(h)
  let c : Rt = {
    arena,
    slot: slot_mem.unsafe_get(slot_id),
    slot_id,
    size: l,
    full: hdr.unsafe_get(11),
    bins,
    l,
    a,
    padded: hdr.unsafe_get(9),
    span: hdr.unsafe_get(10),
    off_mag: hdr.unsafe_get(12),
    off_warm: hdr.unsafe_get(13),
    off_local: hdr.unsafe_get(17),
    off_out: hdr.unsafe_get(16),
    off_cos: hdr.unsafe_get(20),
    off_sin: hdr.unsafe_get(21),
    off_amp: hdr.unsafe_get(22),
    off_pcos: hdr.unsafe_get(23),
    off_psin: hdr.unsafe_get(24),
    off_pamp: hdr.unsafe_get(25),
    off_work: hdr.unsafe_get(18),
    off_workim: hdr.unsafe_get(19),
    off_band: hdr.unsafe_get(26),
    off_levels: hdr.unsafe_get(15),
    levels: job_b(h),
    has_band: hdr.unsafe_get(28) != 0,
    hann: plan_hann.unsafe_get(plan_i),
  }

  let mut m = if from < 0 { 0 } else { from }
  let stop = if to > frames { frames } else { to }
  while m < stop {
    let act = if k + 1 < frames - m { k + 1 } else { frames - m }
    let at = m * a
    rt_load(c, at)

    if m == 0 {
      if has_warm {
        for kk = 0; kk < act; kk = kk + 1 {
          rt_put(c, kk, kk * bins)
        }
      } else {
        let mut kk = 0
        while kk < act {
          rt_read(c, kk, rt_second(kk, act))
          kk = kk + 2
        }
      }
    } else {
      for kk = 0; kk < act; kk = kk + 1 {
        let next = (kk + 1) * bins
        let here = kk * bins
        if kk <= k - 1 {
          for b = 0; b < bins; b = b + 1 {
            c.arena.unsafe_set(c.off_cos + here + b, c.arena.unsafe_get(c.off_pcos + next + b))
            c.arena.unsafe_set(c.off_sin + here + b, c.arena.unsafe_get(c.off_psin + next + b))
            c.arena.unsafe_set(c.off_amp + here + b, c.arena.unsafe_get(c.off_pamp + next + b))
          }
        } else if has_warm {
          rt_put(c, kk, (m + kk) * bins)
        } else {
          for b = 0; b < bins; b = b + 1 {
            c.arena.unsafe_set(c.off_cos + here + b, 1.0)
            c.arena.unsafe_set(c.off_sin + here + b, 0.0)
            c.arena.unsafe_set(c.off_amp + here + b, 0.0)
          }
        }
      }
      // 第 0 帧的相位从已经写进 out 的过去帧重读：逐帧推进才不会在帧界上出爆音。
      rt_read(c, 0, -1)
    }

    for _it = 0; _it < iters; _it = _it + 1 {
      rt_load(c, at)
      let mut kk = 0
      while kk < act {
        rt_lay(c, m, kk, rt_second(kk, act))
        kk = kk + 2
      }
      kk = 0
      while kk < act {
        rt_read(c, kk, rt_second(kk, act))
        kk = kk + 2
      }
    }

    // 收尾：只写槽位 0，凑不出第二条，走单条复变换（借会话槽的 zr/zi）。
    let base = m * bins
    for b = 0; b < bins; b = b + 1 {
      let g = rt_fit(c, c.arena.unsafe_get(c.off_amp + b), base + b)
      c.arena.unsafe_set(c.off_work + b, g * c.arena.unsafe_get(c.off_cos + b))
      c.arena.unsafe_set(c.off_workim + b, g * c.arena.unsafe_get(c.off_sin + b))
    }
    for b = bins; b < c.full; b = b + 1 {
      c.arena.unsafe_set(c.off_work + b, 0.0)
      c.arena.unsafe_set(c.off_workim + b, 0.0)
    }
    for n = 0; n < l; n = n + 1 {
      c.slot.unsafe_set(n, c.arena.unsafe_get(c.off_work + n))
      c.slot.unsafe_set(l + n, c.arena.unsafe_get(c.off_workim + n))
    }
    // mirrorSpectrum(re, im, full, size)：DC 与奈奎斯特点的虚部置零
    c.slot.unsafe_set(l, 0.0)
    c.slot.unsafe_set(l + c.full - 1, 0.0)
    for b = 1; b < c.full - 1; b = b + 1 {
      c.slot.unsafe_set(l - b, c.slot.unsafe_get(b))
      c.slot.unsafe_set(2 * l - b, (-1.0) * c.slot.unsafe_get(l + b))
    }
    fft_at(plan_i, c.slot, 0, l, true)
    let room = if l < c.padded - at { l } else { c.padded - at }
    for n = 0; n < room; n = n + 1 {
      c.arena.unsafe_set(
        c.off_out + at + n,
        c.arena.unsafe_get(c.off_out + at + n) + c.slot.unsafe_get(n) * c.hann.unsafe_get(n),
      )
    }

    let state = (k + 1) * bins
    for b = 0; b < state; b = b + 1 {
      c.arena.unsafe_set(c.off_pcos + b, c.arena.unsafe_get(c.off_cos + b))
      c.arena.unsafe_set(c.off_psin + b, c.arena.unsafe_get(c.off_sin + b))
      c.arena.unsafe_set(c.off_pamp + b, c.arena.unsafe_get(c.off_amp + b))
    }
    m = m + 1
  }
  hdr.unsafe_set(29, m)
  m
}

///|
/// 全帧跑完之后的收束：重叠归一化 + 边界淡入淡出，写进 `y`。
/// 与参照实现同一套式子 —— `cover` 的累加顺序也是（按帧升序），逐位同值。
#export_name("dsp_rtisi_finish")
pub fn rtisi_finish(h : Int) -> Unit {
  let j = job_seg(h)
  if j < 0 {
    return
  }
  let hdr = rtisi_hdr.unsafe_get(j)
  let frames = hdr.unsafe_get(0)
  let l = hdr.unsafe_get(2)
  let a = hdr.unsafe_get(3)
  let samples = hdr.unsafe_get(4)
  let plan_i = hdr.unsafe_get(7)
  let padded = hdr.unsafe_get(9)
  let off_y = hdr.unsafe_get(14)
  let off_out = hdr.unsafe_get(16)
  let off_cover = hdr.unsafe_get(30)
  let arena = job_d(h)
  let w = plan_hann.unsafe_get(plan_i)
  for f = 0; f < frames; f = f + 1 {
    let s = f * a
    for mh = 0; mh < l; mh = mh + 1 {
      let ww = w.unsafe_get(mh) * w.unsafe_get(mh)
      arena.unsafe_set(off_cover + s + mh, arena.unsafe_get(off_cover + s + mh) + ww)
    }
  }
  let mut top = 0.0
  for i = 0; i < padded; i = i + 1 {
    let v = arena.unsafe_get(off_cover + i)
    if v > top {
      top = v
    }
  }
  let floor = top * 0.05
  let half = l / 2
  for i = 0; i < samples; i = i + 1 {
    let c = arena.unsafe_get(off_cover + half + i)
    arena.unsafe_set(
      off_y + i,
      if c > floor { arena.unsafe_get(off_out + half + i) / c } else { 0.0 },
    )
  }
}
