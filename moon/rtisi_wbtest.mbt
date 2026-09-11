// RTISI 内核的白盒不变量。
//
// 参照实现那侧的行为（相关性、打包消融、ULP 界线）在 `app/lib/rtisi.test.ts`，
// 这里管的是**只有内核才谈得上**的那几条：段内布局、分块推进的自由度、预算收缩规则、
// 幅度软约束那条「字节 → 查表」的路。它们共同的毛病是「算错了也照样跑完、照样有限」，
// 所以每条都要么拿一个独立的量去比，要么拿一个确定的极端值去顶。
//
// 判据里的数字都是在 `docs/algorithms.md` 记过的那种量出来的，不是拍的：
// 给了真相位时内核输出与原信号的相关实测 0.9989 / 0.9994 / 0.9976（三档窗长），
// 不给则在 −0.01 ~ 0.90 之间乱走 —— 两条线之间隔着 0.1，所以门槛放在 0.99 / 0.9。

///|
/// 绝对值。`Double::abs` 在内核里就够用，这里自己写一份只是为了测试文件的读法统一
/// （与 `corr_of` / `peak_of` 一样都在「只有测试才谈得上」的那一侧）。
fn abs_d(x : Double) -> Double {
  if x < 0.0 {
    -x
  } else {
    x
  }
}

///|
fn peak_of(a : FixedArray[Double]) -> Double {
  let mut p = 0.0
  for i = 0; i < a.length(); i = i + 1 {
    let v = abs_d(a.unsafe_get(i))
    if v > p {
      p = v
    }
  }
  p
}

///|
/// 零延迟归一化相关。输出与原信号对齐在 0 延迟处（补零约定与收尾的 `out[win/2 + i]`
/// 一起保证这件事），所以不必扫时延 —— 扫时延会把「搬错了平面」这类错误部分洗白。
fn corr_of(a : FixedArray[Double], b : FixedArray[Double]) -> Double {
  let mut n = 0.0
  let mut da = 0.0
  let mut db = 0.0
  for i = 0; i < a.length(); i = i + 1 {
    n = n + a.unsafe_get(i) * b.unsafe_get(i)
    da = da + a.unsafe_get(i) * a.unsafe_get(i)
    db = db + b.unsafe_get(i) * b.unsafe_get(i)
  }
  n / (da * db).sqrt()
}

///|
/// 纯音素材 + 它的 STFT。补零约定照参照实现：`pad[win/2 + i] = x[i]`、帧 f 取
/// `pad[f*hop …]`。约定错了原信号就不是不动点，「给了真相位就是不动点」会第一个掉下来 ——
/// 这个坑真踩过一次（当时以为是内核搬错了，其实是夹具的补零位置不对）。
priv struct Fx {
  x : FixedArray[Double]
  mag : FixedArray[Double]
  warm : FixedArray[Double]
  frames : Int
  bins : Int
  win : Int
  hop : Int
  samples : Int
}

///|
fn make_fx(frames : Int, win : Int, hop : Int, freq : Double) -> Fx raise {
  let bins = win / 2 + 1
  let samples = frames * hop
  let x = FixedArray::make(samples, 0.0)
  for i = 0; i < samples; i = i + 1 {
    x.unsafe_set(i, 0.6 * @math.sin(2.0 * 3.141592653589793 * freq * i.to_double() / 8000.0))
  }
  let pad = FixedArray::make(samples + win, 0.0)
  for i = 0; i < samples; i = i + 1 {
    pad.unsafe_set(win / 2 + i, x.unsafe_get(i))
  }
  let s = slot_open(win)
  assert_true(s >= 0)
  let w = plan_hann.unsafe_get(plan(win))
  let arena = slot_mem.unsafe_get(s)
  let mag = FixedArray::make(frames * bins, 0.0)
  let warm = FixedArray::make(frames * bins, 0.0)
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
      warm.unsafe_set(f * bins + b, @math.atan2(im, re))
    }
  }
  slot_close(s)
  { x, mag, warm, frames, bins, win, hop, samples }
}

///|
/// 跑完一次作业并取回 `y` 的副本（`close` 之后段就交还了）。
/// `chunk` 是每块帧数：分块推进是 API 的一部分，不是一个写法偏好。
fn run_rtisi(
  fx : Fx,
  iters : Int,
  chunk : Int,
  budget : Double,
  warm : Bool,
  band : FixedArray[Double]?,
  levels : FixedArray[Int]?
) -> FixedArray[Double] raise {
  let has_band = if band is Some(_) { 1 } else { 0 }
  let h = rtisi_open(
    fx.frames,
    fx.bins,
    fx.win,
    fx.hop,
    fx.samples,
    iters,
    if warm { 1 } else { 0 },
    has_band,
    budget,
  )
  assert_true(h >= 1)
  let hdr = rtisi_hdr.unsafe_get(h - 1)
  // 视图一律在 open 之后取：作业的缓冲是 open 时才建的，句柄到手之前没有数组可切。
  let arena = job_d(h)
  let bseg = job_b(h)
  let fb = fx.frames * fx.bins
  let off_mag = hdr.unsafe_get(12)
  for i = 0; i < fb; i = i + 1 {
    arena.unsafe_set(off_mag + i, fx.mag.unsafe_get(i))
  }
  if warm {
    let off = hdr.unsafe_get(13)
    for i = 0; i < fb; i = i + 1 {
      arena.unsafe_set(off + i, fx.warm.unsafe_get(i))
    }
  }
  match band {
    Some(table) => {
      let off = hdr.unsafe_get(26)
      for i = 0; i < 512; i = i + 1 {
        arena.unsafe_set(off + i, table.unsafe_get(i))
      }
    }
    None => ()
  }
  match levels {
    Some(lv) => {
      // 与宿主同一套动作：偏移问内核要（`rtisi_levels`），数组本身也从内核取
      // （`job_b`）—— 字节段是独立的一段，偏移是段内偏移，不含任何基址运算。
      let off = rtisi_levels(h, 0)
      for i = 0; i < fb; i = i + 1 {
        bseg.unsafe_set(off + i, lv.unsafe_get(i).to_byte())
      }
    }
    None => ()
  }
  let mut at = 0
  while at < fx.frames {
    let to = if at + chunk < fx.frames { at + chunk } else { fx.frames }
    ignore(rtisi_run(h, at, to))
    at = to
  }
  rtisi_finish(h)
  let off_y = hdr.unsafe_get(14)
  let y = FixedArray::make(fx.samples, 0.0)
  for i = 0; i < fx.samples; i = i + 1 {
    y.unsafe_set(i, arena.unsafe_get(off_y + i))
  }
  rtisi_close(h)
  y
}

///|
/// 只读回内核收缩之后的 (K, iters)，不看输出。
fn shrink_of(
  frames : Int,
  win : Int,
  hop : Int,
  iters : Int,
  budget : Double
) -> (Int, Int) raise {
  let bins = win / 2 + 1
  let h = rtisi_open(frames, bins, win, hop, frames * hop, iters, 0, 0, budget)
  assert_true(h >= 1)
  let hdr = rtisi_hdr.unsafe_get(h - 1)
  let k = hdr.unsafe_get(5)
  let it = hdr.unsafe_get(6)
  rtisi_close(h)
  (k, it)
}

///|
/// 作业区内的布局：字段号按**书写顺序**排，长度紧跟其后。两者一起构成「逐段相接、
/// 互不重叠、一段不落」这条承诺 —— 任何一次漏写 `off = off + …` 都会当场错位。
///
/// 布局现在**就是**相对自己那段缓冲的，没有段基址可减：一条作业一段自己的数组
/// （见 `arena.mbt`），这才是「减基址」那一类错不可能再出现的原因。
///
/// `levels` 不在这条链里 —— 它住独立的字节段，偏移恒为 0，长度落在字段 31。
let layout_fields : FixedArray[Int] = [12, 13, 14, 16, 30, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26]

///|
/// 按上面的顺序与逐段长度走一遍，并要求每段都从上一段结尾开始。
/// 主缓冲走到 `at`，字节段恰好 `fb` —— 两段的长度都拿内核的读数比，不比地址。
fn walk_layout(h : Int, frames : Int, win : Int, samples : Int) -> Unit raise {
  let j = h - 1
  let hdr = rtisi_hdr.unsafe_get(j)
  let bins = win / 2 + 1
  let fb = frames * bins
  let padded = samples + win
  // K 会被预算收缩，所以它不是 frames−1 —— 问内核要，别在这里重算一遍判据。
  let state = (hdr.unsafe_get(5) + 1) * bins
  let size : FixedArray[Int] = [
    fb,
    fb,
    samples,
    padded,
    padded,
    hdr.unsafe_get(10),
    win,
    win,
    state,
    state,
    state,
    state,
    state,
    state,
    512,
  ]
  let mut at = 0
  for i = 0; i < layout_fields.length(); i = i + 1 {
    assert_eq(hdr.unsafe_get(layout_fields.unsafe_get(i)), at)
    at = at + size.unsafe_get(i)
  }
  assert_eq(at, job_words_of(h))
  // levels 一个元素只占一个字节（16M 像素的素材就是 128 MB 对 16 MB），所以它整段
  // 住在字节段：段内偏移 0、长度恰好 fb 个字节。两段各自算自己的长度，不再按字节折。
  assert_eq(rtisi_levels(h, 0), 0)
  assert_eq(rtisi_levels(h, 1), fb)
  assert_eq(job_bytes_of(h), fb)
}

///|
test "白盒：作业区布局逐段相接、互不重叠，总长与两段长度一致" {
  let win = 256
  let hop = 64
  let frames = 33
  let h = rtisi_open(frames, win / 2 + 1, win, hop, frames * hop, 4, 0, 1, 0.0)
  assert_true(h >= 1)
  walk_layout(h, frames, win, frames * hop)
  rtisi_close(h)
}

///|
test "白盒：另一条作业同时开着时布局不变（两件活各占各的数组）" {
  let win = 512
  let hop = 128
  let frames = 17
  let pad = job_open(1000, 0)
  assert_true(pad >= 1)
  let h = rtisi_open(frames, win / 2 + 1, win, hop, frames * hop, 4, 0, 1, 0.0)
  assert_true(h >= 1)
  walk_layout(h, frames, win, frames * hop)
  // 邻居是另一段数组，两边的偏移互不相干 —— 用邻居的读写去干扰本件的布局再也无从谈起。
  assert_true(job_d(pad).length() == 1000)
  assert_eq(job_bytes_of(pad), 0)
  rtisi_close(h)
  job_close(pad)
  assert_eq(job_live_count(), 0)
}

///|
/// `levels` 走的内核路径与宿主是**同一份**：内核在 `rt_fit` 里按 `levels[off_levels + i]`
/// 读字节段，宿主写的是同一个偏移、同一段数组。这条契约原先靠「导出指针与逐帧循环读的
/// 是同一格」在地址层面钉住（还得先制造非 0 段基址才看得出差别）；现在偏移是**段内**的，
/// 唯一可能错的是「宿主与内核用了不同的字段号」，而那条由 `walk_layout` 直接比读数就够了，
/// 地址层面再无可以约定错的地方。这里只留行为侧的那半条：levels 全 1 时表项 1 生效、
/// 表项 0 不生效 —— 内核要是根本没读 levels、一律取表项 0，输出就不再是 0。
test "白盒：levels 从字节段的第 0 字节起被逐帧循环读到" {
  let win = 256
  let hop = 64
  let frames = 9
  let bins = win / 2 + 1
  let samples = frames * hop
  let h = rtisi_open(frames, bins, win, hop, samples, 4, 1, 1, 0.0)
  assert_true(h >= 1)
  let hdr = rtisi_hdr.unsafe_get(h - 1)
  let arena = job_d(h)
  let bseg = job_b(h)
  let fb = frames * bins
  let off_levels = rtisi_levels(h, 0)
  let off_band = hdr.unsafe_get(26)
  // 表项 0 = [1.0, 1e300]（放行），其余表项全是 [0, 0]（夹成 0）。
  arena.unsafe_set(off_band, 1.0)
  arena.unsafe_set(off_band + 256, 1.0e300)
  for i = 0; i < fb; i = i + 1 {
    bseg.unsafe_set(off_levels + i, b'\x01')
    arena.unsafe_set(hdr.unsafe_get(12) + i, 1.0)
    arena.unsafe_set(hdr.unsafe_get(13) + i, 0.0)
  }
  ignore(rtisi_run(h, 0, frames))
  rtisi_finish(h)
  let off_y = hdr.unsafe_get(14)
  for i = 0; i < samples; i = i + 1 {
    assert_eq(arena.unsafe_get(off_y + i), 0.0)
  }
  rtisi_close(h)
}

///|
test "白盒：分块推进与一次跑完逐位相同（块边界是自由的）" {
  let fx = make_fx(129, 256, 64, 440.0)
  let whole = run_rtisi(fx, 8, 100000, 0.0, false, None, None)
  for chunk in [1, 5, 64, 128, 129] {
    let part = run_rtisi(fx, 8, chunk, 0.0, false, None, None)
    for i = 0; i < fx.samples; i = i + 1 {
      assert_true(whole.unsafe_get(i) == part.unsafe_get(i))
    }
  }
}

///|
test "白盒：同参数两次跑逐位相同（内核里没有未定序的归约）" {
  let fx = make_fx(64, 512, 128, 440.0)
  let a = run_rtisi(fx, 8, 13, 0.0, false, None, None)
  let b = run_rtisi(fx, 8, 13, 0.0, false, None, None)
  for i = 0; i < fx.samples; i = i + 1 {
    assert_true(a.unsafe_get(i) == b.unsafe_get(i))
  }
}

///|
/// 这一条是**数值正确性**的主判据：真值相位是这套迭代的不动点，给它就应当几乎原样还回来。
/// 拿它顶掉「相关性 > 0.2」那种弱判据 —— 搬错平面（把 `mag` 当相位读）时输出照样有限、
/// 照样确定、照样分块一致，只有这一条会掉。
test "白盒：给了真值相位就是不动点，不给则明显不是" {
  let fx = make_fx(501, 512, 128, 440.0)
  let with_warm = run_rtisi(fx, 8, 100000, 0.0, true, None, None)
  let cold = run_rtisi(fx, 8, 100000, 0.0, false, None, None)
  let cw = corr_of(with_warm, fx.x)
  let cc = corr_of(cold, fx.x)
  assert_true(cw > 0.99)
  assert_true(cc < 0.9)
  // 幅度也要在合理的量级上 —— 相位对了、整条缩放了 100 倍也过不了这一条。
  let px = peak_of(fx.x)
  let py = peak_of(with_warm)
  assert_true(py > 0.2 * px && py < 5.0 * px)
}

///|
test "白盒：幅度软约束走「levels 字节 → 256 项查表」这一条路" {
  let fx = make_fx(9, 256, 64, 440.0)
  let fb = fx.frames * fx.bins
  // 表项 0 = [1.0, 1e300]，其余表项全是 [0, 0]。配合真值相位起手，幅度恒取 1.0、
  // 相位是真的 —— 于是输出与原信号同形，只是缩放了一下。
  //
  // 为什么必须给真值相位：幅度恒定、相位全零的谱**就是一个落在 n=0 的冲激**，
  // 而汉宁窗在 n=0 处恰好是 0，整条会被窗吃掉、输出恒为 0。第一版就栽在这儿，
  // 而且当时先怀疑的是内核（参照实现跑同一张表也给 0，才把方向扭回来）。
  let alive = FixedArray::make(512, 0.0)
  alive.unsafe_set(0, 1.0)
  alive.unsafe_set(256, 1.0e300)
  let dead = FixedArray::make(512, 0.0)
  let zeros = FixedArray::make(fb, 0)
  let ones = FixedArray::make(fb, 1)
  let band = run_rtisi(fx, 4, 100000, 0.0, true, Some(alive), Some(zeros))
  assert_true(peak_of(band) > 0.0)
  // 幅度被拉平到常量之后波形已经不是原来那条了（纯音的主瓣被摊到全带），
  // 所以这里只钉「软约束真的生效」，声音对不对由上面给真值相位那条管。
  // 全零表：上下界都是 0，幅度一律夹成 0，输出必须整条归零。
  assert_eq(peak_of(run_rtisi(fx, 4, 100000, 0.0, true, Some(dead), Some(zeros))), 0.0)
  // levels 全 1 而表项 1 仍是全零 —— 内核要是没读 levels、一律取表项 0，这里就会非零。
  assert_eq(peak_of(run_rtisi(fx, 4, 100000, 0.0, true, Some(alive), Some(ones))), 0.0)
  // 不给表就是硬投影：幅度恒取目标值，与上面三种都不同。
  let hard = run_rtisi(fx, 4, 100000, 0.0, true, None, None)
  assert_true(peak_of(hard) > 0.0)
  let mut same = 0
  for i = 0; i < fx.samples; i = i + 1 {
    if hard.unsafe_get(i) == band.unsafe_get(i) {
      same = same + 1
    }
  }
  assert_true(same < fx.samples)
}

///|
/// 收尾那一叠（重叠归一化）可以从 `out`、`cover` 与汉宁窗**独立复算**出来，于是它不该只有
/// 「能跑完」这一条保障。① 按帧升序自己累一遍 `cover`，与内核写的那份逐位比；② 用内核的
/// `out` 与自己算的 `cover` 复算出 `y`，与 `finish` 的产物逐位比。
///
/// 这条是补出来的，起因是一次违例注入扫描：窗平方写成窗、cover 倒序累加、`y` 忘了除 cover
/// 这三个注入**一条门禁都没响** —— 因为它们都只改动数值的一点点，而「给真值相位」那条
/// 用的是相关（实测干净 0.99945、注入后 0.99917~0.99980，全在噪声里）。相关是个钝器，
/// 这里要的是开方级别的对比。
test "白盒：收尾的重叠归一化可以独立复算" {
  let win = 256
  let hop = 64
  let frames = 33
  let bins = win / 2 + 1
  let samples = frames * hop
  let padded = samples + win
  let h = rtisi_open(frames, bins, win, hop, samples, 4, 1, 0, 0.0)
  assert_true(h >= 1)
  let j = h - 1
  let hdr = rtisi_hdr.unsafe_get(j)
  let arena = job_d(h)
  let fb = frames * bins
  let w = plan_hann.unsafe_get(hdr.unsafe_get(7))
  // 幅度与相位都给一组不平坦的值：让每一种走样的后果都落在可比的量级上。
  for i = 0; i < fb; i = i + 1 {
    arena.unsafe_set(hdr.unsafe_get(12) + i, 1.0 + (i % 7).to_double())
    arena.unsafe_set(hdr.unsafe_get(13) + i, 0.25 * (i % 11).to_double())
  }
  ignore(rtisi_run(h, 0, frames))
  // ① 自己按帧升序累一遍 cover
  let expect = FixedArray::make(padded, 0.0)
  for f = 0; f < frames; f = f + 1 {
    let s = f * hop
    for mh = 0; mh < win; mh = mh + 1 {
      expect.unsafe_set(
        s + mh,
        expect.unsafe_get(s + mh) + w.unsafe_get(mh) * w.unsafe_get(mh),
      )
    }
  }
  // cover 是 `finish` 写的（`run` 只管推进），所以先收尾再比。
  rtisi_finish(h)
  let off_cover = hdr.unsafe_get(30)
  for i = 0; i < padded; i = i + 1 {
    assert_true(expect.unsafe_get(i) == arena.unsafe_get(off_cover + i))
  }
  // ② 用内核的 out 与自己算的 cover 复算 y
  let mut top = 0.0
  for i = 0; i < padded; i = i + 1 {
    if expect.unsafe_get(i) > top {
      top = expect.unsafe_get(i)
    }
  }
  let floor = top * 0.05
  let half = win / 2
  let off_out = hdr.unsafe_get(16)
  let off_y = hdr.unsafe_get(14)
  for i = 0; i < samples; i = i + 1 {
    let c = expect.unsafe_get(half + i)
    let want = if c > floor { arena.unsafe_get(off_out + half + i) / c } else { 0.0 }
    assert_true(want == arena.unsafe_get(off_y + i))
  }
  rtisi_close(h)
}

///|
test "白盒：预算按「超了就压、压不动为止」收缩 K 与 iters" {
  let win = 512
  let hop = 128
  let frames = 501
  let bound = 8
  // 天花板 = min(frames−1, round(win/hop)−1)
  let ceil_k = (win / hop) - 1
  let unit = frames.to_double() * win.to_double() * @math.log2(win.to_double())
  let (k1, it1) = shrink_of(frames, win, hop, bound, 5.0e7)
  assert_true(k1 >= 1 && k1 <= ceil_k)
  assert_true(it1 >= 1 && it1 <= bound)
  // 终止条件：要么落进预算，要么已经压到底 —— 这一条不写，收缩就成了「随便压几下」。
  assert_true(unit * (k1 + 1).to_double() * it1.to_double() <= 5.0e7 || k1 == 1 || it1 == 1)
  // 单调：预算变小，K 与 iters 只许更小。
  let (k2, it2) = shrink_of(frames, win, hop, bound, 1.0e7)
  assert_true(k2 <= k1 && it2 <= it1)
  // 预算够大就一点不压。
  let (k3, it3) = shrink_of(frames, win, hop, bound, 1.0e18)
  assert_eq(k3, ceil_k)
  assert_eq(it3, bound)
  // 预算小到极限，两个都压到 1。
  let (k4, it4) = shrink_of(frames, win, hop, bound, 1.0)
  assert_eq(k4, 1)
  assert_eq(it4, 1)
}

///|
/// `hop` 不整除窗长时 `R = round(L/a)` 与 `L/a`（整除）不是一回事，
/// 而 hop 只在默认档才恰好是 win/4 —— 所以这一档要单独钉。判据用「K 与 iters 的取值」，
/// 不比输出（那会同时把别的差异混进来）。
test "白盒：hop 不整除窗长时按四舍五入定 K（不是整除）" {
  // 512/130 = 3.938 → round 给 4，K = 3；整除给 3，K = 2。
  let (k, _) = shrink_of(501, 512, 130, 1, 1.0e18)
  assert_eq(k, 3)
  // 512/100 = 5.12 → round 给 5，K = 4。
  let (k2, _) = shrink_of(501, 512, 100, 1, 1.0e18)
  assert_eq(k2, 4)
  // 帧数不够就顶到 frames−1。
  let (k3, _) = shrink_of(3, 512, 128, 1, 1.0e18)
  assert_eq(k3, 2)
}

///|
test "白盒：非法参数被拒（不是崩溃）" {
  assert_eq(rtisi_open(4, 1, 256, 64, 256, 8, 0, 0, 0.0), 0)
  assert_eq(rtisi_open(4, 129, 100, 25, 256, 8, 0, 0, 0.0), 0)
  assert_eq(rtisi_open(0, 129, 256, 64, 0, 8, 0, 0, 0.0), 0)
  assert_eq(rtisi_open(-3, 129, 256, 64, 0, 8, 0, 0, 0.0), 0)
  assert_eq(rtisi_open(4, 129, 8192, 2048, 1024, 8, 0, 0, 0.0), 0)
  // 非法句柄下的各接口都该原地不动，而不是越界。偏移类返回 -1（不是 0 —— 0 是合法偏移，
  // `levels` 就在字节段第 0 字节），长度类返回 0。
  assert_eq(rtisi_off(0, 0), -1)
  assert_eq(rtisi_off(max_jobs + 1, 2), -1)
  assert_eq(rtisi_off(0, 3), -1)
  assert_eq(rtisi_levels(0, 0), -1)
  assert_eq(rtisi_len(0, 0), 0)
  assert_eq(job_words_of(0), 0)
  assert_eq(rtisi_run(0, 0, 4), 0)
  rtisi_finish(0)
  rtisi_close(0)
}

///|
test "白盒：作业池占满后 rtisi_open 给 0，宿主据此走参照实现" {
  let hs = FixedArray::make(max_jobs, 0)
  for i = 0; i < max_jobs; i = i + 1 {
    hs.unsafe_set(i, rtisi_open(8, 129, 256, 64, 8 * 64, 4, 0, 0, 0.0))
  }
  assert_true(hs.unsafe_get(max_jobs - 1) >= 1)
  assert_eq(rtisi_open(8, 129, 256, 64, 8 * 64, 4, 0, 0, 0.0), 0)
  // 每个 RTISI 作业同时还占一个会话槽，还回去之后两头都该能再拿到。
  for h in hs {
    rtisi_close(h)
  }
  let again = rtisi_open(8, 129, 256, 64, 8 * 64, 4, 0, 0, 0.0)
  assert_true(again >= 1)
  rtisi_close(again)
}
