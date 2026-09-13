///|
let stub_rows : Int = 8

///|
let stub_sync : Int = 0b1010

///|
let stub_magic : Int = 0b1011

///|
let stub_dark : Int = 20

///|
let stub_light : Int = 230

///|
let stub_crc_poly : Int = 0x07

///|
let stub_bits_cap : Int = 64

///|
let stub_min_decode : Int = 46

///|
let stub_sr : FixedArray[Int] = [
  8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000,
  176400, 192000,
]

///|
let stub_wins : FixedArray[Int] = [256, 512, 1024, 2048]

///|
let stub_width_bits : FixedArray[Int] = [8, 12, 16, 0]

///|
fn stub_index(t : FixedArray[Int], v : Int) -> Int {
  let mut i = 0
  while i < t.length() {
    if t.unsafe_get(i) == v {
      return i
    }
    i = i + 1
  }
  -1
}

///|
fn stub_width_index(w : Int) -> Int {
  if w <= 0xff {
    0
  } else if w <= 0xfff {
    1
  } else {
    2
  }
}

///|
fn stub_bit_px(w : Int) -> Int {
  if w >= 160 {
    4
  } else if w >= 70 {
    2
  } else {
    1
  }
}

///|
fn stub_total_bits(w : Int) -> Int {
  25 + stub_width_bits.unsafe_get(stub_width_index(w))
}

///|
fn stub_span(w : Int) -> Int {
  2 + stub_total_bits(w) * stub_bit_px(w)
}

///|
fn stub_crc8(bits : FixedArray[Int], from : Int, len : Int) -> Int {
  let mut crc = 0xff
  for i = 0; i < len; i = i + 1 {
    crc = crc ^ (bits.unsafe_get(from + i) << 7)
    for _j = 0; _j < 8; _j = _j + 1 {
      crc = if (crc & 0x80) != 0 {
        ((crc << 1) ^ stub_crc_poly) & 0xff
      } else {
        (crc << 1) & 0xff
      }
    }
  }
  crc
}

///|
fn stub_push(bits : FixedArray[Int], at : Int, v : Int, n : Int) -> Int {
  for i = 0; i < n; i = i + 1 {
    bits.unsafe_set(at + i, (v >> (n - 1 - i)) & 1)
  }
  at + n
}

///|
fn stub_get(bits : FixedArray[Int], at : Int, n : Int) -> Int {
  let mut v = 0
  for i = 0; i < n; i = i + 1 {
    v = (v << 1) | bits.unsafe_get(at + i)
  }
  v
}

///|
fn stub_encode(
  bits : FixedArray[Int],
  w : Int,
  sr : Int,
  win : Int,
  exact : Int,
) -> Int {
  let si = stub_index(stub_sr, sr)
  let wi = stub_index(stub_wins, win)
  if si < 0 || wi < 0 || w < 2 || w > 0xffff {
    return 0
  }
  let mut at = 0
  at = stub_push(bits, at, stub_sync, 4)
  at = stub_push(bits, at, stub_magic, 4)
  at = stub_push(bits, at, stub_width_index(w), 2)
  at = stub_push(bits, at, w, stub_width_bits.unsafe_get(stub_width_index(w)))
  at = stub_push(bits, at, si, 4)
  at = stub_push(bits, at, wi, 2)
  at = stub_push(bits, at, exact, 1)
  at = stub_push(bits, at, stub_crc8(bits, 4, at - 4), 8)
  at
}

///|
fn stub_lum_at(bits : FixedArray[Int], x : Int, w : Int) -> Int {
  let span = stub_span(w)
  let step = stub_bit_px(w)
  let mut at = -1
  if x >= 2 && x < 2 + span {
    at = x - 2
  } else if w >= 2 * span + 6 && x >= w - span {
    at = x - (w - span)
  }
  if at < 2 {
    return stub_dark
  }
  let bit = bits.unsafe_get((at - 2) / step)
  if bit == 0 {
    stub_dark
  } else {
    stub_light
  }
}

///|
/// Returns the number of metadata rows reserved in an image.
#export_name("dsp_stub_rows")
pub fn stub_rows_of() -> Int {
  stub_rows
}

///|
/// Returns a supported sample rate by index, or zero.
#export_name("dsp_stub_sr")
pub fn stub_sr_at(i : Int) -> Int {
  if i < 0 || i >= stub_sr.length() {
    0
  } else {
    stub_sr.unsafe_get(i)
  }
}

///|
/// Returns a supported window size by index, or zero.
#export_name("dsp_stub_win")
pub fn stub_win_at(i : Int) -> Int {
  if i < 0 || i >= stub_wins.length() {
    0
  } else {
    stub_wins.unsafe_get(i)
  }
}

///|
/// Returns the byte capacity needed to paint an RGBA metadata strip.
#export_name("dsp_stub_paint_bytes")
pub fn stub_paint_bytes(w : Int) -> Int {
  w * stub_rows * 4
}

///|
/// Returns the byte capacity needed for a luma metadata profile.
#export_name("dsp_stub_luma_bytes")
pub fn stub_luma_bytes(w : Int) -> Int {
  w
}

///|
/// Returns the double capacity needed to decode a luma profile.
#export_name("dsp_stub_decode_words")
pub fn stub_decode_words(n : Int) -> Int {
  3 * n + 8
}

///|
/// Reports whether an image width can hold the metadata strip.
#export_name("dsp_stub_fits")
pub fn stub_fits(w : Int) -> Int {
  if w >= stub_span(w) + 2 && w >= stub_min_decode {
    1
  } else {
    0
  }
}

///|
/// Paints an RGBA metadata strip into an open job arena.
#export_name("dsp_stub_paint")
pub fn stub_paint(h : Int, w : Int, sr : Int, win : Int, exact : Int) -> Int {
  if job_seg(h) < 0 {
    return 0
  }
  let bits = FixedArray::make(stub_bits_cap, 0)
  let n = stub_encode(bits, w, sr, win, exact)
  if n == 0 || w < stub_span(w) + 2 || job_bytes_of(h) < stub_paint_bytes(w) {
    return 0
  }
  let dst = job_b(h)
  let alpha : UInt = 255 << 24
  for x = 0; x < w; x = x + 1 {
    let lum = stub_lum_at(bits, x, w)
    let px = (lum | (lum << 8) | (lum << 16)).reinterpret_as_uint() | alpha
    for y = 0; y < stub_rows; y = y + 1 {
      dst.unsafe_write_uint32_le((y * w + x) * 4, px)
    }
  }
  1
}

///|
/// Writes a luma metadata profile into an open job arena.
#export_name("dsp_stub_luma")
pub fn stub_luma(h : Int, w : Int, sr : Int, win : Int, exact : Int) -> Int {
  if job_seg(h) < 0 {
    return 0
  }
  let bits = FixedArray::make(stub_bits_cap, 0)
  let n = stub_encode(bits, w, sr, win, exact)
  if n == 0 || w < stub_span(w) + 2 || job_bytes_of(h) < stub_luma_bytes(w) {
    return 0
  }
  let dst = job_b(h)
  for x = 0; x < w; x = x + 1 {
    dst.unsafe_set(x, stub_lum_at(bits, x, w).to_byte())
  }
  1
}

///|
fn stub_run(mem : FixedArray[Double], runs : Int, i : Int, field : Int) -> Int {
  mem.unsafe_get(runs + 2 * i + field).to_int()
}

///|
/// Decodes a luma metadata profile in an open job arena.
#export_name("dsp_stub_decode")
pub fn stub_decode(h : Int, n : Int) -> Int {
  if job_seg(h) < 0 {
    return 0
  }
  if n < stub_min_decode || job_words_of(h) < stub_decode_words(n) {
    return 0
  }
  let mem = job_d(h)
  let prof = 0
  let runs = n
  let mut lo = mem.unsafe_get(prof)
  let mut hi = lo
  for i = 1; i < n; i = i + 1 {
    let v = mem.unsafe_get(prof + i)
    lo = lo.min(v)
    hi = hi.max(v)
  }
  if hi - lo < 120.0 {
    return 0
  }
  let th = (lo + hi) / 2.0
  let mut nr = 0
  let mut cur = if mem.unsafe_get(prof) >= th { 1.0 } else { 0.0 }
  let mut len = 0
  for i = 0; i < n; i = i + 1 {
    let v = if mem.unsafe_get(prof + i) >= th { 1.0 } else { 0.0 }
    if v == cur {
      len = len + 1
    } else {
      mem.unsafe_set(runs + 2 * nr, cur)
      mem.unsafe_set(runs + 2 * nr + 1, len.to_double())
      nr = nr + 1
      cur = v
      len = 1
    }
  }
  mem.unsafe_set(runs + 2 * nr, cur)
  mem.unsafe_set(runs + 2 * nr + 1, len.to_double())
  nr = nr + 1
  let bits = FixedArray::make(stub_bits_cap, 0)
  let mut r = 0
  while r + 4 < nr {
    let base = runs + 2 * r
    let c0 = mem.unsafe_get(base).to_int()
    let l0 = mem.unsafe_get(base + 1)
    let c1 = mem.unsafe_get(base + 2).to_int()
    let l1 = mem.unsafe_get(base + 3)
    let c2 = mem.unsafe_get(base + 4).to_int()
    let l2 = mem.unsafe_get(base + 5)
    let c3 = mem.unsafe_get(base + 6).to_int()
    let l3 = mem.unsafe_get(base + 7)
    let unit = (l0 + l1 + l2 + l3) / 4.0
    let ok = c0 == 1 &&
      c1 == 0 &&
      c2 == 1 &&
      c3 == 0 &&
      unit >= 0.3 &&
      (l0 / unit).round() == 1.0 &&
      (l1 / unit).round() == 1.0 &&
      (l2 / unit).round() == 1.0 &&
      (l3 / unit).round() == 1.0
    if ok {
      let mut nb = 0
      let mut total = -1
      let mut wbits = 0
      let mut bad = false
      let mut jj = r + 4
      while jj < nr {
        let v = stub_run(mem, runs, jj, 0)
        let l = stub_run(mem, runs, jj, 1)
        let mut count = (l.to_double() / unit).round().to_int()
        if count < 1 {
          count = 1
        }
        let mut k = 0
        while k < count {
          if nb >= stub_bits_cap {
            bad = true
            break
          }
          bits.unsafe_set(nb, v)
          nb = nb + 1
          if total < 0 && nb >= 6 {
            let magic = (bits.unsafe_get(0) << 3) |
              (bits.unsafe_get(1) << 2) |
              (bits.unsafe_get(2) << 1) |
              bits.unsafe_get(3)
            wbits = stub_width_bits.unsafe_get(
              bits.unsafe_get(4) * 2 + bits.unsafe_get(5),
            )
            if magic != stub_magic || wbits == 0 {
              bad = true
              break
            }
            total = 6 + wbits + 15
          }
          if total > 0 && nb >= total {
            break
          }
          k = k + 1
        }
        if bad || (total > 0 && nb >= total) {
          break
        }
        jj = jj + 1
      }
      if !bad && total >= 0 && nb == total {
        let crc = stub_crc8(bits, 0, 13 + wbits)
        if crc == stub_get(bits, 13 + wbits, 8) {
          let width = stub_get(bits, 6, wbits)
          let si = stub_get(bits, 6 + wbits, 4)
          let wi = stub_get(bits, 10 + wbits, 2)
          if si < stub_sr.length() && width >= 2 {
            let ex = stub_get(bits, 12 + wbits, 1)
            return width | (si << 16) | (wi << 20) | (ex << 22)
          }
        }
      }
    }
    r = r + 1
  }
  0
}
