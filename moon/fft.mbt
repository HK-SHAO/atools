// 原地 radix-2 FFT。与 TS 参照实现（`app/lib/fft.ts` 的 `FFT.transform`）逐位等价，
// 由 `app/lib/fft.test.ts` 的逐位门禁守住 —— 顺序、除法、符号都不能动。
//
// **热循环里一律用 `unsafe_get` / `unsafe_set`，不写 `arr[i]`。** 后者编译出来的是一次
// `moonbit.check_range` + 一次 `moonbit.array_length` 调用，两个都不内联：同一个 512 点变换
// 因此从「比 V8 的 TS 慢 7 倍」变成「快 1.5 倍」（实测见 docs/algorithms.md 的微基准表）。
// 下标恒 < 表长 ≤ `max_win`，越界不可能发生，省掉的是纯开销。
//
// 变换作用在会话槽工作区的两段上（`re_off` / `im_off` 是**元素**偏移），旋转因子取第 `pi` 组 ——
// 于是配对双实变换（pair.mbt）能拿同一个内核跑自己的布局。

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
  while width * 2 <= n {
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
  if width == n {
    last_stage(pi, arena, re_off, im_off, inverse)
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
/// 末级（width == n，即 step == 1）单独走 v128：相邻两个蝶形的旋转因子也是相邻的，
/// 四项访存全部连续，是这套 radix-2 布局里唯一能整对打包的一级。
///
/// 逐位等价靠两点：① 只做 mul/add/sub，不做 FMA，每条指令与标量式同序；
/// ② 取反用乘 -1.0 而不是 0 - v —— `-x` 与 `(-1)·x` 逐位相同（含 ±0 与 NaN 的符号位），
/// `0 - x` 在 x = 0 时给 +0，会被逐位比对判成不同。
fn last_stage(
  pi : Int,
  arena : FixedArray[Double],
  re_off : Int,
  im_off : Int,
  inverse : Bool,
) -> Unit {
  let n = plan_rev.unsafe_get(pi).length()
  let half = n / 2
  let tc = plan_cos.unsafe_get(pi)
  let ts = plan_sin.unsafe_get(pi)
  let rb = re_off * 8
  let ib = im_off * 8
  let minus_one = @v128.f64x2_splat(-1.0)
  let mut j = 0
  while j < half {
    let p = j + half
    let rj = v128_load2_f64(arena, rb + j * 8)
    let ij = v128_load2_f64(arena, ib + j * 8)
    let rp = v128_load2_f64(arena, rb + p * 8)
    let ip = v128_load2_f64(arena, ib + p * 8)
    let c = v128_load2_f64(tc, j * 8)
    let raw_s = v128_load2_f64(ts, j * 8)
    let s = if inverse { @v128.f64x2_mul(minus_one, raw_s) } else { raw_s }
    let tre = @v128.f64x2_add(@v128.f64x2_mul(rp, c), @v128.f64x2_mul(ip, s))
    let tim = @v128.f64x2_add(
      @v128.f64x2_mul(@v128.f64x2_mul(minus_one, rp), s),
      @v128.f64x2_mul(ip, c),
    )
    v128_store2_f64(arena, rb + p * 8, @v128.f64x2_sub(rj, tre))
    v128_store2_f64(arena, ib + p * 8, @v128.f64x2_sub(ij, tim))
    v128_store2_f64(arena, rb + j * 8, @v128.f64x2_add(rj, tre))
    v128_store2_f64(arena, ib + j * 8, @v128.f64x2_add(ij, tim))
    j = j + 2
  }
}

///|
/// 单条复变换。工作区布局：`re` 在槽首，`im` 紧随其后（宿主侧见 `app/lib/dsp.ts` 的 `fftOf`）。
#export_name("dsp_fft")
pub fn forward(s : Int) -> Unit {
  if slot_ok(s) {
    let pi = slot_plan.unsafe_get(s)
    let n = plan_rev.unsafe_get(pi).length()
    fft_at(pi, slot_mem.unsafe_get(s), 0, n, false)
  }
}

///|
#export_name("dsp_ifft")
pub fn inverse(s : Int) -> Unit {
  if slot_ok(s) {
    let pi = slot_plan.unsafe_get(s)
    let n = plan_rev.unsafe_get(pi).length()
    fft_at(pi, slot_mem.unsafe_get(s), 0, n, true)
  }
}
