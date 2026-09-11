// Wasm 底层原语（内联 WAT）。
//
// 寻址约定：FixedArray 经 `#borrow` 传入内联 WAT 时，i32 参数即**数据区首地址**
// （wasm 后端把表示直接按值传，数据前的头部落在负偏移）。内核缓冲一律是
// 静态容量 FixedArray，宿主以导出地址建 typed view 零拷贝读写。
//
// 该约定非文档化 ABI，由宿主握手测试（app/lib/dsp.test.ts 的指针往返）与
// 逐位等价门禁（app/lib/*.test.ts 的 TS 参照实现）守护：工具链升级若改了布局，
// 会响亮失败，绝不静默。

///|
#borrow(a)
extern "wasm" fn addr_of_i32(a : FixedArray[Int]) -> Int =
  #|(func (param i32) (result i32) local.get 0)

///|
#borrow(a)
extern "wasm" fn addr_of_f64(a : FixedArray[Double]) -> Int =
  #|(func (param i32) (result i32) local.get 0)

///|
extern "wasm" fn mem_fill(dst : Int, c : Int, n : Int) -> Unit =
  #|(func (param i32 i32 i32)
  #|  local.get 0
  #|  local.get 1
  #|  local.get 2
  #|  memory.fill)

///|
extern "wasm" fn mem_copy(dst : Int, src : Int, n : Int) -> Unit =
  #|(func (param i32 i32 i32)
  #|  local.get 0
  #|  local.get 1
  #|  local.get 2
  #|  memory.copy)

// SIMD 访存原语。v128.load 系指令全部支持非对齐访问，入参 off 为**字节**偏移
// （调用方按元素宽 ×8 折算）；地址 = 数组数据区首 + off。

///|
#borrow(a)
extern "wasm" fn v128_load2_f64(a : FixedArray[Double], off : Int) -> V128 =
  #|(func (param i32 i32) (result v128)
  #|  local.get 0
  #|  local.get 1
  #|  i32.add
  #|  v128.load)

///|
#borrow(a)
extern "wasm" fn v128_store2_f64(a : FixedArray[Double], off : Int, v : V128) -> Unit =
  #|(func (param i32 i32 v128)
  #|  local.get 0
  #|  local.get 1
  #|  i32.add
  #|  local.get 2
  #|  v128.store)

// 裸地址读写：只给测试用 —— 它是「导出地址确实指向数组数据区」这条约定的唯一直接证据，
// 宿主侧的 typed view 用的就是同一条约定。

///|
extern "wasm" fn raw_load_i32(addr : Int) -> Int =
  #|(func (param i32) (result i32)
  #|  local.get 0
  #|  i32.load)

///|
extern "wasm" fn raw_store_i32(addr : Int, v : Int) -> Unit =
  #|(func (param i32 i32)
  #|  local.get 0
  #|  local.get 1
  #|  i32.store)
