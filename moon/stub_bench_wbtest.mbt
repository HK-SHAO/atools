///|
test "bench stub: paint one, decode one" (it : @bench.T) {
  for w in [400, 2048, 65535] {
    let jh = job_open(0, stub_paint_bytes(w))
    assert_true(jh >= 1)
    ignore(stub_paint(jh, w, 48000, 1024, 0))
    let prof = profile(job_b(jh), w, stub_rows)
    let dh = job_open(stub_decode_words(w), 0)
    assert_true(dh >= 1)
    let mem = job_d(dh)
    for i = 0; i < w; i = i + 1 {
      mem.unsafe_set(i, prof.unsafe_get(i))
    }
    it.bench(name="paint-\{w}", fn() {
      it.keep(stub_paint(jh, w, 48000, 1024, 0).to_double())
    })
    it.bench(name="decode-\{w}", fn() {
      it.keep(stub_decode(dh, w).to_double())
    })
    job_close(jh)
    job_close(dh)
  }
}
