// 原地 radix-2 FFT，加上「单边谱 → 共轭对称整谱」的翻转（`mirror`）。两者是 STFT 与
// 相位重建的地基，**产品路径上只有这一份实现**（宿主侧的 FFT 类已删，见 app/lib/stft.ts）。
//
// 精度：位反转索引是纯整数运算，逐位相同；旋转因子与汉宁窗走 `@math.cos/sin`，与 V8 的
// `Math.cos/sin` 在约 4% 的输入上差**恰好 1 ulp**（两者都是合法的舍入，实测最大相对
// 2.19e-16），于是整条变换以峰值为尺度的最大相对误差是 1.5~3.4 ulp。这条差异不必消除 ——
// 它在 Float32 精度（1.2e-7）之下，而真正要挡的「算法写错」（顺序、除法、符号、下标）
// 会大出好几个数量级。白盒上界定在 8 ulp，见 fft_wbtest.mbt。
//
// **热循环里一律用 `unsafe_get` / `unsafe_set`，不写 `arr[i]`。** 后者编译出来的是一次
// `moonbit.check_range` + 一次 `moonbit.array_length` 调用，两个都不内联：同一个 512 点变换
// 因此从「比 V8 的 TS 慢 7 倍」变成「快 1.5 倍」（实测见 docs/algorithms.md 的微基准表）。
// 下标恒 < 表长 ≤ `max_win`，越界不可能发生，省掉的是纯开销。
//
// 变换作用在会话槽工作区的两段上（`re_off` / `im_off` 是**元素**偏移），旋转因子取第 `pi` 组 ——
// 于是配对双实变换（pair.mbt）能拿同一个内核跑自己的布局。
//
// **末级没有 SIMD 分支。** 原先 width == n 那一级单独走 `@v128` + 内联 WAT 的 v128.load/store，
// 拆开来量过：换成标准库的 `@v128.f64x2_*`（从两个标量拼一个 v128）比标量**慢 2%**
// （512 点、2000 轮，三条路校验和逐位相同）。收益全在 `v128.load/store` 这两条**访存**
// 指令上，而那正是没有标准 API 的一处 —— 于是末级就用标量，逐位等价反而少了一个论证负担。

///|
/// 槽号合法性。越界一律当作「没有这个槽」，不让 `unsafe_get` 越界读。
fn slot_ok(s : Int) -> Bool {
  s >= 0 && s < max_slots && slot_busy.unsafe_get(s)
}

///|
fn fft_at(
  pi : Int,
  arena : FixedArray[Double],
  re_off : Int,
  im_off : Int,
  inverse : Bool,
) -> Unit {
  let ix = plan_rev.unsafe_get(pi)
  let tc = plan_cos.unsafe_get(pi)
  let ts = plan_sin.unsafe_get(pi)
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
    // 除以 n，不是乘 1/n：TS 参照实现写的是 `re[i] / n`，两者在浮点上不等价（1/n 不精确）
    let nf = n.to_double()
    for i = 0; i < n; i = i + 1 {
      arena.unsafe_set(re_off + i, arena.unsafe_get(re_off + i) / nf)
      arena.unsafe_set(im_off + i, arena.unsafe_get(im_off + i) / nf)
    }
  }
}

///|
/// 单条复变换。工作区布局：`re` 在槽首、`im` 紧随其后（宿主侧见 `app/lib/dsp.ts` 的 `fftBuffers`）。
#export_name("dsp_fft")
pub fn forward(s : Int) -> Unit {
  if slot_ok(s) {
    let pi = slot_plan.unsafe_get(s)
    let n = plan_rev.unsafe_get(pi).length()
    fft_at(pi, slot_mem.unsafe_get(s), 0, n, false)
  }
}

///|
/// 单条复反变换（除以 n，不是乘 1/n —— 两者在浮点上不等价）。**产品路径上不用它**：
/// 实序列的反变换走 `real_ifft`，那里把「单边谱翻成整谱」一并做了。它留着是给白盒做
/// 「正变换 → 反变换回到原序列」这条自洽性断言，以及给配对双实变换那套布局当参照。
#export_name("dsp_ifft")
pub fn inverse(s : Int) -> Unit {
  if slot_ok(s) {
    let pi = slot_plan.unsafe_get(s)
    let n = plan_rev.unsafe_get(pi).length()
    fft_at(pi, slot_mem.unsafe_get(s), 0, n, true)
  }
}

///|
/// 实序列的反变换：先把**单边谱**补成共轭对称的整谱，再做一次复反变换。
///
/// 翻转这一步不能省，而且必须在核心里做。留下半张谱不管的后果实测过：上半谱带着上一帧
/// 反变换出来的时域样本，被当成本帧的谱再变一次，帧 0 之后整条输出都被污染。
/// 于是「配对的复变换」这条约束只有一处实现，宿主不需要知道 `X[N-k] = conj(X[k])` 怎么写，
/// 也就不会漏掉 DC 与奈奎斯特点那两处虚部置零（它们是实数谱线，虚部必须为 0）。
///
/// `bins` 是单边谱的行数，最多 `n/2+1`。**小于它也是合法的**：图读回来的精确谱被行数夹过，
/// 这种时候按 `bins` 翻转、`bins` 之外由调用方自己清零（与翻转互不覆盖，见 `add`）。
/// 返回 1 表示做了，0 表示槽或 `bins` 不合法（不动手，别把半张谱变回去）。
#export_name("dsp_real_ifft")
pub fn real_ifft(s : Int, bins : Int) -> Int {
  if !slot_ok(s) {
    return 0
  }
  let pi = slot_plan.unsafe_get(s)
  let n = plan_rev.unsafe_get(pi).length()
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
  fft_at(pi, mem, 0, n, true)
  1
}
