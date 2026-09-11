///|
fn paint(w : Int, sr : Int, win : Int, exact : Bool) -> Int raise {
  let h = job_open(0, stub_paint_bytes(w))
  assert_true(h >= 1)
  assert_eq(stub_paint(h, w, sr, win, if exact { 1 } else { 0 }), 1)
  h
}

///|
fn band_at(buf : FixedArray[Byte], x : Int, y : Int, w : Int) -> Double {
  let p = (y * w + x) * 4
  let r = buf.unsafe_get(p).to_double()
  let g = buf.unsafe_get(p + 1).to_double()
  let b = buf.unsafe_get(p + 2).to_double()
  0.299 * r + 0.587 * g + 0.114 * b
}

///|
fn profile(buf : FixedArray[Byte], w : Int, rows : Int) -> FixedArray[Double] {
  let out = FixedArray::make(w, 0.0)
  for x = 0; x < w; x = x + 1 {
    let mut s = 0.0
    for y = 0; y < rows; y = y + 1 {
      s = s + band_at(buf, x, y, w)
    }
    out.unsafe_set(x, s / rows.to_double())
  }
  out
}

///|
fn decode(prof : FixedArray[Double]) -> Int raise {
  let n = prof.length()
  let h = job_open(stub_decode_words(n), 0)
  assert_true(h >= 1)
  let mem = job_d(h)
  for i = 0; i < n; i = i + 1 {
    mem.unsafe_set(i, prof.unsafe_get(i))
  }
  let packed = stub_decode(h, n)
  job_close(h)
  packed
}

///|
fn pk_width(p : Int) -> Int {
  p & 0xffff
}

///|
fn pk_sr(p : Int) -> Int {
  stub_sr.unsafe_get((p >> 16) & 0xf)
}

///|
fn pk_win(p : Int) -> Int {
  stub_wins.unsafe_get((p >> 20) & 3)
}

///|
fn pk_exact(p : Int) -> Bool {
  ((p >> 22) & 1) == 1
}

///|
fn resample_profile(
  buf : FixedArray[Byte],
  w : Int,
  rows : Int,
  s : Double,
  noise : Double,
) -> FixedArray[Double] {
  let n = (w.to_double() * s).round().to_int()
  let out = FixedArray::make(n, 0.0)
  for x = 0; x < n; x = x + 1 {
    let x0 = x.to_double() / s
    let x1 = (x + 1).to_double() / s
    let lo = x0.to_int()
    let mut hi = lo + 1
    let c1 = x1.ceil().to_int()
    if c1 > hi {
      hi = c1
    }
    let mut sum = 0.0
    let mut cnt = 0
    let mut xi = lo
    while xi < hi {
      if xi < w {
        let mut row_sum = 0.0
        for y = 0; y < rows; y = y + 1 {
          row_sum = row_sum + band_at(buf, xi, y, w)
        }
        sum = sum + row_sum / rows.to_double()
        cnt = cnt + 1
      }
      xi = xi + 1
    }
    let mid = if cnt > 0 { sum / cnt.to_double() } else { 0.0 }
    out.unsafe_set(x, mid + @math.sin(x.to_double() * 12.9898) * noise)
  }
  out
}

///|
test "white box: 1:1 exact round trip (paint, extract, decode)" {
  let w = 400
  let jh = paint(w, 44100, 512, true)
  let p = decode(profile(job_b(jh), w, stub_rows))
  assert_true(p != 0)
  assert_eq(pk_width(p), w)
  assert_eq(pk_sr(p), 44100)
  assert_eq(pk_win(p), 512)
  assert_true(pk_exact(p))
  job_close(jh)
}

///|
test "white box: still decodes at 0.5x / 0.75x / 0.9x scale with jitter" {
  let w = 600
  let jh = paint(w, 48000, 1024, false)
  for s in [0.5, 0.75, 0.9] {
    let p = decode(resample_profile(job_b(jh), w, stub_rows, s, 6.0))
    assert_true(p != 0)
    assert_eq(pk_width(p), w)
    assert_eq(pk_sr(p), 48000)
    assert_eq(pk_win(p), 1024)
    assert_true(!pk_exact(p))
  }
  job_close(jh)
}

///|
test "white box: a narrow image decodes from the bottom, and absent receipts do not" {
  let w = 160
  let jh = paint(w, 8000, 256, false)
  let p = decode(profile(job_b(jh), w, stub_rows))
  assert_true(p != 0)
  assert_eq(pk_width(p), w)
  assert_eq(pk_sr(p), 8000)
  assert_eq(pk_win(p), 256)
  let flat = FixedArray::make(w, 111.2)
  assert_eq(decode(flat), 0)
  job_close(jh)
}

///|
fn flip_bit(buf : FixedArray[Byte], w : Int, bit : Int) -> Unit {
  for x = 4 + bit * 4; x < 8 + bit * 4; x = x + 1 {
    let cur = buf.unsafe_get(x * 4).to_int()
    let flip = if cur == stub_light { stub_dark } else { stub_light }
    for y = 0; y < stub_rows; y = y + 1 {
      let q = (y * w + x) * 4
      buf.unsafe_set(q, flip.to_byte())
      buf.unsafe_set(q + 1, flip.to_byte())
      buf.unsafe_set(q + 2, flip.to_byte())
    }
  }
}

///|
test "white box: CRC rejects a bad bit stream, and one of two redundant copies is caught by the other" {
  let one = 200
  let jh = paint(one, 44100, 512, true)
  assert_true(decode(profile(job_b(jh), one, stub_rows)) != 0)
  flip_bit(job_b(jh), one, 8)
  assert_eq(decode(profile(job_b(jh), one, stub_rows)), 0)
  job_close(jh)
  let two = 400
  let j2 = paint(two, 44100, 512, true)
  flip_bit(job_b(j2), two, 8)
  let p = decode(profile(job_b(j2), two, stub_rows))
  assert_true(p != 0)
  assert_eq(pk_width(p), two)
  assert_eq(pk_sr(p), 44100)
  job_close(j2)
}

///|
test "white box: all three width prefixes round-trip (including the two-window wide image)" {
  for w in [255, 4095, 65535] {
    let jh = paint(w, 96000, 2048, true)
    let p = decode(profile(job_b(jh), w, stub_rows))
    assert_true(p != 0)
    assert_eq(pk_width(p), w)
    assert_eq(pk_sr(p), 96000)
    assert_eq(pk_win(p), 2048)
    assert_true(pk_exact(p))
    job_close(jh)
  }
}

///|
test "white box: row count and both ladders answer via the exported surface, out of range gives 0" {
  assert_eq(stub_rows_of(), 8)
  assert_true(stub_rows_of() == stub_rows)
  assert_eq(stub_sr_at(0), 8000)
  assert_eq(stub_sr_at(7), 44100)
  assert_eq(stub_sr_at(stub_sr.length() - 1), 192000)
  assert_eq(stub_sr_at(-1), 0)
  assert_eq(stub_sr_at(stub_sr.length()), 0)
  assert_eq(stub_win_at(0), 256)
  assert_eq(stub_win_at(3), 2048)
  assert_eq(stub_win_at(4), 0)
  assert_eq(stub_win_at(-1), 0)
  assert_true(stub_sr.length() <= 16)
  assert_true(stub_wins.length() <= 4)
}

///|
test "white box: parameters that do not fit write no receipt (not a broken one)" {
  let bad : FixedArray[(Int, Int, Int)] = [
    (400, 12345, 512),
    (400, 44100, 300),
    (1, 44100, 512),
  ]
  for (w, sr, win) in bad {
    let h = job_open(0, stub_paint_bytes(w))
    assert_true(h >= 1)
    assert_eq(stub_luma(h, w, sr, win, 0), 0)
    assert_eq(stub_paint(h, w, sr, win, 0), 0)
    job_close(h)
  }
}

///|
test "white box: an image too narrow does not reserve a receipt position" {
  assert_true(stub_fits(100) == 1)
  assert_true(stub_fits(160) == 1)
  assert_true(stub_fits(42) == 0)
  assert_true(stub_fits(stub_min_decode) == 1)
  assert_true(stub_fits(stub_min_decode - 1) == 0)
  assert_true(stub_fits(30) == 0)
  assert_eq(stub_paint_bytes(400), 400 * stub_rows * 4)
}

///|
test "white box: when stub_fits says it fits, that width really decodes" {
  let mut w = 1
  let mut first_bad = 0
  let mut fits_n = 0
  let mut ok_n = 0
  while w <= 512 {
    let fits = stub_fits(w) == 1
    let jh = job_open(0, stub_paint_bytes(w))
    assert_true(jh >= 1)
    let mut ok = false
    if stub_paint(jh, w, 44100, 512, 1) == 1 {
      ok = decode(profile(job_b(jh), w, stub_rows)) != 0
    }
    job_close(jh)
    if fits {
      fits_n = fits_n + 1
    }
    if ok {
      ok_n = ok_n + 1
    }
    if fits != ok && first_bad == 0 {
      first_bad = w
    }
    w = w + 1
  }
  assert_true(fits_n > 0 && fits_n < 512)
  assert_eq(first_bad, 0)
  assert_eq(fits_n, ok_n)
}
