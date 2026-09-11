// Benchmarks for the stub codec. They measure one simple thing: **is moving pure integer logic
// out of a JS loop and into the kernel worth it**.
//
// For the side-by-side numbers see docs/migration.md; what stays here are regression anchors:
// paint (the kernel walks columns and writes four pixels per 32-bit store, with no per-pixel loop
// host-side) and decode (the kernel slides a window directly over the f64 profile in the main
// buffer).
//
// Three widths: 400 (8-bit prefix, one window), 2048 (12-bit prefix, two windows), 65535
// (16-bit prefix, the ceiling). Their branches differ, and measuring only one hides that.

///|
test "bench stub: paint one, decode one" (it : @bench.T) {
  for w in [400, 2048, 65535] {
    let jh = job_open(0, stub_paint_bytes(w))
    assert_true(jh >= 1)
    ignore(stub_paint(jh, w, 48000, 1024, 0))
    // The decode half needs an f64 profile: extract one from the block just painted (not timed).
    let prof = profile(job_b(jh), w, stub_rows)
    let dh = job_open(stub_decode_words(w), 0)
    assert_true(dh >= 1)
    // The decode half reads the **main buffer** from element 0 — the array is fetched after open,
    // so no base address has to be computed.
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
