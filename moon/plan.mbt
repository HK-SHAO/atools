// FFT 计划：位反转索引、旋转因子、汉宁窗。
//
// 三张表只依赖窗长，建成之后**只读**，所以按窗长缓存（256 / 512 / 1024 / 2048 / 4096 五档），
// 不占会话槽 —— 表不会因为宿主同时跑两件活而互相顶掉，也不需要释放。
// 窗长上限与 app/lib/spectrum.ts 的 MAX_WIN 同值：三档窗长最高 1024，读图侧按几何反推最高 4096。

///|
pub let max_win : Int = 4096

///|
let min_win : Int = 256

///|
/// 表组的档数：256 / 512 / 1024 / 2048 / 4096。
let plan_count : Int = 5

///|
/// 与 JS 的 `Math.PI` 逐位同值。写死而不是取 `@math.pi`（后者已 deprecated）；
/// 旋转因子必须与 TS 参照实现逐位相同，否则整个数值层失去可比性。
let pi : Double = 3.141592653589793

///|
let plan_rev : FixedArray[FixedArray[Int]] = FixedArray::makei(plan_count, _ => FixedArray::make(0, 0))

///|
let plan_cos : FixedArray[FixedArray[Double]] = FixedArray::makei(plan_count, _ => FixedArray::make(0, 0.0))

///|
let plan_sin : FixedArray[FixedArray[Double]] = FixedArray::makei(plan_count, _ => FixedArray::make(0, 0.0))

///|
let plan_hann : FixedArray[FixedArray[Double]] = FixedArray::makei(plan_count, _ => FixedArray::make(0, 0.0))

fn is_pow2(n : Int) -> Bool {
  n >= 2 && (n & (n - 1)) == 0
}

///|
/// 窗长 → 表组下标；非法窗长给 -1。
///
/// 末一条 `i >= plan_count` 是守卫而不是装饰：`min_win` / `max_win` / `plan_count` 三者各自独立，
/// 只要有人改了前两个而忘了第三个，这里就会静默越界读表（曾把 `plan_count` 写成 4，
/// 而 256…4096 是**五个** 2 的幂，4096 直接读到表组外面去）。
fn plan_of(win : Int) -> Int {
  if !is_pow2(win) || win < min_win || win > max_win {
    return -1
  }
  let mut i = 0
  let mut v = min_win
  while v < win {
    v = v * 2
    i = i + 1
  }
  if i >= plan_count {
    return -1
  }
  i
}

///|
/// 立计划（幂等）。返回表组下标，窗长不合法给 -1。
#export_name("dsp_plan")
pub fn plan(win : Int) -> Int {
  let i = plan_of(win)
  if i < 0 {
    return -1
  }
  if plan_rev.unsafe_get(i).length() > 0 {
    return i
  }
  let mut levels = 0
  while (1 << levels) < win {
    levels = levels + 1
  }
  let rev = FixedArray::make(win, 0)
  for k = 0; k < win; k = k + 1 {
    let mut r = 0
    for b = 0; b < levels; b = b + 1 {
      if (k & (1 << b)) != 0 {
        r = r | (1 << (levels - 1 - b))
      }
    }
    rev.unsafe_set(k, r)
  }
  let half = win / 2
  let n = win.to_double()
  let cos = FixedArray::make(half, 0.0)
  let sin = FixedArray::make(half, 0.0)
  for k = 0; k < half; k = k + 1 {
    // 与 TS 同一条表达式、同一结合顺序：(2π·i)/n。浮点每步都是 IEEE754 指定的，
    // 顺序一致就逐位一致；这里刻意不写 2π/n·i，也不合并成乘法。
    let angle = (2.0 * pi * k.to_double()) / n
    cos.unsafe_set(k, @math.cos(angle))
    sin.unsafe_set(k, @math.sin(angle))
  }
  let hann = FixedArray::make(win, 0.0)
  for k = 0; k < win; k = k + 1 {
    hann.unsafe_set(k, 0.5 - 0.5 * @math.cos((2.0 * pi * k.to_double()) / n))
  }
  plan_rev.unsafe_set(i, rev)
  plan_cos.unsafe_set(i, cos)
  plan_sin.unsafe_set(i, sin)
  plan_hann.unsafe_set(i, hann)
  i
}

// 四张表都以「数组」的形式交出去，宿主自己取地址切视图（见 arena.mbt 顶部那条约定）。
// 表建成之后只读、且**永不搬家**，所以宿主取一次就够了 —— 与作业区不同，不必每次重取。

///|
fn plan_tables(i : Int) -> Bool {
  i >= 0 && i < plan_count && plan_rev.unsafe_get(i).length() > 0
}

///|
/// 位反转索引表（`win` 个 i32）。窗长非法或还没立计划时给空表。
#export_name("dsp_plan_rev")
pub fn plan_rev_of(i : Int) -> FixedArray[Int] {
  if !plan_tables(i) {
    return FixedArray::make(0, 0)
  }
  plan_rev.unsafe_get(i)
}

///|
#export_name("dsp_plan_cos")
pub fn plan_cos_of(i : Int) -> FixedArray[Double] {
  if !plan_tables(i) {
    return FixedArray::make(0, 0.0)
  }
  plan_cos.unsafe_get(i)
}

///|
#export_name("dsp_plan_sin")
pub fn plan_sin_of(i : Int) -> FixedArray[Double] {
  if !plan_tables(i) {
    return FixedArray::make(0, 0.0)
  }
  plan_sin.unsafe_get(i)
}

///|
#export_name("dsp_plan_hann")
pub fn plan_hann_of(i : Int) -> FixedArray[Double] {
  if !plan_tables(i) {
    return FixedArray::make(0, 0.0)
  }
  plan_hann.unsafe_get(i)
}
