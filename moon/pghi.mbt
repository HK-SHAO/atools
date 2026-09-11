// PGHI phase initialization: turn a magnitude spectrum into a phase guess with the right local
// phase gradients, by propagating outwards from the loudest bins.
//
// Bins are visited in descending magnitude order (a counting sort over 256 magnitude buckets).
// Each visited bin takes its phase from the loudest already-decided neighbour, offset by the
// half-sum of the two gradient estimates. Anything left unvisited gets a fixed xorshift32 phase,
// so the spectrum is not coherent by accident.
//
// The gradients come from the phase-derivative identities: `fgrad` from the log-magnitude
// difference across frames, `tgrad` from the difference across bins plus the hop-induced linear
// term. All the numerics live here; the tuning constants arrive as arguments, so the host stays
// the single place where they are chosen.

///|
/// Magnitude-ordering buckets. 256 is enough resolution for a stable descent order and costs one
/// byte per bin.
let pghi_buckets : Int = 256

///|
/// One PGHI job: the double buffer holds `mag` (written by the host) then `phase` (written by
/// `dsp_pghi_run`). No byte segment is needed.
priv struct Pghi {
  frames : Int
  bins : Int
  win : Int
  hop : Int
  gamma : Double
  tol_hi : Double
  tol_lo : Double
  arena : FixedArray[Double]
  off_mag : Int
  off_phase : Int
}

///|
let pghi_jobs : FixedArray[Pghi?] = FixedArray::make(max_jobs, None)

///|
/// Job record for handle `h`, or `None`.
fn pghi_at(h : Int) -> Pghi? {
  let j = job_seg(h)
  if j < 0 {
    None
  } else {
    pghi_jobs.unsafe_get(j)
  }
}

///|
/// Per-run working set. `slog` is the log magnitude, floored so a silent bin cannot produce −∞;
/// `fgrad`/`tgrad` are the frame and bin phase gradients in Float32, as the reference stores them.
priv struct Pg {
  frames : Int
  bins : Int
  n : Int
  win : Double
  hop : Double
  top : Double
  tol_hi : Double
  tol_lo : Double
  c_f : Double
  c_t : Double
  off_mag : Int
  off_phase : Int
  arena : FixedArray[Double]
  fgrad : FixedArray[Float]
  tgrad : FixedArray[Float]
  done : FixedArray[Bool]
  queued : FixedArray[Bool]
  order : FixedArray[Int]
  h_idx : FixedArray[Int]
  h_key : FixedArray[Double]
  mut h_size : Int
}

///|
/// Opens a PGHI job.
///
/// @param gamma Dimensionless gradient coupling; the kernel scales it by `win²`.
/// @param tol_hi Fraction of the peak accepted by the first propagation pass.
/// @param tol_lo Threshold of the second pass; bins still unvisited afterwards get a random phase.
/// @return Job handle (>= 1); 0 if a parameter is illegal or the job pool is exhausted.
#export_name("dsp_pghi_open")
pub fn pghi_open(
  frames : Int,
  bins : Int,
  win : Int,
  hop : Int,
  gamma : Double,
  tol_hi : Double,
  tol_lo : Double,
) -> Int {
  if frames < 1 || bins < 2 || win < 2 || hop < 1 {
    return 0
  }
  let fb = frames * bins
  let h = job_open(2 * fb, 0)
  if h == 0 {
    return 0
  }
  let job : Pghi = {
    frames,
    bins,
    win,
    hop,
    gamma,
    tol_hi,
    tol_lo,
    arena: job_d(h),
    off_mag: 0,
    off_phase: fb,
  }
  pghi_jobs.unsafe_set(h - 1, Some(job))
  h
}

///|
/// Element offset of a region of the job's double buffer.
///
/// @param h Job handle.
/// @param which 0 = magnitude input (`frames × bins`), 1 = phase output (same size).
/// @return Offset to add to the base of `dsp_job_d(h)`; -1 if `h` or `which` is invalid.
#export_name("dsp_pghi_off")
pub fn pghi_off(h : Int, which : Int) -> Int {
  match pghi_at(h) {
    None => -1
    Some(job) =>
      if which == 0 {
        job.off_mag
      } else if which == 1 {
        job.off_phase
      } else {
        -1
      }
  }
}

///|
/// Closes a PGHI job.
///
/// @param h Job handle; invalid or already-closed handles are ignored.
#export_name("dsp_pghi_close")
pub fn pghi_close(h : Int) -> Unit {
  let j = job_seg(h)
  if j < 0 {
    return
  }
  pghi_jobs.unsafe_set(j, None)
  job_close(h)
}

///|
/// Wraps a phase into (−π, π], the one line the reference wrote as `((a + PI) % TWO_PI) - PI`.
///
/// The modulo has to be the exact remainder, not "divide, round, multiply back": that costs a
/// rounding in the quotient and another in the product, ~1 ulp of `2π·k` per call, and the
/// propagation chain accumulates it — measured at up to 3e-12 rad over a 60-frame spectrum. The
/// kernel's `%` is exact (moonbitlang/core ports `fmod` for non-JS targets), so writing the
/// reference expression verbatim is both shorter and the only version that agrees bit for bit.
fn pghi_wrap(a : Double) -> Double {
  let two_pi = 2.0 * pi
  let mut v = (a + pi) % two_pi
  if v < 0.0 {
    v = v + two_pi
  }
  v - pi
}

///|
/// Inserts `value` with priority `key` into the max-heap.
fn pg_push(pg : Pg, value : Int, key : Double) -> Unit {
  let c0 = pg.h_size
  pg.h_size = c0 + 1
  let mut c = c0
  while c > 0 {
    let p = (c - 1) >> 1
    if pg.h_key.unsafe_get(p) >= key {
      break
    }
    pg.h_idx.unsafe_set(c, pg.h_idx.unsafe_get(p))
    pg.h_key.unsafe_set(c, pg.h_key.unsafe_get(p))
    c = p
  }
  pg.h_idx.unsafe_set(c, value)
  pg.h_key.unsafe_set(c, key)
}

///|
/// Removes and returns the highest-priority bin. Only valid when the heap is non-empty.
fn pg_pop(pg : Pg) -> Int {
  let top = pg.h_idx.unsafe_get(0)
  let last = pg.h_size - 1
  pg.h_size = last
  if last > 0 {
    let value = pg.h_idx.unsafe_get(last)
    let key = pg.h_key.unsafe_get(last)
    let mut c = 0
    while true {
      let ch = 2 * c + 1
      if ch >= last {
        break
      }
      let mut best = ch
      if ch + 1 < last && pg.h_key.unsafe_get(ch + 1) > pg.h_key.unsafe_get(ch) {
        best = ch + 1
      }
      if pg.h_key.unsafe_get(best) <= key {
        break
      }
      pg.h_idx.unsafe_set(c, pg.h_idx.unsafe_get(best))
      pg.h_key.unsafe_set(c, pg.h_key.unsafe_get(best))
      c = best
    }
    pg.h_idx.unsafe_set(c, value)
    pg.h_key.unsafe_set(c, key)
  }
  top
}

///|
/// Magnitude of bin `j` of the job's input region. A candidate's magnitude is compared and then
/// used, so it is read through one function: two inline reads of the same element can drift apart
/// the moment one of them is edited, and the comparison is what decides the visit order.
fn pg_mag(pg : Pg, j : Int) -> Double {
  pg.arena.unsafe_get(pg.off_mag + j)
}

///|
/// Queues a neighbour if it is loud enough and not already handled.
fn pg_offer(pg : Pg, j : Int, limit : Double) -> Unit {
  if pg.done.unsafe_get(j) || pg.queued.unsafe_get(j) {
    return
  }
  let m = pg_mag(pg, j)
  if m <= limit {
    return
  }
  pg.queued.unsafe_set(j, true)
  pg_push(pg, j, m)
}

///|
/// Drains the heap, assigning a phase to every popped bin and offering its four neighbours.
///
/// The loudest already-decided neighbour wins; ties keep the earlier candidate, so the order of
/// the four blocks below is part of the result.
fn pg_drain(pg : Pg, limit : Double) -> Unit {
  let bins = pg.bins
  let frames = pg.frames
  while pg.h_size > 0 {
    let i = pg_pop(pg)
    if pg.done.unsafe_get(i) {
      continue
    }
    let f = i / bins
    let b = i - f * bins
    let mut best = -1
    let mut best_mag = -1.0
    if b > 0 && pg.done.unsafe_get(i - 1) {
      let m = pg_mag(pg, i - 1)
      if m > best_mag {
        best = i - 1
        best_mag = m
      }
    }
    if b < bins - 1 && pg.done.unsafe_get(i + 1) {
      let m = pg_mag(pg, i + 1)
      if m > best_mag {
        best = i + 1
        best_mag = m
      }
    }
    if f > 0 && pg.done.unsafe_get(i - bins) {
      let m = pg_mag(pg, i - bins)
      if m > best_mag {
        best = i - bins
        best_mag = m
      }
    }
    if f < frames - 1 && pg.done.unsafe_get(i + bins) {
      let m = pg_mag(pg, i + bins)
      if m > best_mag {
        best = i + bins
        best_mag = m
      }
    }
    // `best < 0` means no neighbour has been decided yet, so the bin is isolated at this
    // threshold and keeps a zero phase.
    let value = if best < 0 {
      0.0
    } else if best == i - 1 {
      pghi_wrap(
        pg.arena.unsafe_get(pg.off_phase + best) +
        0.5 *
        (
          pg.fgrad.unsafe_get(best).to_double() +
          pg.fgrad.unsafe_get(i).to_double()
        ),
      )
    } else if best == i + 1 {
      pghi_wrap(
        pg.arena.unsafe_get(pg.off_phase + best) -
        0.5 *
        (
          pg.fgrad.unsafe_get(best).to_double() +
          pg.fgrad.unsafe_get(i).to_double()
        ),
      )
    } else if best == i - bins {
      pghi_wrap(
        pg.arena.unsafe_get(pg.off_phase + best) +
        0.5 *
        (
          pg.tgrad.unsafe_get(best).to_double() +
          pg.tgrad.unsafe_get(i).to_double()
        ),
      )
    } else {
      pghi_wrap(
        pg.arena.unsafe_get(pg.off_phase + best) -
        0.5 *
        (
          pg.tgrad.unsafe_get(best).to_double() +
          pg.tgrad.unsafe_get(i).to_double()
        ),
      )
    }
    pg.arena.unsafe_set(pg.off_phase + i, value)
    pg.done.unsafe_set(i, true)
    if b > 0 {
      pg_offer(pg, i - 1, limit)
    }
    if b < bins - 1 {
      pg_offer(pg, i + 1, limit)
    }
    if f > 0 {
      pg_offer(pg, i - bins, limit)
    }
    if f < frames - 1 {
      pg_offer(pg, i + bins, limit)
    }
  }
}

///|
/// Computes the gradient fields and the descending-magnitude visit order.
fn pg_setup(pg : Pg) -> Unit {
  let n = pg.n
  let bins = pg.bins
  let frames = pg.frames
  let two_pi = 2.0 * pi
  // The floor keeps a silent bin from producing −∞, which would poison every neighbour's
  // gradient.
  let floor = pg.top * 1.0e-12
  let slog = FixedArray::make(n, 0.0)
  for i = 0; i < n; i = i + 1 {
    let v = pg.arena.unsafe_get(pg.off_mag + i)
    slog.unsafe_set(i, @math.ln(if v < floor { floor } else { v }))
  }
  for f = 0; f < frames; f = f + 1 {
    let base = f * bins
    let up = (if f > 0 { f - 1 } else { 0 }) * bins
    let dn = (if f < frames - 1 { f + 1 } else { frames - 1 }) * bins
    let dt = if f > 0 && f < frames - 1 { 2.0 } else { 1.0 }
    for b = 0; b < bins; b = b + 1 {
      let g = -pg.c_f * (slog.unsafe_get(dn + b) - slog.unsafe_get(up + b)) / dt -
        pi
      pg.fgrad.unsafe_set(base + b, Float::from_double(g))
    }
  }
  for f = 0; f < frames; f = f + 1 {
    let base = f * bins
    for b = 0; b < bins; b = b + 1 {
      let lo = if b > 0 { b - 1 } else { 0 }
      let hi = if b < bins - 1 { b + 1 } else { bins - 1 }
      let db = if b > 0 && b < bins - 1 { 2.0 } else { 1.0 }
      let g = pg.c_t *
        (slog.unsafe_get(base + hi) - slog.unsafe_get(base + lo)) /
        db +
        two_pi * pg.hop * b.to_double() / pg.win
      pg.tgrad.unsafe_set(base + b, Float::from_double(g))
    }
  }
  // Counting sort by magnitude bucket, descending. Buckets are ordered from the largest key
  // downwards, and ties keep their original index order.
  let counts = FixedArray::make(pghi_buckets, 0)
  let keys = FixedArray::make(n, b'\x00')
  for i = 0; i < n; i = i + 1 {
    let raw = (pg.arena.unsafe_get(pg.off_mag + i) /
    pg.top *
    pghi_buckets.to_double()).to_int()
    let k = if raw > pghi_buckets - 1 { pghi_buckets - 1 } else { raw }
    keys.unsafe_set(i, k.to_byte())
    counts.unsafe_set(k, counts.unsafe_get(k) + 1)
  }
  let start = FixedArray::make(pghi_buckets + 1, 0)
  let mut b = pghi_buckets - 1
  while b >= 0 {
    start.unsafe_set(b, start.unsafe_get(b + 1) + counts.unsafe_get(b))
    b = b - 1
  }
  let at = FixedArray::make(pghi_buckets, 0)
  for b = 0; b < pghi_buckets; b = b + 1 {
    at.unsafe_set(b, start.unsafe_get(b + 1))
  }
  for i = 0; i < n; i = i + 1 {
    let k = keys.unsafe_get(i).to_int()
    let p = at.unsafe_get(k)
    pg.order.unsafe_set(p, i)
    at.unsafe_set(k, p + 1)
  }
}

///|
/// Runs both propagation passes, from the highest acceptance threshold down.
fn pg_propagate(pg : Pg) -> Unit {
  for limit in [pg.top * pg.tol_hi, pg.top * pg.tol_lo] {
    for k = 0; k < pg.n; k = k + 1 {
      let i = pg.order.unsafe_get(k)
      if pg.done.unsafe_get(i) {
        continue
      }
      let m = pg_mag(pg, i)
      if m <= limit {
        continue
      }
      pg.queued.unsafe_set(i, true)
      pg_push(pg, i, m)
      pg_drain(pg, limit)
    }
  }
}

///|
/// Runs PGHI and writes the phase into the job's output region.
///
/// @param h Job handle.
/// @return 1 if it ran; 0 if `h` is invalid. A spectrum with no energy, or degenerate dimensions,
/// leaves the phase at zero and still reports success, so the host has a single failure mode.
#export_name("dsp_pghi_run")
pub fn pghi_run(h : Int) -> Int {
  match pghi_at(h) {
    None => 0
    Some(job) => {
      let n = job.frames * job.bins
      let phase = job.off_phase
      // Only the output region is cleared; `mag` holds the host's input.
      for i = 0; i < n; i = i + 1 {
        job.arena.unsafe_set(phase + i, 0.0)
      }
      let mut top = 0.0
      for i = 0; i < n; i = i + 1 {
        if job.arena.unsafe_get(job.off_mag + i) > top {
          top = job.arena.unsafe_get(job.off_mag + i)
        }
      }
      if top <= 0.0 || job.frames < 2 || job.bins < 2 {
        return 1
      }
      let zero_f : Float = 0.0
      let pg : Pg = {
        frames: job.frames,
        bins: job.bins,
        n,
        win: job.win.to_double(),
        hop: job.hop.to_double(),
        top,
        tol_hi: job.tol_hi,
        tol_lo: job.tol_lo,
        // `win²` is an exact integer, so scaling before the multiply keeps the coupling identical
        // to computing it in double precision directly.
        c_f: job.gamma *
        (job.win * job.win).to_double() /
        (job.hop * job.win).to_double(),
        c_t: (job.hop * job.win).to_double() /
        (job.gamma * (job.win * job.win).to_double()),
        off_mag: job.off_mag,
        off_phase: phase,
        arena: job.arena,
        fgrad: FixedArray::make(n, zero_f),
        tgrad: FixedArray::make(n, zero_f),
        done: FixedArray::make(n, false),
        queued: FixedArray::make(n, false),
        order: FixedArray::make(n, 0),
        // The heap can never hold more than one entry per bin, so one allocation of `n` covers the
        // worst case and the push path never grows anything.
        h_idx: FixedArray::make(n, 0),
        h_key: FixedArray::make(n, 0.0),
        h_size: 0,
      }
      pg_setup(pg)
      pg_propagate(pg)
      let two_pi = 2.0 * pi
      let mut seed : UInt = 0x9e3779b9
      for i = 0; i < n; i = i + 1 {
        if pg.done.unsafe_get(i) {
          continue
        }
        seed = seed ^ (seed << 13)
        seed = seed ^ (seed >> 17)
        seed = seed ^ (seed << 5)
        job.arena.unsafe_set(
          phase + i,
          seed.to_double() / 4294967295.0 * two_pi - pi,
        )
      }
      1
    }
  }
}
