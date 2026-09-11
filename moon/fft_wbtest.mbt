// 白盒不变量：不需要 TS 参照实现也能判断「算法写错了」的那几条。
// 与 TS 的逐位/ulp 等价在 app/lib/fft.test.ts 里；这里管的是自洽性。

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
test "白盒：正变换后反变换回到原序列，虚部归零（≤ 8 ulp）" {
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
  assert_eq(slot_open(100), -1)
  assert_eq(slot_open(8192), -1)
  assert_eq(plan(100), -1)
  assert_eq(plan(8192), -1)
}
