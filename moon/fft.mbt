// 原地 radix-2 FFT。与 TS 参照实现（`app/lib/fft.ts` 的 `FFT.transform`）逐位等价，
// 由 `app/lib/fft.test.ts` 的逐位门禁守住 —— 顺序、除法、符号都不能动。
//
// **热循环里一律用 `unsafe_get` / `unsafe_set`，不写 `arr[i]`。** 后者编译出来的是一次
// `moonbit.check_range` + 一次 `moonbit.array_length` 调用，两个都不内联：同一个 512 点变换
// 因此从「比 V8 的 TS 慢 7 倍」变成「快 1.5 倍」（实测见 docs/algorithms.md 的微基准表）。
// 数组一律按 `max_win` 静态定型、下标恒 < `plan_win`，越界不可能发生，省掉的是纯开销。

///|
/// FFT 工作区。长度上限同 `max_win`；输入输出同址，宿主经 `dsp_re_ptr` / `dsp_im_ptr` 读写。
let re : FixedArray[Double] = FixedArray::make(max_win, 0.0)

///|
let im : FixedArray[Double] = FixedArray::make(max_win, 0.0)

///|
#export_name("dsp_re_ptr")
pub fn re_ptr() -> Int {
  addr_of_f64(re)
}

///|
#export_name("dsp_im_ptr")
pub fn im_ptr() -> Int {
  addr_of_f64(im)
}

///|
#export_name("dsp_fft")
pub fn forward() -> Unit {
  transform(false)
}

///|
#export_name("dsp_ifft")
pub fn inverse() -> Unit {
  transform(true)
}

fn transform(inverse : Bool) -> Unit {
  let n = plan_win.val
  if n == 0 {
    return
  }
  let fr = re
  let fi = im
  let ix = rev
  let tc = tw_cos
  let ts = tw_sin
  for i = 0; i < n; i = i + 1 {
    let j = ix.unsafe_get(i)
    if j > i {
      let a = fr.unsafe_get(i)
      fr.unsafe_set(i, fr.unsafe_get(j))
      fr.unsafe_set(j, a)
      let b = fi.unsafe_get(i)
      fi.unsafe_set(i, fi.unsafe_get(j))
      fi.unsafe_set(j, b)
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
        let rp = fr.unsafe_get(p)
        let ip = fi.unsafe_get(p)
        let tre = rp * c + ip * s
        let tim = -rp * s + ip * c
        let rj = fr.unsafe_get(j)
        let ij = fi.unsafe_get(j)
        fr.unsafe_set(p, rj - tre)
        fi.unsafe_set(p, ij - tim)
        fr.unsafe_set(j, rj + tre)
        fi.unsafe_set(j, ij + tim)
        j = j + 1
        k = k + step
      }
      base = base + width
    }
    width = width * 2
  }
  if width == n {
    last_stage(inverse)
  }
  if inverse {
    // 除以 n，不是乘 1/n：TS 参照实现写的是 `re[i] / n`，两者在浮点上不等价（1/n 不精确）
    let nf = n.to_double()
    for i = 0; i < n; i = i + 1 {
      fr.unsafe_set(i, fr.unsafe_get(i) / nf)
      fi.unsafe_set(i, fi.unsafe_get(i) / nf)
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
fn last_stage(inverse : Bool) -> Unit {
  let n = plan_win.val
  let half = n / 2
  let minus_one = @v128.f64x2_splat(-1.0)
  let mut j = 0
  while j < half {
    let p = j + half
    let rj = v128_load2_f64(re, j * 8)
    let ij = v128_load2_f64(im, j * 8)
    let rp = v128_load2_f64(re, p * 8)
    let ip = v128_load2_f64(im, p * 8)
    let c = v128_load2_f64(tw_cos, j * 8)
    let raw_s = v128_load2_f64(tw_sin, j * 8)
    let s = if inverse { @v128.f64x2_mul(minus_one, raw_s) } else { raw_s }
    let tre = @v128.f64x2_add(@v128.f64x2_mul(rp, c), @v128.f64x2_mul(ip, s))
    let tim = @v128.f64x2_add(@v128.f64x2_mul(@v128.f64x2_mul(minus_one, rp), s), @v128.f64x2_mul(ip, c))
    v128_store2_f64(re, p * 8, @v128.f64x2_sub(rj, tre))
    v128_store2_f64(im, p * 8, @v128.f64x2_sub(ij, tim))
    v128_store2_f64(re, j * 8, @v128.f64x2_add(rj, tre))
    v128_store2_f64(im, j * 8, @v128.f64x2_add(ij, tim))
    j = j + 2
  }
}
