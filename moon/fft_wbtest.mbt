///|
let probe_wins : FixedArray[Int] = [256, 512, 1024, 2048, 4096]

///|
let ulp_epsilon : Double = 0x1.0p-52

///|
fn peak_ulps(
  arena : FixedArray[Double],
  off : Int,
  golden : FixedArray[Double],
  n : Int,
) -> Double {
  let mut peak = 0.0
  for i = 0; i < n; i = i + 1 {
    let a = golden.unsafe_get(i).abs()
    if a > peak {
      peak = a
    }
  }
  if peak == 0.0 {
    return 0.0
  }
  let mut worst = 0.0
  for i = 0; i < n; i = i + 1 {
    let u = (arena.unsafe_get(off + i) - golden.unsafe_get(i)).abs() /
      peak /
      ulp_epsilon
    if u > worst {
      worst = u
    }
  }
  worst
}

///|
fn noise_array(n : Int, start : Int) -> FixedArray[Double] {
  let out = FixedArray::make(n, 0.0)
  let mut v = start
  for i = 0; i < n; i = i + 1 {
    v = (v * 1664525 + 1013904223) & 0x7FFFFFFF
    out.unsafe_set(i, v.to_double() / 2147483647.0 - 0.5)
  }
  out
}

///|
fn fill_fft(s : Int, win : Int, src : FixedArray[Double]) -> Unit {
  let arena = slot_mem.unsafe_get(s)
  for i = 0; i < win; i = i + 1 {
    arena.unsafe_set(i, src.unsafe_get(i))
    arena.unsafe_set(win + i, 0.0)
  }
}

///|
fn open_fft(win : Int, src : FixedArray[Double]) -> Int {
  let s = slot_open(win)
  fill_fft(s, win, src)
  s
}

///|
fn release_all_slots() -> Unit {
  for i = 0; i < max_slots; i = i + 1 {
    slot_close(i)
  }
}

///|
test "white box: forward then inverse returns the original, imaginary part zero (≤ 8 ulp)" {
  release_all_slots()
  for win in probe_wins {
    let src = noise_array(win, 0x9e3779b9 + win)
    let s = open_fft(win, src)
    forward(s)
    inverse(s)
    let arena = slot_mem.unsafe_get(s)
    assert_true(peak_ulps(arena, 0, src, win) <= 8.0)
    assert_true(peak_ulps(arena, win, FixedArray::make(win, 0.0), win) <= 8.0)
    slot_close(s)
  }
}

///|
test "white box: every step of the window ladder has a table group" {
  release_all_slots()
  let mut win = 256
  while win <= max_win {
    assert_true(plan(win) >= 0)
    let s = slot_open(win)
    assert_true(s >= 0)
    slot_close(s)
    win = win * 2
  }
}

///|
test "white box: all the energy of a DC sequence lands on bin 0" {
  release_all_slots()
  let n = 512
  let s = open_fft(n, FixedArray::make(n, 1.5))
  forward(s)
  let arena = slot_mem.unsafe_get(s)
  let dc = 1.5 * n.to_double()
  assert_true((arena.unsafe_get(0) - dc).abs() <= 8.0 * ulp_epsilon * dc)
  let mut leak = 0.0
  for i = 1; i < n; i = i + 1 {
    let a = arena.unsafe_get(i).abs()
    let b = arena.unsafe_get(n + i).abs()
    if a > leak {
      leak = a
    }
    if b > leak {
      leak = b
    }
  }
  assert_true(leak <= 8.0 * ulp_epsilon * dc)
  slot_close(s)
}

///|
test "white box: Parseval — time-domain sum of squares × n equals frequency-domain magnitude sum" {
  release_all_slots()
  let n = 1024
  let src = noise_array(n, 0x85ebca6b + n)
  let s = open_fft(n, src)
  forward(s)
  let arena = slot_mem.unsafe_get(s)
  let mut time = 0.0
  for i = 0; i < n; i = i + 1 {
    time = time + src.unsafe_get(i) * src.unsafe_get(i)
  }
  let mut freq = 0.0
  for i = 0; i < n; i = i + 1 {
    let r = arena.unsafe_get(i)
    let m = arena.unsafe_get(n + i)
    freq = freq + r * r + m * m
  }
  assert_true(
    (freq - time * n.to_double()).abs() <= 1.0e-9 * time * n.to_double(),
  )
  slot_close(s)
}

///|
test "white box: a full slot pool refuses, and release makes it available again" {
  release_all_slots()
  let slots = FixedArray::make(max_slots, -1)
  for i = 0; i < max_slots; i = i + 1 {
    slots.unsafe_set(i, slot_open(256))
  }
  assert_true(slots.unsafe_get(max_slots - 1) >= 0)
  assert_eq(slot_open(256), -2)
  slot_close(slots.unsafe_get(0))
  assert_true(slot_open(256) >= 0)
  for i = 0; i < max_slots; i = i + 1 {
    slot_close(slots.unsafe_get(i))
  }
}

///|
test "white box: illegal window lengths are rejected, not crashed on" {
  release_all_slots()
  assert_eq(slot_open(100), -1)
  assert_eq(slot_open(8192), -1)
  assert_eq(plan(100), -1)
  assert_eq(plan(8192), -1)
}

///|
test "white box: single-sided spectrum flip matches the term-by-term manual formula bit for bit" {
  release_all_slots()
  let n = 256
  let singles_re : FixedArray[Double] = [2.0, 1.0, 5.0]
  let singles_im : FixedArray[Double] = [7.0, 2.0, -3.0]
  let a = slot_open(n)
  let b = slot_open(n)
  assert_true(a >= 0)
  assert_true(b >= 0)
  let ma = slot_mem.unsafe_get(a)
  let mb = slot_mem.unsafe_get(b)
  for i = 0; i < 3; i = i + 1 {
    ma.unsafe_set(i, singles_re.unsafe_get(i))
    ma.unsafe_set(n + i, singles_im.unsafe_get(i))
    mb.unsafe_set(i, singles_re.unsafe_get(i))
    mb.unsafe_set(n + i, singles_im.unsafe_get(i))
  }
  mb.unsafe_set(n + 0, 0.0)
  mb.unsafe_set(n + 2, 0.0)
  mb.unsafe_set(n - 1, 1.0)
  mb.unsafe_set(2 * n - 1, -2.0)

  assert_eq(real_ifft(a, 3), 1)
  inverse(b)
  let mut diff = 0
  for i = 0; i < 2 * n; i = i + 1 {
    if ma.unsafe_get(i) != mb.unsafe_get(i) {
      diff = diff + 1
    }
  }
  assert_eq(diff, 0)
  slot_close(a)
  slot_close(b)
}

///|
test "white box: forward → real inverse returns the original (≤ 8 ulp)" {
  release_all_slots()
  for win in probe_wins {
    let src = noise_array(win, 0x1b873593 + win)
    let a = open_fft(win, src)
    forward(a)
    let bins = win / 2 + 1
    let b = slot_open(win)
    let ma = slot_mem.unsafe_get(a)
    let mb = slot_mem.unsafe_get(b)
    for i = 0; i < bins; i = i + 1 {
      mb.unsafe_set(i, ma.unsafe_get(i))
      mb.unsafe_set(win + i, ma.unsafe_get(win + i))
    }
    assert_eq(real_ifft(b, bins), 1)
    assert_true(peak_ulps(mb, 0, src, win) <= 8.0)
    slot_close(a)
    slot_close(b)
  }
}

///|
test "white box: legal bins boundaries" {
  release_all_slots()
  let n = 256
  let s = open_fft(n, noise_array(n, 0xcc9e2d51))
  assert_eq(real_ifft(s, 1), 1)
  assert_eq(real_ifft(s, 2), 1)
  assert_eq(real_ifft(s, 0), 0)
  assert_eq(real_ifft(s, n / 2 + 1), 1)
  assert_eq(real_ifft(s, n / 2 + 2), 0)
  assert_eq(real_ifft(-1, 3), 0)
  assert_eq(real_ifft(n, 3), 0)
  slot_close(s)
}
