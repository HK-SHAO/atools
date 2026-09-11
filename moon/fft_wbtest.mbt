// White-box invariants: the checks that catch "the algorithm is wrong" without a second
// implementation. A "kernel ≡ TS `FFT` class" ulp gate once pointed at a host-side implementation
// that was deleted with `app/lib/fft.ts`; these are therefore stricter — self-consistency (forward
// → real inverse back to the original), spectral conjugate symmetry, and the degenerate-`bins`
// behaviour, all cross-checked within the kernel alone.

///|
/// Probe window lengths, the full coverage of the kernel's table group.
let probe_wins : FixedArray[Int] = [256, 512, 1024, 2048, 4096]

///|
let ulp_epsilon : Double = 2.220446049250313e-16

///|
fn abs_f(x : Double) -> Double {
  if x < 0.0 {
    -x
  } else {
    x
  }
}

///|
/// Max ulp distance scaled by the reference peak. FFT backward error is only meaningful relative
/// to the peak.
fn peak_ulps(
  arena : FixedArray[Double],
  off : Int,
  golden : FixedArray[Double],
  n : Int,
) -> Double {
  let mut peak = 0.0
  for i = 0; i < n; i = i + 1 {
    let a = abs_f(golden.unsafe_get(i))
    if a > peak {
      peak = a
    }
  }
  if peak == 0.0 {
    return 0.0
  }
  let mut worst = 0.0
  for i = 0; i < n; i = i + 1 {
    let u = abs_f(arena.unsafe_get(off + i) - golden.unsafe_get(i)) /
      peak /
      ulp_epsilon
    if u > worst {
      worst = u
    }
  }
  worst
}

///|
/// Deterministic pseudo-random sequence.
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
/// Load `src` into the slot's real part with the imaginary part zeroed (single complex transform
/// layout).
fn fill_fft(s : Int, win : Int, src : FixedArray[Double]) -> Unit {
  let arena = slot_mem.unsafe_get(s)
  for i = 0; i < win; i = i + 1 {
    arena.unsafe_set(i, src.unsafe_get(i))
    arena.unsafe_set(win + i, 0.0)
  }
}

///|
/// Open a slot and load the input. Caller is responsible for `slot_close`.
fn open_fft(win : Int, src : FixedArray[Double]) -> Int {
  let s = slot_open(win)
  fill_fft(s, win, src)
  s
}

///|
/// Return every slot in the pool (`slot_close` is idempotent).
///
/// **To keep cases independent**: if an assertion in a white-box case fails, the following
/// `slot_close` never runs and the leaked slot reddens every later case that opens one — one
/// change once reported five failures, four of them from this, forcing a hunt down four false
/// leads for a single root cause. Hence the reset at the top of each case; borrow/return balance
/// has its own dedicated case (the slot-pool section).
fn release_all_slots() -> Unit {
  for i = 0; i < max_slots; i = i + 1 {
    slot_close(i)
  }
}

///|
test "white box: forward then inverse returns the original, imaginary part zero (≤ 8 ulp)" {
  // Each case clears the pool first: a failed assertion skips the following `slot_close`, and the
  // leaked slot reddens **unrelated later cases** (four of five once-red cases came from this).
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
/// The table group must cover **every** power of two in `min_win … max_win`, not the list that
/// happened to exist at the time. An independently written threshold: miss one step and some
/// legal window length reads past the table group.
test "white box: every step of the window ladder has a table group" {
  // Each case clears the pool first: a failed assertion skips the following `slot_close`, and the
  // leaked slot reddens **unrelated later cases** (four of five once-red cases came from this).
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
  // Each case clears the pool first: a failed assertion skips the following `slot_close`, and the
  // leaked slot reddens **unrelated later cases** (four of five once-red cases came from this).
  release_all_slots()
  let n = 512
  let s = open_fft(n, FixedArray::make(n, 1.5))
  forward(s)
  let arena = slot_mem.unsafe_get(s)
  let dc = 1.5 * n.to_double()
  assert_true(abs_f(arena.unsafe_get(0) - dc) <= 8.0 * ulp_epsilon * dc)
  let mut leak = 0.0
  for i = 1; i < n; i = i + 1 {
    let a = abs_f(arena.unsafe_get(i))
    let b = abs_f(arena.unsafe_get(n + i))
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
  // Each case clears the pool first: a failed assertion skips the following `slot_close`, and the
  // leaked slot reddens **unrelated later cases** (four of five once-red cases came from this).
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
    abs_f(freq - time * n.to_double()) <= 1.0e-9 * time * n.to_double(),
  )
  slot_close(s)
}

///|
test "white box: a full slot pool refuses, and release makes it available again" {
  // Each case clears the pool first: a failed assertion skips the following `slot_close`, and the
  // leaked slot reddens **unrelated later cases** (four of five once-red cases came from this).
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
  // Each case clears the pool first: a failed assertion skips the following `slot_close`, and the
  // leaked slot reddens **unrelated later cases** (four of five once-red cases came from this).
  release_all_slots()
  assert_eq(slot_open(100), -1)
  assert_eq(slot_open(8192), -1)
  assert_eq(plan(100), -1)
  assert_eq(plan(8192), -1)
}

///|
/// The **term-by-term** flip convention: `X[N-k] = conj(X[k])`, with DC and Nyquist imaginary
/// parts forced to zero.
///
/// The gate cannot compare the post-flip intermediate state — `real_ifft` does the inverse in the
/// same pass, so the spectrum is already time-domain. Instead compare it **bit for bit** against
/// "manual flip + `inverse`": the kernel's chain must match this manual formula exactly. If the
/// formula is wrong the whole reconstruction chain outputs noise, and no second implementation
/// remains to catch it.
test "white box: single-sided spectrum flip matches the term-by-term manual formula bit for bit" {
  // Each case clears the pool first: a failed assertion skips the following `slot_close`, and the
  // leaked slot reddens **unrelated later cases** (four of five once-red cases came from this).
  release_all_slots()
  // Minimum window is 256 (`min_win` in `plan.mbt`) and only the first 3 rows of the single-sided
  // spectrum are filled — the manual computation is about index relations, independent of window
  // length: row `b` flips to row `n-b`.
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
  // Manual flip: DC (row 0) and Nyquist (row 2, i.e. n/2) are real lines, imaginary part zeroed;
  // row 1 conjugates to row n-1: real copied, imaginary negated.
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
/// Self-consistency (no reference needed): real signal → forward → single-sided spectrum →
/// `real_ifft` → back to the original. This also catches both "forgot to flip" and "flipped
/// wrong": flip only half and the upper spectrum carries stale values, so the inverse samples
/// immediately mismatch.
test "white box: forward → real inverse returns the original (≤ 8 ulp)" {
  // Each case clears the pool first: a failed assertion skips the following `slot_close`, and the
  // leaked slot reddens **unrelated later cases** (four of five once-red cases came from this).
  release_all_slots()
  for win in probe_wins {
    let src = noise_array(win, 0x1b873593 + win)
    let a = open_fft(win, src)
    forward(a)
    // Copy the single-sided spectrum into a second slot and take the real inverse.
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
/// Degenerate `bins`: 1 and 2 rows are legal (DC only, or DC + Nyquist); 0 rows and anything above
/// `n/2+1` are **rejected** without touching anything — acting would turn half the spectrum into
/// noise.
test "white box: legal bins boundaries" {
  // Each case clears the pool first: a failed assertion skips the following `slot_close`, and the
  // leaked slot reddens **unrelated later cases** (four of five once-red cases came from this).
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
