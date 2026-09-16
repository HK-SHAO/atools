///|
test "bench complete STFT (131072 samples / centered periodic Hann)" (
  it : @bench.T,
) {
  let samples = 131072
  let src = noise_array(samples, 0x2545f491)
  for win in probe_wins {
    let hop = win / 4
    let frames = samples / hop + 1
    let bins = win / 2 + 1
    let padded = FixedArray::make(samples + win, 0.0)
    for i = 0; i < samples; i = i + 1 {
      padded.unsafe_set(win / 2 + i, src.unsafe_get(i))
    }
    let window = plan_hann_of(plan(win))
    let output = FixedArray::make(frames * bins * 2, 0.0)
    let slot = slot_open(win)
    let arena = slot_mem.unsafe_get(slot)
    it.bench(name="stft-\{win}", fn() {
      for frame = 0; frame < frames; frame = frame + 1 {
        let start = frame * hop
        for i = 0; i < win; i = i + 1 {
          arena.unsafe_set(
            i,
            padded.unsafe_get(start + i) * window.unsafe_get(i),
          )
          arena.unsafe_set(win + i, 0.0)
        }
        forward(slot)
        let base = frame * bins * 2
        for bin = 0; bin < bins; bin = bin + 1 {
          output.unsafe_set(base + bin, arena.unsafe_get(bin))
          output.unsafe_set(base + bins + bin, arena.unsafe_get(win + bin))
        }
      }
      it.keep(output.unsafe_get(0))
    })
    slot_close(slot)
  }
}
