// 白盒不变量：不需要第二份实现也能判断「算法写错了」的那几条。
// 曾经有一条「内核 ≡ TS `FFT` 类」的 ulp 门禁对着一份宿主侧实现，那份实现随
// `app/lib/fft.ts` 一起删了 —— 于是这里要更硬：自洽性（正变换 → 实反变换回到原序列）、
// 谱的共轭对称性、以及 `bins` 退化时的行为，全部只靠内核自己的两侧互证。

///|
/// 出题用的窗长，内核表组的全部覆盖范围。
let probe_wins : FixedArray[Int] = [256, 512, 1024, 2048, 4096]

///|
let ulp_epsilon : Double = 2.220446049250313e-16

///|
fn abs_f(x : Double) -> Double {
  if x < 0.0 {
    -x
  } else {
    x
  }
}

///|
/// 以参照序列的峰值为尺度的最大 ulp 距离。FFT 的后向误差只有相对峰值度量才有意义。
fn peak_ulps(arena : FixedArray[Double], off : Int, golden : FixedArray[Double], n : Int) -> Double {
  let mut peak = 0.0
  for i = 0; i < n; i = i + 1 {
    let a = abs_f(golden.unsafe_get(i))
    if a > peak {
      peak = a
    }
  }
  if peak == 0.0 {
    return 0.0
  }
  let mut worst = 0.0
  for i = 0; i < n; i = i + 1 {
    let u = abs_f(arena.unsafe_get(off + i) - golden.unsafe_get(i)) / peak / ulp_epsilon
    if u > worst {
      worst = u
    }
  }
  worst
}

///|
/// 确定性伪随机序列。
fn noise_array(n : Int, start : Int) -> FixedArray[Double] {
  let out = FixedArray::make(n, 0.0)
  let mut v = start
  for i = 0; i < n; i = i + 1 {
    v = (v * 1664525 + 1013904223) & 0x7FFFFFFF
    out.unsafe_set(i, v.to_double() / 2147483647.0 - 0.5)
  }
  out
}

///|
/// 把 `src` 灌进槽的实部、虚部清零（单条复变换布局）。
fn fill_fft(s : Int, win : Int, src : FixedArray[Double]) -> Unit {
  let arena = slot_mem.unsafe_get(s)
  for i = 0; i < win; i = i + 1 {
    arena.unsafe_set(i, src.unsafe_get(i))
    arena.unsafe_set(win + i, 0.0)
  }
}

///|
/// 开一个槽并灌好输入。调用方负责 `slot_close`。
fn open_fft(win : Int, src : FixedArray[Double]) -> Int {
  let s = slot_open(win)
  fill_fft(s, win, src)
  s
}

///|
/// 把池子里所有槽都还回去（`slot_close` 幂等）。
///
/// **这是为了让每条用例互不牵连**：白盒用例里断言一旦挂掉，后面那句 `slot_close` 就跑不到，
/// 漏出来的槽会把之后所有开槽的用例一起带红 —— 曾经一次改动报了五条红，其中四条是这么来的，
/// 真正的根因只有一条，却要顺着四条假线索去查。所以每条用例开头先复位，
/// 「借还配平」这条不变量另有专门的用例去钉（槽池那一节）。
fn release_all_slots() -> Unit {
  for i = 0; i < max_slots; i = i + 1 {
    slot_close(i)
  }
}

///|
test "白盒：正变换后反变换回到原序列，虚部归零（≤ 8 ulp）" {
  // 每条用例各自把池子腾干净：断言挂掉会让它后面的 `slot_close` 跑不到，
  // 于是漏出来的槽会把**后面无关的用例**一起带红（曾经五条红里四条是这么来的）。
  release_all_slots()
  for win in probe_wins {
    let src = noise_array(win, 0x9e3779b9 + win)
    let s = open_fft(win, src)
    forward(s)
    inverse(s)
    let arena = slot_mem.unsafe_get(s)
    assert_true(peak_ulps(arena, 0, src, win) <= 8.0)
    assert_true(peak_ulps(arena, win, FixedArray::make(win, 0.0), win) <= 8.0)
    slot_close(s)
  }
}

///|
/// 表组必须覆盖 `min_win … max_win` 这一段**全部**的 2 的幂 —— 不是当时那几档的清单。
/// 独立写出来的门槛：少一档，某个合法窗长就会读到表组外面去。
test "白盒：窗口梯子的每一档都有表组" {
  // 每条用例各自把池子腾干净：断言挂掉会让它后面的 `slot_close` 跑不到，
  // 于是漏出来的槽会把**后面无关的用例**一起带红（曾经五条红里四条是这么来的）。
  release_all_slots()
  let mut win = 256
  while win <= max_win {
    assert_true(plan(win) >= 0)
    let s = slot_open(win)
    assert_true(s >= 0)
    slot_close(s)
    win = win * 2
  }
}

///|
test "白盒：直流序列的能量全部落在第 0 根谱线" {
  // 每条用例各自把池子腾干净：断言挂掉会让它后面的 `slot_close` 跑不到，
  // 于是漏出来的槽会把**后面无关的用例**一起带红（曾经五条红里四条是这么来的）。
  release_all_slots()
  let n = 512
  let s = open_fft(n, FixedArray::make(n, 1.5))
  forward(s)
  let arena = slot_mem.unsafe_get(s)
  let dc = 1.5 * n.to_double()
  assert_true(abs_f(arena.unsafe_get(0) - dc) <= 8.0 * ulp_epsilon * dc)
  let mut leak = 0.0
  for i = 1; i < n; i = i + 1 {
    let a = abs_f(arena.unsafe_get(i))
    let b = abs_f(arena.unsafe_get(n + i))
    if a > leak {
      leak = a
    }
    if b > leak {
      leak = b
    }
  }
  assert_true(leak <= 8.0 * ulp_epsilon * dc)
  slot_close(s)
}

///|
test "白盒：Parseval —— 时域平方和 × n 等于频域模方和" {
  // 每条用例各自把池子腾干净：断言挂掉会让它后面的 `slot_close` 跑不到，
  // 于是漏出来的槽会把**后面无关的用例**一起带红（曾经五条红里四条是这么来的）。
  release_all_slots()
  let n = 1024
  let src = noise_array(n, 0x85ebca6b + n)
  let s = open_fft(n, src)
  forward(s)
  let arena = slot_mem.unsafe_get(s)
  let mut time = 0.0
  for i = 0; i < n; i = i + 1 {
    time = time + src.unsafe_get(i) * src.unsafe_get(i)
  }
  let mut freq = 0.0
  for i = 0; i < n; i = i + 1 {
    let r = arena.unsafe_get(i)
    let m = arena.unsafe_get(n + i)
    freq = freq + r * r + m * m
  }
  assert_true(abs_f(freq - time * n.to_double()) <= 1.0e-9 * time * n.to_double())
  slot_close(s)
}

///|
test "白盒：槽池占满后拒绝，释放后能再拿到" {
  // 每条用例各自把池子腾干净：断言挂掉会让它后面的 `slot_close` 跑不到，
  // 于是漏出来的槽会把**后面无关的用例**一起带红（曾经五条红里四条是这么来的）。
  release_all_slots()
  let slots = FixedArray::make(max_slots, -1)
  for i = 0; i < max_slots; i = i + 1 {
    slots.unsafe_set(i, slot_open(256))
  }
  assert_true(slots.unsafe_get(max_slots - 1) >= 0)
  assert_eq(slot_open(256), -2)
  slot_close(slots.unsafe_get(0))
  assert_true(slot_open(256) >= 0)
  for i = 0; i < max_slots; i = i + 1 {
    slot_close(slots.unsafe_get(i))
  }
}

///|
test "白盒：非法窗长被拒（不是崩溃）" {
  // 每条用例各自把池子腾干净：断言挂掉会让它后面的 `slot_close` 跑不到，
  // 于是漏出来的槽会把**后面无关的用例**一起带红（曾经五条红里四条是这么来的）。
  release_all_slots()
  assert_eq(slot_open(100), -1)
  assert_eq(slot_open(8192), -1)
  assert_eq(plan(100), -1)
  assert_eq(plan(8192), -1)
}

///|
/// 翻转的**逐项**约定：`X[N-k] = conj(X[k])`，DC 与奈奎斯特点的虚部必须置零。
///
/// 判据不能拿「翻转后的中间态」来比 —— `real_ifft` 顺手把反变换也做了，谱已经变成时域。
/// 于是拿它与「手工翻转 + `inverse`」**逐位**对照：内核那一条链必须与这条手工式子一字不差。
/// 这条式子错了，整条还原链的输出都是噪声，而往后再也没有第二份实现能把它比出来。
test "白盒：单边谱翻转与逐项手工式子逐位相同" {
  // 每条用例各自把池子腾干净：断言挂掉会让它后面的 `slot_close` 跑不到，
  // 于是漏出来的槽会把**后面无关的用例**一起带红（曾经五条红里四条是这么来的）。
  release_all_slots()
  // 窗长下限是 256（`plan.mbt` 的 `min_win`），单边谱只填前 3 行 —— 手算的是下标关系，
  // 与窗长无关：第 `b` 行翻到第 `n-b` 行。
  let n = 256
  let singles_re : FixedArray[Double] = [2.0, 1.0, 5.0]
  let singles_im : FixedArray[Double] = [7.0, 2.0, -3.0]
  let a = slot_open(n)
  let b = slot_open(n)
  assert_true(a >= 0)
  assert_true(b >= 0)
  let ma = slot_mem.unsafe_get(a)
  let mb = slot_mem.unsafe_get(b)
  for i = 0; i < 3; i = i + 1 {
    ma.unsafe_set(i, singles_re.unsafe_get(i))
    ma.unsafe_set(n + i, singles_im.unsafe_get(i))
    mb.unsafe_set(i, singles_re.unsafe_get(i))
    mb.unsafe_set(n + i, singles_im.unsafe_get(i))
  }
  // 手工翻转：DC（第 0 行）与奈奎斯特点（第 2 行，即 n/2）是实数谱线，虚部置零；
  // 第 1 行按共轭对称翻到第 n-1 行：实部照抄、虚部取反。
  mb.unsafe_set(n + 0, 0.0)
  mb.unsafe_set(n + 2, 0.0)
  mb.unsafe_set(n - 1, 1.0)
  mb.unsafe_set(2 * n - 1, -2.0)

  assert_eq(real_ifft(a, 3), 1)
  inverse(b)
  let mut diff = 0
  for i = 0; i < 2 * n; i = i + 1 {
    if ma.unsafe_get(i) != mb.unsafe_get(i) {
      diff = diff + 1
    }
  }
  assert_eq(diff, 0)
  slot_close(a)
  slot_close(b)
}

///|
/// 自洽性（不需要任何参照）：实序列 → 正变换 → 取单边谱 → `real_ifft` → 回到原序列。
/// 这一条同时挡住「忘了翻转」与「翻转写错」：少翻一半，上半谱带着上一帧的残值，
/// 反变换出来的时域样本立刻对不上。
test "白盒：正变换 → 实反变换回到原序列（≤ 8 ulp）" {
  // 每条用例各自把池子腾干净：断言挂掉会让它后面的 `slot_close` 跑不到，
  // 于是漏出来的槽会把**后面无关的用例**一起带红（曾经五条红里四条是这么来的）。
  release_all_slots()
  for win in probe_wins {
    let src = noise_array(win, 0x1b873593 + win)
    let a = open_fft(win, src)
    forward(a)
    // 把单边谱抄到第二个槽里，走实反变换。
    let bins = win / 2 + 1
    let b = slot_open(win)
    let ma = slot_mem.unsafe_get(a)
    let mb = slot_mem.unsafe_get(b)
    for i = 0; i < bins; i = i + 1 {
      mb.unsafe_set(i, ma.unsafe_get(i))
      mb.unsafe_set(win + i, ma.unsafe_get(win + i))
    }
    assert_eq(real_ifft(b, bins), 1)
    assert_true(peak_ulps(mb, 0, src, win) <= 8.0)
    slot_close(a)
    slot_close(b)
  }
}

///|
/// `bins` 退化时：1 行、2 行是合法的（只有 DC，或 DC + 奈奎斯特），
/// 0 行、超过 `n/2+1` 一律**拒绝**并且不动手 —— 动手的话会把半张谱变成噪声。
test "白盒：bins 的合法边界" {
  // 每条用例各自把池子腾干净：断言挂掉会让它后面的 `slot_close` 跑不到，
  // 于是漏出来的槽会把**后面无关的用例**一起带红（曾经五条红里四条是这么来的）。
  release_all_slots()
  let n = 256
  let s = open_fft(n, noise_array(n, 0xcc9e2d51))
  assert_eq(real_ifft(s, 1), 1)
  assert_eq(real_ifft(s, 2), 1)
  assert_eq(real_ifft(s, 0), 0)
  assert_eq(real_ifft(s, n / 2 + 1), 1)
  assert_eq(real_ifft(s, n / 2 + 2), 0)
  assert_eq(real_ifft(-1, 3), 0)
  assert_eq(real_ifft(n, 3), 0)
  slot_close(s)
}
