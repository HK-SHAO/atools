// 引擎级握手。
//
// **边界只有一条约定**：宿主从「导出函数返回的数组」上取数据区首址，据此切 typed view；
// 内核只报偏移，从不碰地址。这条约定不是标准库文档里写着的（MoonBit 的 wasm 后端
// 对导出函数不做任何 marshalling —— 传进去的 JS 数组会被当成裸 i32 直接越界），
// 所以引导期必须自证一次，**而且要在消费它的那一侧证**：宿主两把视图写、内核读回，
// 内核写、宿主两把视图读回。工具链哪天改了布局，这里先响。
//
// 白盒测试证不了这件事 —— 白盒跑在内核里，两侧本来就是同一份内存。

///|
/// ABI 版本。宿主侧握手时比对，不一致就拒绝启动 —— 编译产物与 JS 侧加载器错配时，
/// 症状会是「算出来的数不对」，那是最难查的一类。
/// 2：导出面换成会话槽（`dsp_slot_*` / `dsp_pair_*`），旧的全局计划接口不复存在。
/// 3：多出作业区（`dsp_job_*`）与 RTISI（`dsp_rtisi_*`）—— 定长工作区之外的第三层内存。
/// 4：多出票根（`dsp_stub_*`）—— 第一个「数组进、数组出」的纯逻辑模块。
/// 5：**导出面去掉全部裸地址**（`*_ptr` 不再返回地址，改用 `dsp_job_d` / `dsp_slot_mem` /
///    表组访问器把**数组本身**交出去），作业区由「大缓冲切段」改为「一作业一段自己的数组」，
///    `levels` 与票根像素迁到独立的字节段（`dsp_job_b`）。`moon/ffi.mbt` 随之删掉 ——
///    内核里不再有任何 `extern`。
/// 6：多出 `dsp_real_ifft`（单边谱翻转 + 复反变换，一次做完）—— 宿主侧的 FFT 类删掉之后，
///    「实序列的反变换」不能在宿主那一侧拼了。
#export_name("dsp_abi")
pub fn abi() -> Int {
  6
}

///|
/// 握手用的格数（主缓冲的元素数、字节段的字节数）。
let probe_n : Int = 8

///|
/// 内核往作业的两段各写一份可校验的花纹。返回 1；0 = 句柄非法或段太小。
#export_name("dsp_probe_stamp")
pub fn probe_stamp(h : Int) -> Int {
  if job_words_of(h) < probe_n || job_bytes_of(h) < probe_n {
    return 0
  }
  let d = job_d(h)
  let b = job_b(h)
  for i = 0; i < probe_n; i = i + 1 {
    d.unsafe_set(i, (1000 + i).to_double())
    b.unsafe_set(i, (200 + i).to_byte())
  }
  1
}

///|
/// 宿主往两把视图里写完之后，内核回读自证。`want_d` / `want_b` 是宿主写下去的基准值。
/// 返回 1 = 两段都对得上。
#export_name("dsp_probe_check")
pub fn probe_check(h : Int, want_d : Int, want_b : Int) -> Int {
  if job_words_of(h) < probe_n || job_bytes_of(h) < probe_n {
    return 0
  }
  let d = job_d(h)
  let b = job_b(h)
  for i = 0; i < probe_n; i = i + 1 {
    if d.unsafe_get(i) != (want_d + i).to_double() {
      return 0
    }
    if b.unsafe_get(i).to_int() != ((want_b + i) & 0xff) {
      return 0
    }
  }
  1
}

///|
/// 内核侧的花纹（宿主核对「内核 → 宿主」那半边时用）。
/// `which`：0 主缓冲基准、1 字节段基准、2 格数。
#export_name("dsp_probe_want")
pub fn probe_want(which : Int) -> Int {
  if which == 0 {
    1000
  } else if which == 1 {
    200
  } else {
    probe_n
  }
}
