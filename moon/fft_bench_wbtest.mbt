///|
test "bench harness floor" (it : @bench.T) {
  let s = open_fft(512, noise_array(512, 1))
  let arena = slot_mem.unsafe_get(s)
  it.bench(name="harness-noop", fn() { it.keep(arena.unsafe_get(0)) })
  slot_close(s)
}

///|
test "bench single in-place FFT" (it : @bench.T) {
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
test "bench paired two-real transform" (it : @bench.T) {
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
