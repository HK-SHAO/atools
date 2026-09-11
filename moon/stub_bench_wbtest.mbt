// 票根的基准。它量的一件很简单的事：**把一段纯整数逻辑从 JS 循环搬进内核值不值**。
//
// 两边的数字对照见 docs/migration.md，这里只留可回归的锚点：画一条（内核按列推进、
// 一次 32 位写下四个像素，宿主那边一个像素循环都不用写）与认一条（内核拿主缓冲里的
// f64 剖面直接滑窗）。
//
// 宽度取三档：400（8 位前缀、单窗口）、2048（12 位前缀、双窗口）、65535（16 位前缀、
// 上限）。三档的分支不一样，只量一档会把分支差异藏起来。

///|
test "bench 票根：画一条、认一条" (it : @bench.T) {
  for w in [400, 2048, 65535] {
    let jh = job_open(0, stub_paint_bytes(w))
    assert_true(jh >= 1)
    ignore(stub_paint(jh, w, 48000, 1024, 0))
    // 认的那一段要一个 f64 剖面：从刚画的块里抽一遍（这一段不计时）。
    let prof = profile(job_b(jh), w, stub_rows)
    let dh = job_open(stub_decode_words(w), 0)
    assert_true(dh >= 1)
    // 认的那一段读的是**主缓冲**的第 0 个元素起 —— 数组在 open 之后现取，没有基址要算。
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
