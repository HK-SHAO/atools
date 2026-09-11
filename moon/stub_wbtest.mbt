// 票根（stub）的白盒门禁。
//
// 这五条原本住在 `app/lib/stub.test.ts`（vitest）里，测的是 TS 那份实现；内核接上之后
// **整批搬到这里** —— 票根是纯整数逻辑，没有「差多少 ulp」这回事，要么逐字节相同、要么错。
//
// 补的两条是只有内核才谈得上的：CRC 真的被校验（翻一位必须拒），以及三个宽度前缀
// （8 / 12 / 16 位）各自都能往返 —— 参照实现那侧只测了其中一个（w=400，8 位档）。
//
// **这里不再有「段地址」这回事。** 像素住在作业的**字节段**（`FixedArray[Byte]`）里，
// 测试拿的是数组本身而不是地址 —— 数组不搬家，于是早先那句「地址不跨 `job_open` 存活、
// 用一次现取一次」的诫命连同它盯着的那类错一起消失了。

///|
/// 画一张票根，返回句柄。调用方用完 `job_close`。
fn paint(w : Int, sr : Int, win : Int, exact : Bool) -> Int raise {
  let h = job_open(0, stub_paint_bytes(w))
  assert_true(h >= 1)
  assert_eq(stub_paint(h, w, sr, win, if exact { 1 } else { 0 }), 1)
  h
}

///|
/// 一行 RGBA 的亮度。
fn band_at(buf : FixedArray[Byte], x : Int, y : Int, w : Int) -> Double {
  let p = (y * w + x) * 4
  let r = buf.unsafe_get(p).to_double()
  let g = buf.unsafe_get(p + 1).to_double()
  let b = buf.unsafe_get(p + 2).to_double()
  0.299 * r + 0.587 * g + 0.114 * b
}

///|
/// 票根块的一维亮度剖面（按列取行均值）。
///
/// **行号从 0 起**：`stub_paint` 写的就是这 8 行的块，宿主再把它整块搬到图底
/// —— 参照实现那边是「在图里从 `h − rows` 往 `h` 取」，这里没有那张图，别混。
fn profile(buf : FixedArray[Byte], w : Int, rows : Int) -> FixedArray[Double] {
  let out = FixedArray::make(w, 0.0)
  for x = 0; x < w; x = x + 1 {
    let mut s = 0.0
    for y = 0; y < rows; y = y + 1 {
      s = s + band_at(buf, x, y, w)
    }
    out.unsafe_set(x, s / rows.to_double())
  }
  out
}

///|
/// 认一条剖面。自己开一次作业把剖面写进主缓冲。
fn decode(prof : FixedArray[Double]) -> Int raise {
  let n = prof.length()
  let h = job_open(stub_decode_words(n), 0)
  assert_true(h >= 1)
  let mem = job_d(h)
  for i = 0; i < n; i = i + 1 {
    mem.unsafe_set(i, prof.unsafe_get(i))
  }
  let packed = stub_decode(h, n)
  job_close(h)
  packed
}

///|
/// 打包字段。与 `dsp_stub_decode` 的注释一一对应。
fn pk_width(p : Int) -> Int {
  p & 0xffff
}

///|
fn pk_sr(p : Int) -> Int {
  stub_sr.unsafe_get((p >> 16) & 0xf)
}

///|
fn pk_win(p : Int) -> Int {
  stub_wins.unsafe_get((p >> 20) & 3)
}

///|
fn pk_exact(p : Int) -> Bool {
  ((p >> 22) & 1) == 1
}

///|
/// `Math.ceil`：`to_int` 是朝零截断，负数上会向上取，所以这里只对非负输入成立。
fn stub_ceil(x : Double) -> Int {
  let t = x.to_int()
  if t.to_double() < x {
    t + 1
  } else {
    t
  }
}

///|
/// 「缩放 + 模拟 JPEG 抖动」：先按 `s` 缩放的列均值，再叠一条确定性的正弦噪声。
/// 噪声不是装饰 —— 它模拟的正是 JPEG 在窄条上的振铃，去掉了这条用例就不必写。
fn resample_profile(
  buf : FixedArray[Byte],
  w : Int,
  rows : Int,
  s : Double,
  noise : Double
) -> FixedArray[Double] {
  let n = stub_round(w.to_double() * s)
  let out = FixedArray::make(n, 0.0)
  for x = 0; x < n; x = x + 1 {
    let x0 = x.to_double() / s
    let x1 = (x + 1).to_double() / s
    let lo = x0.to_int()
    // 与参照实现的 `Math.max(Math.floor(x0) + 1, Math.ceil(x1))` 同一条。
    let mut hi = lo + 1
    let c1 = stub_ceil(x1)
    if c1 > hi {
      hi = c1
    }
    let mut sum = 0.0
    let mut cnt = 0
    let mut xi = lo
    while xi < hi {
      if xi < w {
        let mut row_sum = 0.0
        for y = 0; y < rows; y = y + 1 {
          row_sum = row_sum + band_at(buf, xi, y, w)
        }
        sum = sum + row_sum / rows.to_double()
        cnt = cnt + 1
      }
      xi = xi + 1
    }
    let mid = if cnt > 0 { sum / cnt.to_double() } else { 0.0 }
    out.unsafe_set(x, mid + @math.sin(x.to_double() * 12.9898) * noise)
  }
  out
}

///|
test "白盒：1:1 精确往返（画下去、抽回来、认得出来）" {
  let w = 400
  let jh = paint(w, 44100, 512, true)
  let p = decode(profile(job_b(jh), w, stub_rows))
  assert_true(p != 0)
  assert_eq(pk_width(p), w)
  assert_eq(pk_sr(p), 44100)
  assert_eq(pk_win(p), 512)
  assert_true(pk_exact(p))
  job_close(jh)
}

///|
test "白盒：缩放 0.5× / 0.75× / 0.9× 加抖动后仍认得出来" {
  let w = 600
  let jh = paint(w, 48000, 1024, false)
  for s in [0.5, 0.75, 0.9] {
    let p = decode(resample_profile(job_b(jh), w, stub_rows, s, 6.0))
    assert_true(p != 0)
    assert_eq(pk_width(p), w)
    assert_eq(pk_sr(p), 48000)
    assert_eq(pk_win(p), 1024)
    assert_true(!pk_exact(p))
  }
  job_close(jh)
}

///|
/// 窄图的一遍：底部那 8 行认得出；**没有票根的地方必须认不出** —— 这才是这条用例的另一半。
/// （参照实现那边用「同一张图的上沿」来表达；这里手上只有票根那块，就改用一条平坦剖面：
/// 图上没有票根的内容行，二值化之后就是一片同色，连定位头都找不到。）
test "白盒：窄图从底部认得出，没有票根的地方认不出" {
  let w = 160
  let jh = paint(w, 8000, 256, false)
  let p = decode(profile(job_b(jh), w, stub_rows))
  assert_true(p != 0)
  assert_eq(pk_width(p), w)
  assert_eq(pk_sr(p), 8000)
  assert_eq(pk_win(p), 256)
  let flat = FixedArray::make(w, 111.2)
  assert_eq(decode(flat), 0)
  job_close(jh)
}

///|
/// 翻掉位 `bit` 那一格的颜色（宽图 4 像素一格，正好一整格），8 行全翻。
/// 只对 `stub_bit_px(w) == 4` 的宽度成立（下面两处都 ≥ 160）。
fn flip_bit(buf : FixedArray[Byte], w : Int, bit : Int) -> Unit {
  for x = 4 + bit * 4; x < 8 + bit * 4; x = x + 1 {
    let cur = buf.unsafe_get(x * 4).to_int()
    let flip = if cur == stub_light { stub_dark } else { stub_light }
    for y = 0; y < stub_rows; y = y + 1 {
      let q = (y * w + x) * 4
      buf.unsafe_set(q, flip.to_byte())
      buf.unsafe_set(q + 1, flip.to_byte())
      buf.unsafe_set(q + 2, flip.to_byte())
    }
  }
}

///|
/// CRC 是真的在校验 —— 但**先得排除冗余把坏的那份救回来**。
///
/// 宽图（`w ≥ 2·span + 6`）把同一条票根画了两份，认的时候由 `r` 从左往右逐个候选试，
/// 所以坏掉左份会被右份接住 —— 这是设计如此，不是 CRC 失灵。
/// 于是「翻一位必须被拒」只能在**只画一份**的宽度上钉；顺手把冗余也钉住，
/// 免得有人觉得第二份是白画而删掉。
test "白盒：CRC 拦得住坏位流，而两份冗余里坏一份该被另一份接住" {
  // 只画一份：w = 200，span = 134，2·span + 6 = 274 > 200。
  let one = 200
  let jh = paint(one, 44100, 512, true)
  assert_true(decode(profile(job_b(jh), one, stub_rows)) != 0)
  flip_bit(job_b(jh), one, 8)
  assert_eq(decode(profile(job_b(jh), one, stub_rows)), 0)
  job_close(jh)
  // 画两份：只翻左份（x ∈ [36, 40) 落在左窗 [2, 168) 里），右份完好。
  let two = 400
  let j2 = paint(two, 44100, 512, true)
  flip_bit(job_b(j2), two, 8)
  let p = decode(profile(job_b(j2), two, stub_rows))
  assert_true(p != 0)
  assert_eq(pk_width(p), two)
  assert_eq(pk_sr(p), 44100)
  job_close(j2)
}

///|
/// 宽度的三档前缀（8 / 12 / 16 位）各自都要能往返。参照实现那侧只测了 w=400（8 位档），
/// 而这三档在前缀位、CRC 覆盖长度、窗口个数上都不完全一样。
test "白盒：宽度三档前缀都能往返（含双窗口的宽图）" {
  for w in [255, 4095, 65535] {
    let jh = paint(w, 96000, 2048, true)
    let p = decode(profile(job_b(jh), w, stub_rows))
    assert_true(p != 0)
    assert_eq(pk_width(p), w)
    assert_eq(pk_sr(p), 96000)
    assert_eq(pk_win(p), 2048)
    assert_true(pk_exact(p))
    job_close(jh)
  }
}

///|
/// 三张梯子与行数的导出面。**它们是格式的一部分，宿主不该各存一份**：位流里存的是下标，
/// 而「下标 → 采样率」这张表要是两处不一样，票根就会在宿主侧被认成另一档参数。
/// 越界一律给 0（而不是越界读表）—— 打包结果的 4 位 / 2 位下标理论上不会越界，
/// 但宿主也可能自己传个越界值进来，那也不该读穿。
test "白盒：行数与两张梯子都按导出面回答，越界给 0" {
  assert_eq(stub_rows_of(), 8)
  assert_true(stub_rows_of() == stub_rows)
  assert_eq(stub_sr_at(0), 8000)
  assert_eq(stub_sr_at(7), 44100)
  assert_eq(stub_sr_at(stub_sr.length() - 1), 192000)
  assert_eq(stub_sr_at(-1), 0)
  assert_eq(stub_sr_at(stub_sr.length()), 0)
  assert_eq(stub_win_at(0), 256)
  assert_eq(stub_win_at(3), 2048)
  assert_eq(stub_win_at(4), 0)
  assert_eq(stub_win_at(-1), 0)
  // 位流里那 4 位下标能覆盖到梯子上每一档，超出的部分落在 0（会被 `si < 0` 之外的门挡掉）
  assert_true(stub_sr.length() <= 16)
  assert_true(stub_wins.length() <= 4)
}

///|
test "白盒：参数放不下时不写票根（不是写个坏的）" {
  let bad : FixedArray[(Int, Int, Int)] = [(400, 12345, 512), (400, 44100, 300), (1, 44100, 512)]
  for (w, sr, win) in bad {
    let h = job_open(0, stub_paint_bytes(w))
    assert_true(h >= 1)
    assert_eq(stub_luma(h, w, sr, win, 0), 0)
    assert_eq(stub_paint(h, w, sr, win, 0), 0)
    job_close(h)
  }
}

///|
test "白盒：太窄的图不占票根的位置" {
  assert_true(stub_fits(100) == 1)
  assert_true(stub_fits(160) == 1)
  // 42 有位置（`span + 2 = 37`）但剖面短于解码下限，认不回来 —— 不占位置才对。
  assert_true(stub_fits(42) == 0)
  assert_true(stub_fits(stub_min_decode) == 1)
  assert_true(stub_fits(stub_min_decode - 1) == 0)
  assert_true(stub_fits(30) == 0)
  assert_eq(stub_paint_bytes(400), 400 * stub_rows * 4)
}

///|
/// 「装得下」与「认得出」必须是同一件事 —— 逐宽度画一遍、认一遍，两个判据要一致。
///
/// 这是一条**规则**而不是当时的清单：改 `stub_span` / `stub_bit_px` / `stub_wbits` /
/// `stub_min_decode` 任何一处，只要让二者漂移，它就会红，且报出第一个不一致的宽度。
/// 分开写这两处判据正是 39~45 那档白占 8 行条码的成因。
///
/// 循环同时跨过三档 `bit_px`、两档位宽前缀、以及单窗口 / 双窗口两条分支。
test "白盒：stub_fits 说装得下，那个宽度就真的认得回来" {
  let mut w = 1
  let mut first_bad = 0
  let mut fits_n = 0
  let mut ok_n = 0
  while w <= 512 {
    let fits = stub_fits(w) == 1
    let jh = job_open(0, stub_paint_bytes(w))
    assert_true(jh >= 1)
    let mut ok = false
    if stub_paint(jh, w, 44100, 512, 1) == 1 {
      ok = decode(profile(job_b(jh), w, stub_rows)) != 0
    }
    job_close(jh)
    if fits {
      fits_n = fits_n + 1
    }
    if ok {
      ok_n = ok_n + 1
    }
    if fits != ok && first_bad == 0 {
      first_bad = w
    }
    w = w + 1
  }
  // 两侧都非空，否则「逐宽度一致」在两档同时恒假时也绿。
  assert_true(fits_n > 0 && fits_n < 512)
  // 先报**哪个宽度**不一致（指向漂移的位置），再报总数对不上。
  assert_eq(first_bad, 0)
  assert_eq(fits_n, ok_n)
}
