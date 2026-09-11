// 内核自带的基准：`moon bench --target wasm` 直接跑 wasm 产物本身。
// 它量的是「内核这段代码有多快」，不含 JS↔wasm 边界与宿主搬运；
// 与 TS 参照实现的对照见 app/lib/*.test.ts 的等价门禁和 docs/algorithms.md 的微基准表。

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
