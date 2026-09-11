// 白盒：表组自己的性质（汉宁窗与旋转因子）。
//
// 这三条原先住在 `app/lib/phase.test.ts` 里，靠宿主重建一份汉宁窗来比 —— 那份实现
// （`app/lib/fft.ts` 的 `hannWindow`）已经随「数值只有内核这一份」删掉了。
// 搬到内核里之后判据反而更硬：它们量的是**内核真的在用的那张表**，而不是它的复制品。

///|
/// 以参照序列峰值为尺度的最大绝对偏差。
///
/// 变换的判据只能是**相对量**：绝对偏差随长度按 `eps · log₂n · Σ|x|` 增长，拿 ulp 当界
/// 会在长窗上误报（实测 256 点时约 60 ulp，也就是 1.4e-14 的相对量）。
/// 而一个写错的实现（符号、下标、结合顺序错一处）给出的相对偏差是 1e-2 量级 ——
/// 界定在 1e-12 仍有十个数量级的余量。
fn rel_peak_diff(
  arena : FixedArray[Double],
  off : Int,
  golden : FixedArray[Double],
  n : Int,
) -> Double {
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
    let d = abs_f(arena.unsafe_get(off + i) - golden.unsafe_get(i)) / peak
    if d > worst {
      worst = d
    }
  }
  worst
}

///|
/// 汉宁窗关于中点对称、中点为 1、两端为 0。这三条错了，加窗叠接的归一化会整体偏。
test "白盒：汉宁窗中点对称、峰值在中点" {
  let n = 256
  let i = plan(n)
  assert_true(i >= 0)
  let w = plan_hann.unsafe_get(i)
  assert_true(abs_f(w.unsafe_get(0)) < 1.0e-12)
  assert_true(abs_f(w.unsafe_get(n / 2) - 1.0) < 1.0e-12)
  let mut worst = 0.0
  for k = 1; k < n / 2; k = k + 1 {
    let d = abs_f(w.unsafe_get(n / 2 + k) - w.unsafe_get(n / 2 - k))
    if d > worst {
      worst = d
    }
  }
  assert_true(worst < 1.0e-12)
}

///|
/// `hop = win/4` 时，窗平方的叠接和**在整个周期上是常数** —— 这就是 WOLA 归一化能用一个
/// 标量分母的原因。它同时钉住了重叠倍数与窗函数：两者任一变，和就不平了。
test "白盒：hop = win/4 时窗平方的叠接和是平的" {
  let n = 256
  let hop = n / 4
  let i = plan(n)
  let w = plan_hann.unsafe_get(i)
  let cover = FixedArray::make(n, 0.0)
  let mut f = 0
  while f * hop < n {
    for m = 0; m < n; m = m + 1 {
      let at = (f * hop + m) % n
      cover.unsafe_set(at, cover.unsafe_get(at) + w.unsafe_get(m) * w.unsafe_get(m))
    }
    f = f + 1
  }
  let mut lo = cover.unsafe_get(0)
  let mut hi = cover.unsafe_get(0)
  for m = 1; m < n; m = m + 1 {
    let v = cover.unsafe_get(m)
    if v < lo {
      lo = v
    }
    if v > hi {
      hi = v
    }
  }
  assert_true(hi - lo < 1.0e-9)
}

///|
/// 正变换 ≡ 朴素 DFT。这是变换**唯一**一条与实现无关的判据：旋转因子的下标、位反转、
/// 蝶形的结合顺序全在里面。判据取相对量，见 `rel_peak_diff`。
test "白盒：正变换与朴素 DFT 一致（峰值相对 1e-12 以内）" {
  let n = 256
  release_all_slots()
  let src = noise_array(n, 0x2545f491)
  let s = open_fft(n, src)
  assert_true(s >= 0)
  forward(s)
  let arena = slot_mem.unsafe_get(s)

  // 朴素 DFT 的实部/虚部 —— 直接照定义写，不做任何优化。
  let want_re = FixedArray::make(n, 0.0)
  let want_im = FixedArray::make(n, 0.0)
  let nn = n.to_double()
  for k = 0; k < n; k = k + 1 {
    let mut sr = 0.0
    let mut si = 0.0
    for t = 0; t < n; t = t + 1 {
      let a = -2.0 * 3.141592653589793 * k.to_double() * t.to_double() / nn
      let x = src.unsafe_get(t)
      sr = sr + x * @math.cos(a)
      si = si + x * @math.sin(a)
    }
    want_re.unsafe_set(k, sr)
    want_im.unsafe_set(k, si)
  }
  assert_true(rel_peak_diff(arena, 0, want_re, n) <= 1.0e-12)
  assert_true(rel_peak_diff(arena, n, want_im, n) <= 1.0e-12)
  slot_close(s)
}
