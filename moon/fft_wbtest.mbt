// 白盒不变量：不需要 TS 参照实现也能判断「算法写错了」的那几条。
// 与 TS 的逐位/ulp 等价在 app/lib/fft.test.ts 里；这里管的是自洽性。

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
fn peak_ulps(got : FixedArray[Double], ref : FixedArray[Double], n : Int) -> Double {
  let mut peak = 0.0
  for i = 0; i < n; i = i + 1 {
    let a = abs_f(ref.unsafe_get(i))
    if a > peak {
      peak = a
    }
  }
  if peak == 0.0 {
    return 0.0
  }
  let mut worst = 0.0
  for i = 0; i < n; i = i + 1 {
    let u = abs_f(got.unsafe_get(i) - ref.unsafe_get(i)) / peak / ulp_epsilon
    if u > worst {
      worst = u
    }
  }
  worst
}

///|
/// 确定性伪随机输入，写进内核工作区；同时留一份到 `re`/`im` 之外由调用方保存的副本。
fn fill_noise(win : Int, start : Int) -> FixedArray[Double] {
  let src = FixedArray::make(win, 0.0)
  let mut s = start
  for i = 0; i < win; i = i + 1 {
    s = (s * 1664525 + 1013904223) & 0x7FFFFFFF
    let v = s.to_double() / 2147483647.0 - 0.5
    src.unsafe_set(i, v)
    re.unsafe_set(i, v)
    im.unsafe_set(i, 0.0)
  }
  src
}

///|
test "白盒：正变换后反变换回到原序列，虚部归零（≤ 8 ulp）" {
  for win in bench_wins {
    ignore(plan(win))
    let src = fill_noise(win, 0x9e3779b9 + win)
    forward()
    inverse()
    assert_true(peak_ulps(re, src, win) <= 8.0)
    assert_true(peak_ulps(im, FixedArray::make(win, 0.0), win) <= 8.0)
  }
}

///|
test "白盒：直流序列的能量全部落在第 0 根谱线" {
  let n = 512
  ignore(plan(n))
  for i = 0; i < n; i = i + 1 {
    re.unsafe_set(i, 1.5)
    im.unsafe_set(i, 0.0)
  }
  forward()
  let dc = 1.5 * n.to_double()
  assert_true(abs_f(re.unsafe_get(0) - dc) <= 8.0 * ulp_epsilon * dc)
  let mut leak = 0.0
  for i = 1; i < n; i = i + 1 {
    let a = abs_f(re.unsafe_get(i))
    let b = abs_f(im.unsafe_get(i))
    if a > leak {
      leak = a
    }
    if b > leak {
      leak = b
    }
  }
  assert_true(leak <= 8.0 * ulp_epsilon * dc)
}

///|
test "白盒：Parseval —— 时域平方和 × n 等于频域模方和" {
  let n = 1024
  ignore(plan(n))
  let src = fill_noise(n, 0x85ebca6b + n)
  forward()
  let mut time = 0.0
  for i = 0; i < n; i = i + 1 {
    time = time + src.unsafe_get(i) * src.unsafe_get(i)
  }
  let mut freq = 0.0
  for i = 0; i < n; i = i + 1 {
    let r = re.unsafe_get(i)
    let m = im.unsafe_get(i)
    freq = freq + r * r + m * m
  }
  assert_true(abs_f(freq - time * n.to_double()) <= 1.0e-9 * time * n.to_double())
}
