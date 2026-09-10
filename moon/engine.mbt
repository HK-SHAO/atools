// 引擎级握手：canary 缓冲供宿主双向校验「导出地址 = FixedArray 数据区」这条寻址约定。
// 全部零拷贝 view 都建立在该约定上，故引导期必测；一旦工具链改了布局，这里先响。

///|
/// ABI 版本。宿主侧握手时比对，不一致就拒绝启动 —— 编译产物与 JS 侧加载器错配时，
/// 症状会是「算出来的数不对」，那是最难查的一类。
#export_name("dsp_abi")
pub fn abi() -> Int {
  1
}

///|
let canary : FixedArray[Int] = FixedArray::make(4, 0)

///|
/// canary 缓冲的线性内存地址（4 个 i32），供宿主侧 FFI 握手。
#export_name("dsp_canary_ptr")
pub fn canary_ptr() -> Int {
  addr_of_i32(canary)
}

///|
/// canary 缓冲长度（恒为 4）。
#export_name("dsp_canary_len")
pub fn canary_len() -> Int {
  4
}

///|
/// 写一格 canary（宿主校验地址往返用）。
#export_name("dsp_canary_set")
pub fn canary_set(i : Int, v : Int) -> Unit {
  canary[i] = v
}

///|
/// 读一格 canary。
#export_name("dsp_canary_get")
pub fn canary_get(i : Int) -> Int {
  canary[i]
}

///|
/// 白盒测试：canary_ptr() 报的地址必须真的是 canary 数据区的首地址。
/// 这是「零拷贝 view」契约的自证 —— 从裸地址读数，与从数组下标读数应当恒等。
test "canary 的导出地址就是数据区首地址" {
  canary_set(0, 12345)
  canary_set(1, -7)
  canary_set(2, 999)
  let base = canary_ptr()
  assert_eq(raw_load_i32(base), 12345)
  // 每格 4 字节：第 2 格落在 +8
  assert_eq(raw_load_i32(base + 8), 999)
  // 反向：从裸地址写进去，数组下标读得到
  raw_store_i32(base + 12, 4242)
  assert_eq(canary_get(3), 4242)
  for i = 0; i < 4; i = i + 1 {
    canary_set(i, 0)
  }
}
