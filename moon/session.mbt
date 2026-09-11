// 会话槽位。内核里没有「一份全局工作区」—— 宿主可以同时有几件活在算（`encode` 与
// `synthesise` 分属不同 scope，会在同一个 worker 里重叠），各要各的工作区。
//
// 工作区**静态定型**：每槽 `4·max_win + 4·(max_win/2+1)` 个 Double（配对双实变换那套布局的
// 最大并集）。地址在进程内**永不变**（静态数组不搬家），所以宿主切出的视图只会在
// `memory.grow` 把整个 ArrayBuffer 顶掉时失效 —— 那一条由宿主比 `memory.buffer` 身份处理，
// 与作业区共用一套（见 arena.mbt 顶部）。代价是上限 6 槽 ≈ 1.6 MB 常驻。
//
// 占不到槽时 `dsp_slot_open` 给出负值（见下），宿主据此降级 —— 降级，不是崩溃。
// 缓冲布局由打开它的子系统定义，槽本身只管占位、释放、给出缓冲。

///|
let max_slots : Int = 6

///|
let slot_words : Int = 4 * max_win + 4 * (max_win / 2 + 1)

///|
let slot_busy : FixedArray[Bool] = FixedArray::make(max_slots, false)

///|
/// 各槽绑定的 FFT 表组下标（见 plan.mbt）。
let slot_plan : FixedArray[Int] = FixedArray::make(max_slots, -1)

///|
let slot_mem : FixedArray[FixedArray[Double]] = FixedArray::makei(
  max_slots,
  _ => FixedArray::make(slot_words, 0.0),
)

///|
/// 占一个槽并绑定窗长的表组。返回槽号；-1 = 窗长不合法，-2 = 池满。
#export_name("dsp_slot_open")
pub fn slot_open(win : Int) -> Int {
  let pi = plan(win)
  if pi < 0 {
    return -1
  }
  let mut s = 0
  while s < max_slots && slot_busy.unsafe_get(s) {
    s = s + 1
  }
  if s == max_slots {
    return -2
  }
  slot_plan.unsafe_set(s, pi)
  slot_busy.unsafe_set(s, true)
  // 槽是复用的，交出去之前清零。参照实现每次 `new Float64Array` 也是零，两条路的初值必须一致：
  // 配对反变换会读调用方**没有**写过的表（`r2`/`i2` 只写一半时），留上一次的残值就是另一套结果。
  slot_mem.unsafe_get(s).fill(0.0)
  s
}

///|
#export_name("dsp_slot_close")
pub fn slot_close(s : Int) -> Unit {
  if s >= 0 && s < max_slots {
    slot_busy.unsafe_set(s, false)
  }
}

///|
/// 槽工作区。宿主拿它取地址建视图 —— 地址在整个进程期内不变。
#export_name("dsp_slot_mem")
pub fn slot_mem_of(s : Int) -> FixedArray[Double] {
  if s < 0 || s >= max_slots {
    return FixedArray::make(0, 0.0)
  }
  slot_mem.unsafe_get(s)
}

///|
/// 槽工作区的容量（元素）。宿主不该自己算「4S+4H」。
#export_name("dsp_slot_words")
pub fn slot_words_of(s : Int) -> Int {
  if s < 0 || s >= max_slots {
    return 0
  }
  slot_words
}
