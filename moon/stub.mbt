// 票根（stub）：图底部 8 行的条码，把「宽 / 采样率 / 窗长 / 是否可逆」写进像素。
//
// 这是整条链上最干净的一段 —— **纯整数**：位流、CRC8、游程、阈值比较，一次超越函数都没有。
// 所以搬进内核没有数值等价性的顾虑（不谈 ulp，只谈逐字节相同）。它同时是「TS 只留 IO」
// 这条路上的样板：逻辑在下面，宿主那边一个像素循环都没有。
//
// 三条与宿主的分工（**统一约定**，后续模块照此办理）：
//   1. 段由宿主用 `dsp_job_open(内核给的尺寸)` 占，句柄传进来；内核按正常下标读写自己那段
//      （像素走**字节段**：`dsp_job_b` 那把 `FixedArray[Byte]`）。宿主只是搬数据。
//   2. 容量不够或参数非法一律返回 0 / 空，宿主据此走降级路径 —— 降级，不是崩。
//   3. 内核不缓存跨调用的状态：句柄归还即忘。
//
// 尺寸表（`*_bytes` / `*_words`）是**导出面的一部分**：宿主不自己算布局。
//
// 行为断言全在 `moon/stub_wbtest.mbt`。

///|
/// 票根占的像素行数。宿主侧 `STUB_ROWS` 与它必须是同一个数。
let stub_rows : Int = 8

///|
/// 位流开头 8 位固定是 `1010` 前缀 + `1011` 魔数。前缀不进 CRC 覆盖范围。
let stub_magic : Int = 0b1011

///|
let stub_dark : Int = 20

///|
let stub_light : Int = 230

///|
let stub_crc_poly : Int = 0x07

///|
/// 票根占的像素行数。**格式的一部分**，宿主不自己写这个数 —— 它决定票根画在图底部哪几行，
/// 两处差一个就是「画得出来、读不回来」。导出给宿主：`dsp_stub_rows`。
#export_name("dsp_stub_rows")
pub fn stub_rows_of() -> Int {
  stub_rows
}

///|
/// 采样率梯子上的第 `i` 档；越界给 0。宿主拿它把打包结果里的 4 位下标换回采样率，
/// 于是这张表只存在于一个地方（格式的一部分，不能重排）。
#export_name("dsp_stub_sr")
pub fn stub_sr_at(i : Int) -> Int {
  if i < 0 || i >= stub_sr.length() {
    return 0
  }
  stub_sr.unsafe_get(i)
}

///|
/// 窗长梯子上的第 `i` 档；越界给 0。同上，宿主不自己存这张表。
#export_name("dsp_stub_win")
pub fn stub_win_at(i : Int) -> Int {
  if i < 0 || i >= stub_wins.length() {
    return 0
  }
  stub_wins.unsafe_get(i)
}

///|
/// 采样率梯子。位流里存的是**下标**（4 位），所以这张表是格式的一部分，不能重排。
let stub_sr : FixedArray[Int] = [
  8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000, 176400, 192000,
]

///|
/// 窗长梯子（2 位下标）。
let stub_wins : FixedArray[Int] = [256, 512, 1024, 2048]

///|
/// 宽度的三档前缀：8 / 12 / 16 位。
let stub_wn : FixedArray[Int] = [8, 12, 16, 0]

///|
/// 位流暂存。整条票根最多 41 位（4+4+2+16+4+2+1+8），留一倍余量。
/// 顶层没有 `let mut`，可变全局一律包 `Ref` —— 这张只是被读写，不算可变绑定，按 `rtisi_scratch` 办。
let stub_scratch : FixedArray[Int] = FixedArray::make(96, 0)

///|
/// 认票根时收集到的那几十位。上限 6+16+15 = 37，留余量到 64。
let stub_bitbuf : FixedArray[Int] = FixedArray::make(64, 0)

///|
fn stub_sr_index(sr : Int) -> Int {
  let mut i = 0
  while i < stub_sr.length() {
    if stub_sr.unsafe_get(i) == sr {
      return i
    }
    i = i + 1
  }
  -1
}

///|
fn stub_win_index(win : Int) -> Int {
  let mut i = 0
  while i < stub_wins.length() {
    if stub_wins.unsafe_get(i) == win {
      return i
    }
    i = i + 1
  }
  -1
}

///|
/// 一位占几个像素：宽图给 4，中图 2，窄图 1。窄图里位流会被压到不能更细。
fn stub_bit_px(w : Int) -> Int {
  if w >= 160 {
    4
  } else if w >= 70 {
    2
  } else {
    1
  }
}

///|
/// 宽度的位宽（8 / 12 / 16）。
fn stub_wbits(w : Int) -> Int {
  if w <= 0xff {
    8
  } else if w <= 0xfff {
    12
  } else {
    16
  }
}

///|
/// 票根跨度：2 像素的定位头 + 位流摊开后的宽度。
fn stub_span(w : Int) -> Int {
  2 + (25 + stub_wbits(w)) * stub_bit_px(w)
}

///|
/// 一条票根能被**认出来**的剖面长度下限（像素）。由解码侧决定，与 `stub_span` 无关：
/// 剖面比这更短时，连定位头带位流都摊不下。
///
/// 数值本身是保守取整的遗留值（位流最长 41 位，`bitPx = 1` 时摊开 41 像素，加头部与
/// 留白约 45），这里不追究它能不能再小。**要紧的是它与 `stub_fits` 共用同一个定义** ——
/// 分开写会漂移，于是出现「`stub_fits` 说装得下、却永远认不回来」的宽度档：
/// 39~45 原来就是这样，图里白占 8 行条码，读的时候必失败。
///
/// 「装得下 ⟺ 认得出」这条等价由 `stub_wbtest.mbt` 逐宽度钉住（是规则，不是清单）。
let stub_min_decode : Int = 46

///|
/// CRC8（多项式 `0x07`），按位算 —— 对应 TS 的 `crc8(bits)`，覆盖范围由调用方给。
fn stub_crc8(bits : FixedArray[Int], from : Int, len : Int) -> Int {
  let mut crc = 0xff
  for i = 0; i < len; i = i + 1 {
    crc = crc ^ (bits.unsafe_get(from + i) << 7)
    for _j = 0; _j < 8; _j = _j + 1 {
      crc = if (crc & 0x80) != 0 {
        ((crc << 1) ^ stub_crc_poly) & 0xff
      } else {
        (crc << 1) & 0xff
      }
    }
  }
  crc
}

///|
/// 大端压入 `n` 位，返回新的写指针。
fn stub_push(at : Int, v : Int, n : Int) -> Int {
  for i = 0; i < n; i = i + 1 {
    stub_scratch.unsafe_set(at + i, (v >> (n - 1 - i)) & 1)
  }
  at + n
}

///|
/// 按大端读 `n` 位。
fn stub_get(bits : FixedArray[Int], at : Int, n : Int) -> Int {
  let mut v = 0
  for i = 0; i < n; i = i + 1 {
    v = (v << 1) | bits.unsafe_get(at + i)
  }
  v
}

///|
/// 把参数编成位流，写进 `stub_scratch`，返回位数；0 = 参数放不下（宿主与参照同一判据）。
fn stub_bits(w : Int, sr : Int, win : Int, exact : Int) -> Int {
  let si = stub_sr_index(sr)
  let wi = stub_win_index(win)
  if si < 0 || wi < 0 || w < 2 || w > 0xffff {
    return 0
  }
  let wbits = stub_wbits(w)
  let pre = if w <= 0xff {
    0
  } else if w <= 0xfff {
    1
  } else {
    2
  }
  let mut at = 0
  at = stub_push(at, 0b1010, 4)
  at = stub_push(at, stub_magic, 4)
  at = stub_push(at, pre, 2)
  at = stub_push(at, w, wbits)
  at = stub_push(at, si, 4)
  at = stub_push(at, wi, 2)
  at = stub_push(at, exact, 1)
  // CRC 覆盖的是**去掉 4 位前缀**之后的那一段，认的时候也从下标 0 起算同一段。
  at = stub_push(at, stub_crc8(stub_scratch, 4, at - 4), 8)
  at
}

///|
/// 第 `x` 列的亮度。两个窗口（左起 2、右起 `w − span`）只在宽图上同时存在，
/// 而那时二者必不重叠（`w ≥ 2·span + 6` 是判据），所以逐列算与「先铺一行再覆盖」等价。
///
/// 位流下标不必夹边界：`at < span = 2 + n·step` 保证 `(at − 2)/step < n`。
fn stub_lum_at(x : Int, w : Int) -> Int {
  let span = stub_span(w)
  let step = stub_bit_px(w)
  let mut at = -1
  if x >= 2 && x < 2 + span {
    at = x - 2
  } else if w >= 2 * span + 6 && x >= w - span {
    at = x - (w - span)
  }
  if at < 0 {
    return stub_dark
  }
  if at < 2 || stub_scratch.unsafe_get((at - 2) / step) == 0 {
    stub_dark
  } else {
    stub_light
  }
}

///|
/// 画一张票根要多大一段（**字节**段）。宿主拿它开作业区，不要自己算。
#export_name("dsp_stub_paint_bytes")
pub fn stub_paint_bytes(w : Int) -> Int {
  w * stub_rows * 4
}

///|
/// 一行亮度要多大一段（字节段）。
#export_name("dsp_stub_luma_bytes")
pub fn stub_luma_bytes(w : Int) -> Int {
  w
}

///|
/// 认票根要多大一段：剖面 `n` 个 Double + 游程 `2n` 个，外加一点余量。
#export_name("dsp_stub_decode_words")
pub fn stub_decode_words(n : Int) -> Int {
  3 * n + 8
}

///|
/// 图的宽度装得下一条**认得回来**的票根吗（宿主侧 `stubFits` 的同一个判据）。
///
/// 两道条件缺一不可，且都取**恰好**的线：位流摊得开（`span + 2`，与 `stub_paint`
/// 同一道线），剖面长到解码侧收得下（`stub_min_decode`）。留余量会让判据比实际能力
/// 更严 —— 原来那个 `+ 4` 就白白拒掉了两档明明能读回来的宽度（`bit_px` 跳档处）。
#export_name("dsp_stub_fits")
pub fn stub_fits(w : Int) -> Int {
  if w >= stub_span(w) + 2 && w >= stub_min_decode {
    1
  } else {
    0
  }
}

///|
/// 把 `w × 8` 的 RGBA 直接写进作业区（段首起算）。返回 1；0 = 参数放不下或段太小。
///
/// 宿主拿到之后整块 `set` 进 ImageData 的底部 —— 那边一个像素循环都不用写。
#export_name("dsp_stub_paint")
pub fn stub_paint(h : Int, w : Int, sr : Int, win : Int, exact : Int) -> Int {
  if job_seg(h) < 0 {
    return 0
  }
  let n = stub_bits(w, sr, win, exact)
  if n == 0 || w < stub_span(w) + 2 {
    return 0
  }
  if job_bytes_of(h) < stub_paint_bytes(w) {
    return 0
  }
  let dst = job_b(h)
  // **按列推进**：亮度一列只算一次，再刷 8 行。反过来（按行推进）会把位流解释
  // 重做 8 遍 —— 实测那样画一张 65535 宽的票根比 TS 还慢 3 倍（TS 是先算一行再刷）。
  // 像素 4 字节一组，一次 `unsafe_write_uint32_le` 顶四次字节写。
  let alpha : UInt = 255 << 24
  for x = 0; x < w; x = x + 1 {
    let lum = stub_lum_at(x, w)
    // R = G = B = 亮度，A = 255 —— 小端写下就是 [lum, lum, lum, 255]。
    let px = (lum | (lum << 8) | (lum << 16)).reinterpret_as_uint() | alpha
    for y = 0; y < stub_rows; y = y + 1 {
      dst.unsafe_write_uint32_le((y * w + x) * 4, px)
    }
  }
  1
}

///|
/// 只写一行亮度（`w` 个字节，段首起算）。可逆档要的不是一块像素，而是一条带。
#export_name("dsp_stub_luma")
pub fn stub_luma(h : Int, w : Int, sr : Int, win : Int, exact : Int) -> Int {
  if job_seg(h) < 0 {
    return 0
  }
  let n = stub_bits(w, sr, win, exact)
  if n == 0 || w < stub_span(w) + 2 {
    return 0
  }
  if job_bytes_of(h) < stub_luma_bytes(w) {
    return 0
  }
  let dst = job_b(h)
  for x = 0; x < w; x = x + 1 {
    dst.unsafe_set(x, stub_lum_at(x, w).to_byte())
  }
  1
}

///|
/// 段内游程表的一格：`[cur, len]` 挨着放，一个游程两个 Double。`field`：0 取 `cur`、1 取 `len`。
fn stub_run(mem : FixedArray[Double], runs : Int, i : Int, field : Int) -> Int {
  mem.unsafe_get(runs + 2 * i + field).to_int()
}

///|
/// 认一条票根。`n` 是一维亮度剖面的长度（段的头 `n` 个 Double），游程表用段的后 `2n` 个。
///
/// 返回**打包的 i32**：0 = 没认出来；否则
/// `width | si << 16 | wi << 20 | exact << 22`。
/// `width ≥ 2` 保证真结果恒非 0，所以 0 可以当失败用，不必再加一个出参缓冲。
#export_name("dsp_stub_decode")
pub fn stub_decode(h : Int, n : Int) -> Int {
  if job_seg(h) < 0 {
    return 0
  }
  if n < stub_min_decode || job_words_of(h) < stub_decode_words(n) {
    return 0
  }
  // 作业的主缓冲就是这一段自己的数组，段首即下标 0 —— 没有段基址要折。
  let mem = job_d(h)
  let prof = 0
  let runs = n
  // ① 二值化的门限取中点，跨度不够就整段否掉（照片、涂鸦走到这里就回去了）。
  let mut lo = mem.unsafe_get(prof)
  let mut hi = lo
  for i = 1; i < n; i = i + 1 {
    let v = mem.unsafe_get(prof + i)
    if v < lo {
      lo = v
    }
    if v > hi {
      hi = v
    }
  }
  if hi - lo < 120.0 {
    return 0
  }
  let th = (lo + hi) / 2.0
  // ② 压成游程。参照实现也是「先整条压完、再滑窗」，这里照办 —— 边界（首游程、末游程）
  // 的写法两边必须逐字对齐，否则同一个剖面会压出不同的游程数。
  let mut nr = 0
  let mut cur = if mem.unsafe_get(prof) >= th {
    1.0
  } else {
    0.0
  }
  let mut len = 0
  for i = 0; i < n; i = i + 1 {
    let v = if mem.unsafe_get(prof + i) >= th {
      1.0
    } else {
      0.0
    }
    if v == cur {
      len = len + 1
    } else {
      mem.unsafe_set(runs + 2 * nr, cur)
      mem.unsafe_set(runs + 2 * nr + 1, len.to_double())
      nr = nr + 1
      cur = v
      len = 1
    }
  }
  mem.unsafe_set(runs + 2 * nr, cur)
  mem.unsafe_set(runs + 2 * nr + 1, len.to_double())
  nr = nr + 1
  // ③ 滑四游程找定位头，然后从后面流式收位。
  let mut r = 0
  while r + 4 < nr {
    let c0 = stub_run(mem, runs, r, 0)
    let l0 = stub_run(mem, runs, r, 1)
    let c1 = stub_run(mem, runs, r + 1, 0)
    let l1 = stub_run(mem, runs, r + 1, 1)
    let c2 = stub_run(mem, runs, r + 2, 0)
    let l2 = stub_run(mem, runs, r + 2, 1)
    let c3 = stub_run(mem, runs, r + 3, 0)
    let l3 = stub_run(mem, runs, r + 3, 1)
    let total = (l0 + l1 + l2 + l3).to_double()
    let unit = total / 4.0
    // 四段必须同宽（各自恰好一个单位），否则这不是定位头。
    let ok = c0 == 1 &&
      c1 == 0 &&
      c2 == 1 &&
      c3 == 0 &&
      unit >= 0.3 &&
      stub_round(l0.to_double() / unit) == 1 &&
      stub_round(l1.to_double() / unit) == 1 &&
      stub_round(l2.to_double() / unit) == 1 &&
      stub_round(l3.to_double() / unit) == 1
    if ok {
      let mut nb = 0
      let mut total_bits = -1
      let mut wn = 0
      let mut bad = false
      let mut jj = r + 4
      while jj < nr {
        let v = stub_run(mem, runs, jj, 0)
        let l = stub_run(mem, runs, jj, 1)
        let mut count = stub_round(l.to_double() / unit)
        if count < 1 {
          count = 1
        }
        let mut k = 0
        while k < count {
          stub_bitbuf.unsafe_set(nb, v)
          nb = nb + 1
          if total_bits < 0 && nb >= 6 {
            let magic = (stub_bitbuf.unsafe_get(0) << 3) |
              (stub_bitbuf.unsafe_get(1) << 2) |
              (stub_bitbuf.unsafe_get(2) << 1) |
              stub_bitbuf.unsafe_get(3)
            wn = stub_wn.unsafe_get(stub_bitbuf.unsafe_get(4) * 2 + stub_bitbuf.unsafe_get(5))
            if magic != stub_magic || wn == 0 {
              bad = true
              break
            }
            total_bits = 6 + wn + 15
          }
          if total_bits > 0 && nb >= total_bits {
            break
          }
          k = k + 1
        }
        if bad || (total_bits > 0 && nb >= total_bits) {
          break
        }
        jj = jj + 1
      }
      if !bad && total_bits >= 0 && nb == total_bits {
        let crc = stub_crc8(stub_bitbuf, 0, 13 + wn)
        if crc == stub_get(stub_bitbuf, 13 + wn, 8) {
          let width = stub_get(stub_bitbuf, 6, wn)
          let si = stub_get(stub_bitbuf, 6 + wn, 4)
          let wi = stub_get(stub_bitbuf, 10 + wn, 2)
          if si < stub_sr.length() && width >= 2 {
            let ex = if stub_get(stub_bitbuf, 12 + wn, 1) == 1 { 1 } else { 0 }
            return width | (si << 16) | (wi << 20) | (ex << 22)
          }
        }
      }
    }
    r = r + 1
  }
  0
}

///|
/// `Math.round` 的语义是 `floor(x + 0.5)`（对半朝正无穷 —— 与「四舍五入」在负数上不同），
/// 而这里的判据恰好可能落在 .5 上，所以不能拿「截断」凑数：自己写清楚。
fn stub_round(x : Double) -> Int {
  let t = (x + 0.5).to_int()
  if t.to_double() > x + 0.5 {
    t - 1
  } else {
    t
  }
}
