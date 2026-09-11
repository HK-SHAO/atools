// 内核自带的基准：`moon bench --target wasm` 直接跑 wasm 产物本身。
//
// RTISI-LA 是整条链**唯一的热路径**（逆变换里 78% 在它，其中约八成是 FFT 本身，
// 见 docs/algorithms.md 的画像）。这里量的是逐帧推进这一段 —— 数据搬运、
// 作业区开户、`finish` 的重叠归一化都在它外面，那些要么一帧一次、要么只一次。
//
// 形状取画像里那条活：8s@8kHz、win 512、501 帧、iters 8。
//
// ⚠️ **绝对值别当真实耗时用。** `moon bench --target wasm` 的产物由 `moonrun` 执行
// （link 时带 `-wasi`、导出 test-driver 入口），而宿主跑的是 V8 —— 两个运行时对同一份
// wasm 的读数本来就不同，且**差多少取决于这段代码走不走 `v128`**。
// 实测表与归因（含「同一份产物换引擎跑」这个对照）见 `docs/algorithms.md` 的
// 「moon bench 的读数归 moonrun」。所以 bench 的用途是**同运行时的前后回归锚点**，
// 「内核比 TS 快多少」那种话必须拿 `bench/kernel.ts` 的宿主侧 A/B 去说
// （同机同轮、两条路交替、各自取最快，实测 1.31×）。

///|
/// 每轮开始前把 `out` 清一遍：不清的话 `out` 会一轮一轮累加下去（值本身不改变
/// 指令数与时序，但读数就不再对应同一个工作集了）。实测这一段的开销与「不清」
/// 只差 2%，而分块推进（宿主按 frames/64 分块，这里 7 帧一块）与一次调到底
/// 逐位同值、耗时也只差 0.2% —— 两条都量过，不是估计。
test "bench RTISI-LA 逐帧推进（501 帧 / win 512 / iters 8）" (it : @bench.T) {
  let fx = make_fx(501, 512, 128, 440.0)
  let h = rtisi_open(fx.frames, fx.bins, fx.win, fx.hop, fx.samples, 8, 1, 0, 0.0)
  assert_true(h >= 1)
  let hdr = rtisi_hdr.unsafe_get(h - 1)
  let fb = fx.frames * fx.bins
  // 视图在 open 之后取 —— 作业的缓冲是 open 时才建的，句柄到手之前没有数组可切。
  let mem = job_d(h)
  for i = 0; i < fb; i = i + 1 {
    mem.unsafe_set(hdr.unsafe_get(12) + i, fx.mag.unsafe_get(i))
    mem.unsafe_set(hdr.unsafe_get(13) + i, fx.warm.unsafe_get(i))
  }
  let off_out = hdr.unsafe_get(16)
  let padded = hdr.unsafe_get(9)
  it.bench(name="run", fn() {
    for i = 0; i < padded; i = i + 1 {
      mem.unsafe_set(off_out + i, 0.0)
    }
    ignore(rtisi_run(h, 0, fx.frames))
    it.keep(mem.unsafe_get(off_out))
  })
  rtisi_close(h)
}
