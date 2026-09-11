// 内核自带的基准：`moon bench --target wasm` 直接跑 wasm 产物本身。
// 它量的是「内核这段代码有多快」，不含 JS↔wasm 边界与宿主搬运；
// 与 TS 参照实现的对照见 app/lib/*.test.ts 的等价门禁和 docs/algorithms.md 的微基准表。

///|
/// 基准框架自身的水位：一次闭包调用 + 一次 `keep`（防止死代码消除）。
///
/// 它的用途是**把「框架开销」与「引擎差异」分开**。`moon bench --target wasm` 的产物由
/// `moonrun` 执行（link 时带 `-wasi`、导出 test-driver 入口），而宿主跑的是 V8 —— 两个
/// 运行时对同一份 wasm 的读数本来就不该相等。实测 512 点变换：框架内 3.98 µs、V8 里
/// 直接调同一个导出 2.83 µs；这条水位若只有几十纳秒，那 1.4× 就只能记在引擎上。
test "bench 框架水位" (it : @bench.T) {
  let s = open_fft(512, noise_array(512, 1))
  let arena = slot_mem.unsafe_get(s)
  it.bench(name="harness-noop", fn() {
    it.keep(arena.unsafe_get(0))
  })
  slot_close(s)
}

///|
test "bench 单条原地 FFT" (it : @bench.T) {
  for win in probe_wins {
    let src = noise_array(win, 0x9e3779b9 + win)
    let s = open_fft(win, src)
    it.bench(name="forward-\{win}", fn() {
      fill_fft(s, win, src)
      forward(s)
      it.keep(slot_mem.unsafe_get(s).unsafe_get(0))
    })
    it.bench(name="inverse-\{win}", fn() {
      fill_fft(s, win, src)
      inverse(s)
      it.keep(slot_mem.unsafe_get(s).unsafe_get(0))
    })
    // 把「填数」从读数里拆出来：上面的名字里含一次 `fill_fft`（win 次读 + win 次写），
    // 而宿主侧的微基准通常只量变换本身。两者混在一起会让人把搬运开销读成「工具链慢一档」——
    // 实测 512 点差 1.5 µs、4096 点差 14 µs，正好就是这一步的量级。
    // 配对的三条（fill / forward-alone / forward）满足 forward ≈ fill + forward-alone。
    it.bench(name="fill-\{win}", fn() {
      fill_fft(s, win, src)
      it.keep(src.unsafe_get(0))
    })
    it.bench(name="forward-alone-\{win}", fn() {
      forward(s)
      it.keep(slot_mem.unsafe_get(s).unsafe_get(0))
    })
    slot_close(s)
  }
}

///|
test "bench 配对双实变换" (it : @bench.T) {
  for win in probe_wins {
    let s = slot_open(win)
    let arena = slot_mem.unsafe_get(s)
    let y1 = noise_array(win, 0x9e3779b9 + win)
    let y2 = noise_array(win, 0x85ebca6b + win)
    let x1 = pair_off(4, win)
    let x2 = pair_off(5, win)
    let load = fn() {
      for i = 0; i < win; i = i + 1 {
        arena.unsafe_set(x1 + i, y1.unsafe_get(i))
        arena.unsafe_set(x2 + i, y2.unsafe_get(i))
      }
    }
    it.bench(name="pair-forward-\{win}", fn() {
      load()
      pair_forward(s)
      it.keep(arena.unsafe_get(pair_off(0, win)))
    })
    it.bench(name="pair-inverse-\{win}", fn() {
      load()
      pair_inverse(s)
      it.keep(arena.unsafe_get(x1))
    })
    slot_close(s)
  }
}
