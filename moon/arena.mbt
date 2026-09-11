// 作业区 —— 与表组（plan.mbt，只读缓存）、会话槽（session.mbt，定长工作区）并列的
// 第三种内存。前两种的大小是编译期常量，这里**不是**：一次 encode / invert 的工作集
// 由素材长度决定，从几百 KB 到几十 MB，定不下来。
//
// **一个作业一段自己的缓冲，不是「一个大缓冲切几段」。** 这一条替代了早先那套
// 「单一后备缓冲 + 分段 bump 分配」：既然宿主是从导出函数**返回的数组**上取地址
// （见本目录顶部与 `app/lib/dsp.ts`），那么「句柄 → 数组」就是最短路径 ——
// 段基址、扩容搬运、扩容世代三件事同时消失，当初「段基址被算两次、第一段上完全
// 看不出来」那类错也随之不可能发生。
//
// 代价是每次开户重新分配（`FixedArray::make` 顺手把段清零，与旧的显式 `mem_fill` 同价），
// 而开户一次只在一件活的开头发生，不在逐帧循环里。
//
// **两条缓冲：Double 主缓冲 + Byte 段。** `levels`（一元素一字节）与票根的像素/亮度
// 都是字节数据，塞进 `FixedArray[Double]` 会浪费 8 倍 —— 16M 像素的剖面就是 128 MB。
// 拆开之后内核两侧都用正常下标读写，`level` 那一侧不再需要「按字节偏移去双精度数组里挖」。

///|
/// 同时在算的作业数上限。worker 里最多是「两次 encode + 一次 invert」量级。
/// 拿不到就返回 0，宿主据此走降级路径 —— 与会话槽同一套约定（降级，不是崩）。
let max_jobs : Int = 4

///|
/// 单段上限。64M 元素 = 512 MB，远超实际素材：像素预算是 16M，也就是 `frames×bins`
/// 最大 16M。留这么大只是为了别让一次算错尺寸把 wasm 内存顶爆。
let max_job_words : Int = 1 << 26

///|
/// 字节段上限。最大的两项是 `levels`（`frames×bins` 字节）与票根像素（`w×8×4` 字节）。
let max_job_bytes : Int = 1 << 26

///|
/// 各作业的主缓冲。空闲槽是一段长度 0 的数组 —— 归还时换回它，GC 就能收掉。
let job_mem : FixedArray[FixedArray[Double]] = FixedArray::makei(
  max_jobs,
  _ => FixedArray::make(0, 0.0),
)

///|
/// 各作业的字节段。
let job_bmem : FixedArray[FixedArray[Byte]] = FixedArray::makei(
  max_jobs,
  _ => FixedArray::make(0, b'\x00'),
)

///|
let job_live : FixedArray[Bool] = FixedArray::make(max_jobs, false)

///|
/// 句柄 → 作业下标。非法或已归还的句柄给 -1。
fn job_seg(h : Int) -> Int {
  let j = h - 1
  if j < 0 || j >= max_jobs || !job_live.unsafe_get(j) {
    return -1
  }
  j
}

///|
/// 占一段作业区。`dwords` 是主缓冲的元素数、`bytes` 是字节段的字节数（不要就给 0）。
/// 返回句柄（≥ 1）；0 = 池满或尺寸非法 —— 降级，不是崩。
///
/// 两段都是新建的，`FixedArray::make` 保证零初值，所以这里没有一步「交出去之前清零」：
/// 调用方不该从上一件活的残值里读出东西，这一条由分配方式本身保证。
#export_name("dsp_job_open")
pub fn job_open(dwords : Int, bytes : Int) -> Int {
  if dwords < 0 || bytes < 0 || dwords > max_job_words || bytes > max_job_bytes {
    return 0
  }
  let mut j = 0
  while j < max_jobs && job_live.unsafe_get(j) {
    j = j + 1
  }
  if j == max_jobs {
    return 0
  }
  job_mem.unsafe_set(j, FixedArray::make(dwords, 0.0))
  job_bmem.unsafe_set(j, FixedArray::make(bytes, b'\x00'))
  job_live.unsafe_set(j, true)
  j + 1
}

///|
/// 归还一段作业区。
#export_name("dsp_job_close")
pub fn job_close(h : Int) -> Unit {
  let j = job_seg(h)
  if j < 0 {
    return
  }
  job_live.unsafe_set(j, false)
  job_mem.unsafe_set(j, FixedArray::make(0, 0.0))
  job_bmem.unsafe_set(j, FixedArray::make(0, b'\x00'))
}

///|
/// 主缓冲。**宿主拿它取地址建视图** —— 这是边界上唯一一处跨语言取址，
/// 靠的是「导出函数返回数组时，宿主收到的整数就是数据区首址」这条约定。
/// 作业在开户前不存在，所以宿主每次 `dsp_job_open` 之后都要重新取一次。
#export_name("dsp_job_d")
pub fn job_d(h : Int) -> FixedArray[Double] {
  let j = job_seg(h)
  if j < 0 {
    return FixedArray::make(0, 0.0)
  }
  job_mem.unsafe_get(j)
}

///|
/// 字节段。
#export_name("dsp_job_b")
pub fn job_b(h : Int) -> FixedArray[Byte] {
  let j = job_seg(h)
  if j < 0 {
    return FixedArray::make(0, b'\x00')
  }
  job_bmem.unsafe_get(j)
}

///|
/// 主缓冲长度（元素）。宿主不该从地址反推它。
#export_name("dsp_job_words")
pub fn job_words_of(h : Int) -> Int {
  let j = job_seg(h)
  if j < 0 {
    return 0
  }
  job_mem.unsafe_get(j).length()
}

///|
/// 字节段长度（字节）。
#export_name("dsp_job_bytes")
pub fn job_bytes_of(h : Int) -> Int {
  let j = job_seg(h)
  if j < 0 {
    return 0
  }
  job_bmem.unsafe_get(j).length()
}

///|
/// 白盒：在用的作业数。盯住「开户/归还配平」这条不变量。
#export_name("dsp_job_live")
pub fn job_live_count() -> Int {
  let mut n = 0
  for j = 0; j < max_jobs; j = j + 1 {
    if job_live.unsafe_get(j) {
      n = n + 1
    }
  }
  n
}

///|
/// 白盒：某槽是否在用（0/1）。越界给 -1。
#export_name("dsp_job_busy")
pub fn job_busy_at(j : Int) -> Int {
  if j < 0 || j >= max_jobs {
    return -1
  }
  if job_live.unsafe_get(j) {
    1
  } else {
    0
  }
}
