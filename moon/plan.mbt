// FFT 计划：位反转索引、旋转因子、汉宁窗。
//
// 三张表都按窗长上限静态定型（运行期零分配），`dsp_plan(win)` 只重填前 win 项。
// 上限与 src/lib/spectrum.ts 的 MAX_WIN 同值：三档窗长最高 1024，读图侧按几何反推最高 4096。

///|
pub let max_win : Int = 4096

///|
/// 与 JS 的 `Math.PI` 逐位同值。写死而不是取 `@math.pi`（后者已 deprecated）；
/// 旋转因子必须与 TS 参照实现逐位相同，否则整个数值层失去可比性。
let pi : Double = 3.141592653589793

///| 当前计划。用 Ref 而不是 top-level `let mut`：后者在包级不受支持
let plan_win : Ref[Int] = Ref::Ref(0)

///|
let rev : FixedArray[Int] = FixedArray::make(max_win, 0)

///|
let tw_cos : FixedArray[Double] = FixedArray::make(max_win / 2, 0.0)

///|
let tw_sin : FixedArray[Double] = FixedArray::make(max_win / 2, 0.0)

///|
let hann : FixedArray[Double] = FixedArray::make(max_win, 0.0)

fn is_pow2(n : Int) -> Bool {
  n >= 2 && (n & (n - 1)) == 0
}

///|
/// 立计划：win 必须是 2 的幂且不超上限。返回 0 成功、-1 参数不合格。
#export_name("dsp_plan")
pub fn plan(win : Int) -> Int {
  if not(is_pow2(win)) || win > max_win {
    return -1
  }
  let mut levels = 0
  while (1 << levels) < win {
    levels = levels + 1
  }
  for i = 0; i < win; i = i + 1 {
    let mut r = 0
    for b = 0; b < levels; b = b + 1 {
      if (i & (1 << b)) != 0 {
        r = r | (1 << (levels - 1 - b))
      }
    }
    rev[i] = r
  }
  let half = win / 2
  let n = win.to_double()
  for i = 0; i < half; i = i + 1 {
    // 与 TS 同一条表达式、同一结合顺序：(2π·i)/n。浮点每步都是 IEEE754 指定的，
    // 顺序一致就逐位一致；这里刻意不写 2π/n·i，也不合并成乘法。
    let angle = (2.0 * pi * i.to_double()) / n
    tw_cos[i] = @math.cos(angle)
    tw_sin[i] = @math.sin(angle)
  }
  for i = 0; i < win; i = i + 1 {
    hann[i] = 0.5 - 0.5 * @math.cos((2.0 * pi * i.to_double()) / n)
  }
  plan_win.val = win
  0
}

///|
#export_name("dsp_plan_win")
pub fn window() -> Int {
  plan_win.val
}

///|
#export_name("dsp_rev_ptr")
pub fn rev_ptr() -> Int {
  addr_of_i32(rev)
}

///|
#export_name("dsp_tw_cos_ptr")
pub fn tw_cos_ptr() -> Int {
  addr_of_f64(tw_cos)
}

///|
#export_name("dsp_tw_sin_ptr")
pub fn tw_sin_ptr() -> Int {
  addr_of_f64(tw_sin)
}

///|
#export_name("dsp_hann_ptr")
pub fn hann_ptr() -> Int {
  addr_of_f64(hann)
}
