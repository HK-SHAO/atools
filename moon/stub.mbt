// The stub: eight rows of barcode at the bottom of a spectrogram, carrying width, sample rate,
// window length and the reversible flag.
//
// This is the cleanest module in the kernel — pure integer work (bit stream, CRC8, run lengths,
// threshold comparisons), so there is no numeric equivalence to argue about: either it is
// byte-identical or it is wrong. It is also the template for "the host only moves data":
// the kernel paints `w × rows` RGBA straight into the job's byte segment and the host does one
// `set` into the ImageData.
//
// Three rules shared by every array-in/array-out module:
//   1. The host owns the job (opened at the size the kernel reports) and passes the handle in;
//      the kernel reads and writes it by plain index. Byte data goes in the byte segment.
//   2. Illegal parameters and insufficient capacity both return 0 / empty — the host degrades,
//      it does not crash.
//   3. Nothing is cached between calls: closing a handle forgets everything.
//
// The size table (`*_bytes` / `*_words`) is part of the export surface: the host never lays out
// a job itself. Behaviour is pinned by stub_wbtest.mbt.

///|
/// Pixel rows a stub occupies. Part of the format: painting and reading must agree on it, so the
/// host asks for it (`dsp_stub_rows`) rather than repeating the number.
let stub_rows : Int = 8

///|
/// Sync pattern written first: four runs of one unit, which is what the decoder's sliding-window
/// locator looks for. It is not part of the CRC coverage.
let stub_sync : Int = 0b1010

///|
/// Magic nibble checked by the decoder right after the sync pattern.
let stub_magic : Int = 0b1011

///|
let stub_dark : Int = 20

///|
let stub_light : Int = 230

///|
let stub_crc_poly : Int = 0x07

///|
/// Bit-stream capacity, used for both the encoder's scratch and the decoder's collection buffer.
/// The longest possible stream is 41 bits.
let stub_bits_cap : Int = 64

///|
/// Shortest luminance profile that can still be recognized, in pixels. It comes from the decode
/// side and is deliberately independent of `stub_span`: below this, neither the locator nor the
/// bit stream fits.
///
/// `stub_fits` shares this definition on purpose. Written separately the two drift, and a width
/// band appears where `stub_fits` says "it fits" while decoding can never succeed.
let stub_min_decode : Int = 46

///|
/// Sample-rate ladder. The bit stream stores an index, so the order is part of the format.
let stub_sr : FixedArray[Int] = [
  8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000,
  176400, 192000,
]

///|
/// Window-length ladder (2-bit index).
let stub_wins : FixedArray[Int] = [256, 512, 1024, 2048]

///|
/// Width field sizes (2-bit index → 8 / 12 / 16 bits; the trailing 0 marks an invalid index).
let stub_width_bits : FixedArray[Int] = [8, 12, 16, 0]

///|
/// First index whose entry equals `v`; -1 when absent.
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
/// Width field index (0 / 1 / 2) for a stub width; it is the index into `stub_width_bits`.
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
/// Pixels per bit: 4 for a wide image, 2 for a medium one, 1 for a narrow one.
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
/// Bit-stream length: 4 sync + 4 magic + 2 width index + width + 4 sample rate + 2 window +
/// 1 exact + 8 CRC.
fn stub_total_bits(w : Int) -> Int {
  25 + stub_width_bits.unsafe_get(stub_width_index(w))
}

///|
/// Span of a stub: the 2-pixel locator plus the spread-out bit stream.
fn stub_span(w : Int) -> Int {
  2 + stub_total_bits(w) * stub_bit_px(w)
}

///|
/// CRC8 (polynomial 0x07), computed bit by bit over `[from, from+len)`.
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
/// Pushes `n` bits big-endian and returns the new write cursor.
fn stub_push(bits : FixedArray[Int], at : Int, v : Int, n : Int) -> Int {
  for i = 0; i < n; i = i + 1 {
    bits.unsafe_set(at + i, (v >> (n - 1 - i)) & 1)
  }
  at + n
}

///|
/// Reads `n` bits big-endian.
fn stub_get(bits : FixedArray[Int], at : Int, n : Int) -> Int {
  let mut v = 0
  for i = 0; i < n; i = i + 1 {
    v = (v << 1) | bits.unsafe_get(at + i)
  }
  v
}

///|
/// Encodes the parameters into `bits` and returns the bit count; 0 when they do not fit.
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
  // The CRC covers everything after the 4-bit sync pattern.
  at = stub_push(bits, at, stub_crc8(bits, 4, at - 4), 8)
  at
}

///|
/// Luminance of column `x`.
///
/// The two windows (starting at 2 and at `w − span`) coexist only on wide images, and then they
/// cannot overlap because `w ≥ 2·span + 6`, so a per-column computation equals "paint a row,
/// then overwrite part of it".
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
/// Number of pixel rows a stub occupies.
///
/// @return The row count (8).
#export_name("dsp_stub_rows")
pub fn stub_rows_of() -> Int {
  stub_rows
}

///|
/// Entry `i` of the sample-rate ladder, which is part of the format and must not be reordered.
///
/// @return The sample rate at `i`; 0 if `i` is out of range.
#export_name("dsp_stub_sr")
pub fn stub_sr_at(i : Int) -> Int {
  if i < 0 || i >= stub_sr.length() {
    0
  } else {
    stub_sr.unsafe_get(i)
  }
}

///|
/// Entry `i` of the window-length ladder, which is part of the format.
///
/// @return The window length at `i`; 0 if `i` is out of range.
#export_name("dsp_stub_win")
pub fn stub_win_at(i : Int) -> Int {
  if i < 0 || i >= stub_wins.length() {
    0
  } else {
    stub_wins.unsafe_get(i)
  }
}

///|
/// Byte-segment size needed to paint a stub of width `w`.
///
/// @return Required bytes (w x rows x 4).
#export_name("dsp_stub_paint_bytes")
pub fn stub_paint_bytes(w : Int) -> Int {
  w * stub_rows * 4
}

///|
/// Byte-segment size needed for one luminance row of width `w`.
///
/// @return Required bytes (w).
#export_name("dsp_stub_luma_bytes")
pub fn stub_luma_bytes(w : Int) -> Int {
  w
}

///|
/// Double-segment size needed to decode a stub: the profile, its run table, and some slack.
///
/// @return Required elements (3n + 8).
#export_name("dsp_stub_decode_words")
pub fn stub_decode_words(n : Int) -> Int {
  3 * n + 8
}

///|
/// Whether width `w` fits a stub that can also be decoded back.
///
/// Both conditions are exact lines, not conservative ones: the bit stream has to spread out
/// (`span + 2`, the same line `dsp_stub_paint` uses) and the profile has to be long enough for
/// the decoder (`stub_min_decode`). Slack would make the test stricter than reality and reject
/// widths that do read back.
///
/// @return 1 if both hold; 0 otherwise.
#export_name("dsp_stub_fits")
pub fn stub_fits(w : Int) -> Int {
  if w >= stub_span(w) + 2 && w >= stub_min_decode {
    1
  } else {
    0
  }
}

///|
/// Paints the `w × rows` RGBA stub directly into the job's byte segment, segment-relative.
///
/// @param h Job handle.
/// @param sr Sample rate; must be in the format ladder.
/// @param win Window length; must be in the format ladder.
/// @param exact Non-zero encodes the reversible flag.
/// @return 1 on success; 0 if `h` is invalid, a parameter does not fit, or the segment is too
/// small.
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
  // Column by column: one luminance computation painted down eight rows. Row by row would redo
  // the bit-stream interpretation eight times (measurably 3× slower than the JS version, which
  // also computed a row first). RGBA pixels are written 4 bytes at a time.
  let alpha : UInt = 255 << 24
  for x = 0; x < w; x = x + 1 {
    let lum = stub_lum_at(bits, x, w)
    // R = G = B = luminance, A = 255; little-endian that is [lum, lum, lum, 255].
    let px = (lum | (lum << 8) | (lum << 16)).reinterpret_as_uint() | alpha
    for y = 0; y < stub_rows; y = y + 1 {
      dst.unsafe_write_uint32_le((y * w + x) * 4, px)
    }
  }
  1
}

///|
/// Writes a single luminance row (`w` bytes, segment-relative) into the job's byte segment. The
/// reversible mode wants a band, not a block of pixels.
///
/// @param h Job handle.
/// @param sr Sample rate; must be in the format ladder.
/// @param win Window length; must be in the format ladder.
/// @param exact Non-zero encodes the reversible flag.
/// @return 1 on success; 0 if `h` is invalid, a parameter does not fit, or the segment is too
/// small.
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
/// One cell of the run table, which stores `[cur, len]` pairs in the double buffer.
/// `field` 0 reads `cur`, 1 reads `len`.
fn stub_run(mem : FixedArray[Double], runs : Int, i : Int, field : Int) -> Int {
  mem.unsafe_get(runs + 2 * i + field).to_int()
}

///|
/// Decodes a stub from a 1-D luminance profile: the profile is the first `n` doubles of the
/// segment, the run table the trailing `2n`.
///
/// @param h Job handle.
/// @param n Profile length in elements, segment-relative; at least `stub_min_decode`.
/// @return 0 if unrecognized; otherwise a packed i32 `width | si << 16 | wi << 20 | exact << 22`.
/// `width >= 2` guarantees a real result is never 0, so 0 is a safe failure value and no output
/// buffer is needed.
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
  // 1. Threshold at the midpoint of the span. Too small a span means this is not a stub
  //    (a photo or a sketch stops here).
  let mut lo = mem.unsafe_get(prof)
  let mut hi = lo
  for i = 1; i < n; i = i + 1 {
    let v = mem.unsafe_get(prof + i)
    if v < lo {
      lo = v
    }
    if v > hi {
      hi = v
    }
  }
  if hi - lo < 120.0 {
    return 0
  }
  let th = (lo + hi) / 2.0
  // 2. Collapse to runs over the whole profile before sliding: the first and last runs must be
  //    written exactly as the reference writes them, or one profile collapses differently.
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
  // 3. Slide a four-run window looking for the locator, then collect bits from what follows.
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
    // Four alternating runs, each exactly one unit wide.
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
            // magic 4 + width index 2 + width + sample rate 4 + window 2 + exact 1 + CRC 8.
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
