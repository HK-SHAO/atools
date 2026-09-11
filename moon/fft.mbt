// 原地 radix-2 FFT。与 TS 参照实现（`app/lib/fft.ts` 的 `FFT.transform`）逐位等价，
// 由 `app/lib/fft.test.ts` 的逐位门禁守住 —— 顺序、除法、符号都不能动。

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
  for i = 0; i < n; i = i + 1 {
    let j = rev[i]
    if j > i {
      let a = re[i]
      re[i] = re[j]
      re[j] = a
      let b = im[i]
      im[i] = im[j]
      im[j] = b
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
        let c = tw_cos[k]
        let s = if inverse { -tw_sin[k] } else { tw_sin[k] }
        let rp = re[p]
        let ip = im[p]
        let tre = rp * c + ip * s
        let tim = -rp * s + ip * c
        let rj = re[j]
        let ij = im[j]
        re[p] = rj - tre
        im[p] = ij - tim
        re[j] = rj + tre
        im[j] = ij + tim
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
      re[i] = re[i] / nf
      im[i] = im[i] / nf
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
