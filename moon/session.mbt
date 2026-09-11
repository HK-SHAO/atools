// 会话槽位。内核里没有「一份全局工作区」—— 宿主可以同时有几件活在算（`encode` 与
// `synthesise` 分属不同 scope，会在同一个 worker 里重叠），各要各的工作区。
//
// 工作区**静态定型**，每槽 `4·max_win + 4·(max_win/2+1)` 个 Double（配对双实变换那套布局的最大并集）。
// 这是刻意的：`memory.grow` 会让宿主先前切出的 typed view 全部 detach，而并发是常态，
// 「按 job 分配」在单会话下说得通、在并发下说不过去。代价是上限 6 槽 ≈ 1.6 MB 常驻。
//
// 占不到槽时 `dsp_slot_open` 给出负值（见下），宿主据此退回 TS 参照实现 —— 降级，不是崩溃。
// 缓冲布局由打开它的子系统定义，槽本身只管占位、释放、给出首地址。

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
  let arena = slot_mem.unsafe_get(s)
  mem_fill(addr_of_f64(arena), 0, slot_words * 8)
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
/// 槽工作区的首地址。宿主在每个 `dsp_slot_open` 之后重切视图 —— 地址在槽的整个生命期内不变。
#export_name("dsp_slot_ptr")
pub fn slot_ptr(s : Int) -> Int {
  if s < 0 || s >= max_slots {
    return 0
  }
  let a = slot_mem.unsafe_get(s)
  addr_of_f64(a)
}
