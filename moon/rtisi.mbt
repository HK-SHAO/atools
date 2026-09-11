// RTISI-LA phase reconstruction.
//
// The host opens a job, writes magnitudes (plus an optional phase warm start and band tables),
// drives it in chunks so it can report progress and honour cancellation, then reads the waveform
// back. Chunk boundaries are free because every piece of state lives in the job arena. The
// derivation and the ablation switches live in docs/algorithms.md.

///|
/// Fallback iteration budget, used only when a caller passes a non-positive one (white-box tests
/// do). The host normally passes an explicit budget mirroring the tuned value: it decides K, and
/// a different K is a different result, not a rounding of a performance knob.
let rtisi_budget : Double = 5.0e7

///|
/// Exact base-2 logarithm. `win` is always a power of two, and the budget test must agree with
/// the reference bit for bit — `@math.log(v) / @math.log(2.0)` can land on 11.999999 for 4096.
fn log2_exact(n : Int) -> Double {
  let mut v = 1
  let mut e = 0
  while v < n {
    v = v * 2
    e = e + 1
  }
  e.to_double()
}

///|
/// One RTISI job: sizes, region offsets into its own buffers, and the arrays it holds.
///
/// Offsets are relative to their own segment — the double main buffer, or the byte segment for
/// `levels`, which therefore always starts at 0. There is no base address to fold in; see
/// arena.mbt for why that removes a whole class of bug.
priv struct RtJob {
  frames : Int
  bins : Int
  size : Int
  hop : Int
  samples : Int
  k : Int
  iters : Int
  padded : Int
  span : Int
  full : Int
  plan_id : Int
  slot_id : Int
  has_warm : Bool
  has_band : Bool
  /// The job's own main buffer.
  arena : FixedArray[Double]
  /// The bound session slot's workspace (`dsp_slot_mem`).
  slot : FixedArray[Double]
  /// The Hann window of `plan_id`, read-only.
  hann : FixedArray[Double]
  /// The job's own byte segment; `levels` occupies all of it.
  levels : FixedArray[Byte]
  off_mag : Int
  off_warm : Int
  off_y : Int
  off_out : Int
  off_local : Int
  off_work : Int
  off_workim : Int
  off_cos : Int
  off_sin : Int
  off_amp : Int
  off_pcos : Int
  off_psin : Int
  off_pamp : Int
  off_band : Int
  off_cover : Int
}

///|
let rt_jobs : FixedArray[RtJob?] = FixedArray::make(max_jobs, None)

///|
/// Job record for handle `h`, or `None`.
fn rt_at(h : Int) -> RtJob? {
  let j = job_seg(h)
  if j < 0 {
    None
  } else {
    rt_jobs.unsafe_get(j)
  }
}

///|
/// Opens an RTISI phase-reconstruction job and lays out its regions.
///
/// @param hop Hop in samples; below 1 clamps to 1.
/// @param iters Iterations requested; below 1 clamps to 1, and both `iters` and the overlap order
/// may be reduced to fit `budget`.
/// @param has_warm Non-zero if the host will supply warm-start phases.
/// @param has_band Non-zero if the host will supply band tables.
/// @param budget Iteration budget; non-positive falls back to the kernel default.
/// @return Job handle (>= 1); 0 if a parameter is illegal, `win` is unsupported, or the job or
/// slot pool is exhausted.
#export_name("dsp_rtisi_open")
pub fn rtisi_open(
  frames : Int,
  bins : Int,
  win : Int,
  hop : Int,
  samples : Int,
  iters : Int,
  has_warm : Int,
  has_band : Int,
  budget : Double,
) -> Int {
  let a = if hop < 1 { 1 } else { hop }
  if frames < 1 || bins < 2 || win < 2 || samples < 0 {
    return 0
  }
  let plan_id = plan(win)
  if plan_id < 0 {
    return 0
  }
  // K and iters shrink against the budget by the same expression and association order as the
  // reference: a different K is a different result. `r` must round, not divide — with hop 130
  // and win 512 rounding gives 4 where integer division gives 3.
  let r = (win.to_double() / a.to_double() + 0.5).to_int()
  let r2 = if r < 1 { 1 } else { r }
  let mut k = if frames - 1 < r2 - 1 { frames - 1 } else { r2 - 1 }
  if k < 0 {
    k = 0
  }
  let mut it = if iters < 1 { 1 } else { iters }
  let b = if budget > 0.0 { budget } else { rtisi_budget }
  let unit = frames.to_double() * win.to_double() * log2_exact(win)
  while k > 1 && unit * (k + 1).to_double() * it.to_double() > b {
    k = k - 1
  }
  while it > 1 && unit * (k + 1).to_double() * it.to_double() > b {
    it = it - 1
  }

  // Regions are laid out back to back. Any missing term shows up as an overlap, which
  // rtisi_wbtest.mbt walks segment by segment.
  let fb = frames * bins
  let padded = samples + win
  let span = k * a + win
  let state = (k + 1) * bins
  let off_mag = 0
  let off_warm = off_mag + fb
  let off_y = off_warm + fb
  let off_out = off_y + samples
  let off_cover = off_out + padded
  let off_local = off_cover + padded
  let off_work = off_local + span
  let off_workim = off_work + win
  let off_cos = off_workim + win
  let off_sin = off_cos + state
  let off_amp = off_sin + state
  let off_pcos = off_amp + state
  let off_psin = off_pcos + state
  let off_pamp = off_psin + state
  let off_band = off_pamp + state
  let words = off_band + 512

  let h = job_open(words, fb)
  if h == 0 {
    return 0
  }
  let slot_id = slot_open(win)
  if slot_id < 0 {
    job_close(h)
    return 0
  }
  let job : RtJob = {
    frames,
    bins,
    size: win,
    hop: a,
    samples,
    k,
    iters: it,
    padded,
    span,
    full: win / 2 + 1,
    plan_id,
    slot_id,
    has_warm: has_warm != 0,
    has_band: has_band != 0,
    arena: job_d(h),
    slot: slot_mem_of(slot_id),
    hann: plan_hann_of(plan_id),
    levels: job_b(h),
    off_mag,
    off_warm,
    off_y,
    off_out,
    off_local,
    off_work,
    off_workim,
    off_cos,
    off_sin,
    off_amp,
    off_pcos,
    off_psin,
    off_pamp,
    off_band,
    off_cover,
  }
  rt_jobs.unsafe_set(h - 1, Some(job))
  h
}

///|
/// Element offset of a region within the job's double main buffer.
///
/// @param h Job handle.
/// @param which 0 = mag, 1 = warm, 2 = y, 4 = band tables (512 entries).
/// @return Offset to add to the base of `dsp_job_d(h)`; -1 if `h` or `which` is invalid.
#export_name("dsp_rtisi_off")
pub fn rtisi_off(h : Int, which : Int) -> Int {
  match rt_at(h) {
    None => -1
    Some(job) =>
      match which {
        0 => job.off_mag
        1 => job.off_warm
        2 => job.off_y
        4 => job.off_band
        _ => -1
      }
  }
}

///|
/// Offset and length of `levels` within the job's byte segment (`dsp_job_b`). The segment holds
/// nothing else, so the offset is always 0.
///
/// @param h Job handle.
/// @param which 0 = byte offset, 1 = length in bytes.
/// @return The requested value; -1 if `h` or `which` is invalid.
#export_name("dsp_rtisi_levels")
pub fn rtisi_levels(h : Int, which : Int) -> Int {
  match rt_at(h) {
    None => -1
    Some(job) =>
      if which == 0 {
        0
      } else if which == 1 {
        job.frames * job.bins
      } else {
        -1
      }
  }
}

///|
/// Lengths of the `mag` and `out` regions of the main buffer, for sizing host views.
///
/// @param h Job handle.
/// @param which 0 = mag length (frames × bins); any other value = out length (samples + win).
/// @return The requested length; 0 if `h` is invalid.
#export_name("dsp_rtisi_len")
pub fn rtisi_len(h : Int, which : Int) -> Int {
  match rt_at(h) {
    None => 0
    Some(job) => if which == 0 { job.frames * job.bins } else { job.padded }
  }
}

///|
/// Closes an RTISI job, releasing its session slot and job area.
///
/// @param h Job handle; invalid or already-closed handles are ignored.
#export_name("dsp_rtisi_close")
pub fn rtisi_close(h : Int) -> Unit {
  let j = job_seg(h)
  if j < 0 {
    return
  }
  match rt_jobs.unsafe_get(j) {
    None => ()
    Some(job) => {
      slot_close(job.slot_id)
      rt_jobs.unsafe_set(j, None)
      job_close(h)
    }
  }
}

///|
/// Magnitude target for one element.
///
/// With band tables, `levels` has only 256 distinct values, so the two bounds per value are also
/// just 256 pairs: the host computes them from the quantisation rules and the kernel does one
/// byte read plus two table reads. Without band tables this is a hard projection onto `mag`.
fn rt_fit(job : RtJob, d : Double, i : Int) -> Double {
  if !job.has_band {
    return job.arena.unsafe_get(job.off_mag + i)
  }
  let lv = job.levels.unsafe_get(i).to_int()
  let lo = job.arena.unsafe_get(job.off_band + lv)
  if d < lo {
    return lo
  }
  let hi = job.arena.unsafe_get(job.off_band + 256 + lv)
  if d > hi {
    return hi
  }
  d
}

///|
/// Clears `local` and copies `out[at …]` into it.
fn rt_load(job : RtJob, at : Int) -> Unit {
  for n = 0; n < job.span; n = n + 1 {
    job.arena.unsafe_set(job.off_local + n, 0.0)
  }
  let room = job.padded - at
  let avail = if job.span < room { job.span } else { room }
  for n = 0; n < avail; n = n + 1 {
    job.arena.unsafe_set(
      job.off_local + n,
      job.arena.unsafe_get(job.off_out + at + n),
    )
  }
}

///|
/// Seeds slot `kk` with phases from `warm` and zero magnitudes: the amplitude is decided by the
/// projection anyway, and starting at zero is what lets the floor bin actually reach zero.
fn rt_put(job : RtJob, kk : Int, from : Int) -> Unit {
  let at = kk * job.bins
  for b = 0; b < job.bins; b = b + 1 {
    let p = job.arena.unsafe_get(job.off_warm + from + b)
    job.arena.unsafe_set(job.off_cos + at + b, @math.cos(p))
    job.arena.unsafe_set(job.off_sin + at + b, @math.sin(p))
    job.arena.unsafe_set(job.off_amp + at + b, 0.0)
  }
}

///|
/// Writes frame `f`'s half-spectrum into side 0 (r1/i1) or 1 (r2/i2) of the pair transform.
fn rt_fill(job : RtJob, f : Int, kk : Int, side : Int) -> Unit {
  let base = f * job.bins
  let at = kk * job.bins
  let rr = if side == 0 { pair_off(0, job.size) } else { pair_off(2, job.size) }
  let ii = if side == 0 { pair_off(1, job.size) } else { pair_off(3, job.size) }
  for b = 0; b < job.bins; b = b + 1 {
    let g = rt_fit(job, job.arena.unsafe_get(job.off_amp + at + b), base + b)
    job.slot.unsafe_set(rr + b, g * job.arena.unsafe_get(job.off_cos + at + b))
    job.slot.unsafe_set(ii + b, g * job.arena.unsafe_get(job.off_sin + at + b))
  }
  // Fewer rows than `full` is legal (an image-read exact spectrum is clamped by win/2+1); zero
  // the rest, or the previous inverse's time samples come back as this frame's spectrum.
  for b = job.bins; b < job.full; b = b + 1 {
    job.slot.unsafe_set(rr + b, 0.0)
    job.slot.unsafe_set(ii + b, 0.0)
  }
}

///|
/// One inverse transform covering two slots. `k1 < 0` fills only `k0` and feeds zeros to the
/// second half. Slot `kk` carries the magnitude of frame `m + kk`.
fn rt_lay(job : RtJob, m : Int, k0 : Int, k1 : Int) -> Unit {
  rt_fill(job, m + k0, k0, 0)
  let x1 = pair_off(4, job.size)
  let x2 = pair_off(5, job.size)
  if k1 >= 0 {
    rt_fill(job, m + k1, k1, 1)
  } else {
    let r2 = pair_off(2, job.size)
    let i2 = pair_off(3, job.size)
    for b = 0; b < job.full; b = b + 1 {
      job.slot.unsafe_set(r2 + b, 0.0)
      job.slot.unsafe_set(i2 + b, 0.0)
    }
  }
  pair_inverse(job.slot_id)
  // kk <= K implies from + win <= K·hop + win = span, so no bound check is needed.
  let from0 = k0 * job.hop
  for n = 0; n < job.size; n = n + 1 {
    job.arena.unsafe_set(
      job.off_local + from0 + n,
      job.arena.unsafe_get(job.off_local + from0 + n) +
      job.slot.unsafe_get(x1 + n) * job.hann.unsafe_get(n),
    )
  }
  if k1 >= 0 {
    let from1 = k1 * job.hop
    for n = 0; n < job.size; n = n + 1 {
      job.arena.unsafe_set(
        job.off_local + from1 + n,
        job.arena.unsafe_get(job.off_local + from1 + n) +
        job.slot.unsafe_get(x2 + n) * job.hann.unsafe_get(n),
      )
    }
  }
}

///|
/// Reads slot `kk`'s unit phasor and magnitude back out of side 0 or 1 of the pair transform.
fn rt_unpack(job : RtJob, kk : Int, side : Int) -> Unit {
  let rr = if side == 0 { pair_off(0, job.size) } else { pair_off(2, job.size) }
  let ii = if side == 0 { pair_off(1, job.size) } else { pair_off(3, job.size) }
  let at = kk * job.bins
  for b = 0; b < job.bins; b = b + 1 {
    let r = job.slot.unsafe_get(rr + b)
    let i = job.slot.unsafe_get(ii + b)
    let d = (r * r + i * i).sqrt()
    job.arena.unsafe_set(
      job.off_cos + at + b,
      if d > 0.0 {
        r / d
      } else {
        1.0
      },
    )
    job.arena.unsafe_set(
      job.off_sin + at + b,
      if d > 0.0 {
        i / d
      } else {
        0.0
      },
    )
    job.arena.unsafe_set(job.off_amp + at + b, d)
  }
}

///|
/// One forward transform reading two slots. `k1 < 0` reads only `k0`.
fn rt_read(job : RtJob, k0 : Int, k1 : Int) -> Unit {
  let x1 = pair_off(4, job.size)
  let x2 = pair_off(5, job.size)
  let from0 = k0 * job.hop
  for n = 0; n < job.size; n = n + 1 {
    job.slot.unsafe_set(
      x1 + n,
      job.arena.unsafe_get(job.off_local + from0 + n) * job.hann.unsafe_get(n),
    )
  }
  if k1 >= 0 {
    let from1 = k1 * job.hop
    for n = 0; n < job.size; n = n + 1 {
      job.slot.unsafe_set(
        x2 + n,
        job.arena.unsafe_get(job.off_local + from1 + n) * job.hann.unsafe_get(n),
      )
    }
  } else {
    for n = 0; n < job.size; n = n + 1 {
      job.slot.unsafe_set(x2 + n, 0.0)
    }
  }
  pair_forward(job.slot_id)
  rt_unpack(job, k0, 0)
  if k1 >= 0 {
    rt_unpack(job, k1, 1)
  }
}

///|
/// Slot paired with `kk` in a packed transform: adjacent frames share one complex transform.
/// -1 when there is no second slot left.
fn rt_second(kk : Int, act : Int) -> Int {
  if kk + 1 < act {
    kk + 1
  } else {
    -1
  }
}

///|
/// Advances phase reconstruction over frames [from, to).
///
/// @param h Job handle.
/// @param from First frame; clamped to 0.
/// @param to Exclusive end frame; clamped to the frame count.
/// @return The frame actually reached, for continuing with the next chunk; 0 if `h` is invalid.
#export_name("dsp_rtisi_run")
pub fn rtisi_run(h : Int, from : Int, to : Int) -> Int {
  match rt_at(h) {
    None => 0
    Some(job) => {
      let frames = job.frames
      let bins = job.bins
      let k = job.k
      let win = job.size
      let mut m = if from < 0 { 0 } else { from }
      let stop = if to > frames { frames } else { to }
      while m < stop {
        let act = if k + 1 < frames - m { k + 1 } else { frames - m }
        let at = m * job.hop
        rt_load(job, at)

        if m == 0 {
          if job.has_warm {
            for kk = 0; kk < act; kk = kk + 1 {
              rt_put(job, kk, kk * bins)
            }
          } else {
            let mut kk = 0
            while kk < act {
              rt_read(job, kk, rt_second(kk, act))
              kk = kk + 2
            }
          }
        } else {
          for kk = 0; kk < act; kk = kk + 1 {
            let next = (kk + 1) * bins
            let here = kk * bins
            if kk <= k - 1 {
              for b = 0; b < bins; b = b + 1 {
                job.arena.unsafe_set(
                  job.off_cos + here + b,
                  job.arena.unsafe_get(job.off_pcos + next + b),
                )
                job.arena.unsafe_set(
                  job.off_sin + here + b,
                  job.arena.unsafe_get(job.off_psin + next + b),
                )
                job.arena.unsafe_set(
                  job.off_amp + here + b,
                  job.arena.unsafe_get(job.off_pamp + next + b),
                )
              }
            } else if job.has_warm {
              rt_put(job, kk, (m + kk) * bins)
            } else {
              for b = 0; b < bins; b = b + 1 {
                job.arena.unsafe_set(job.off_cos + here + b, 1.0)
                job.arena.unsafe_set(job.off_sin + here + b, 0.0)
                job.arena.unsafe_set(job.off_amp + here + b, 0.0)
              }
            }
          }
          // Frame 0's phase is re-read from the frames already written to `out`: that is what
          // keeps frame boundaries from clicking.
          rt_read(job, 0, -1)
        }

        for _it = 0; _it < job.iters; _it = _it + 1 {
          rt_load(job, at)
          let mut kk = 0
          while kk < act {
            rt_lay(job, m, kk, rt_second(kk, act))
            kk = kk + 2
          }
          kk = 0
          while kk < act {
            rt_read(job, kk, rt_second(kk, act))
            kk = kk + 2
          }
        }

        // Commit: slot 0 only, so a single complex transform through the slot's zr/zi.
        let base = m * bins
        for b = 0; b < bins; b = b + 1 {
          let g = rt_fit(job, job.arena.unsafe_get(job.off_amp + b), base + b)
          job.arena.unsafe_set(
            job.off_work + b,
            g * job.arena.unsafe_get(job.off_cos + b),
          )
          job.arena.unsafe_set(
            job.off_workim + b,
            g * job.arena.unsafe_get(job.off_sin + b),
          )
        }
        for b = bins; b < job.full; b = b + 1 {
          job.arena.unsafe_set(job.off_work + b, 0.0)
          job.arena.unsafe_set(job.off_workim + b, 0.0)
        }
        for n = 0; n < win; n = n + 1 {
          job.slot.unsafe_set(n, job.arena.unsafe_get(job.off_work + n))
          job.slot.unsafe_set(win + n, job.arena.unsafe_get(job.off_workim + n))
        }
        // One-sided spectrum to conjugate symmetry; the DC and Nyquist bins are real.
        job.slot.unsafe_set(win, 0.0)
        job.slot.unsafe_set(win + job.full - 1, 0.0)
        for b = 1; b < job.full - 1; b = b + 1 {
          job.slot.unsafe_set(win - b, job.slot.unsafe_get(b))
          job.slot.unsafe_set(2 * win - b, -1.0 * job.slot.unsafe_get(win + b))
        }
        fft_at(job.plan_id, job.slot, 0, win, true)
        let room = if win < job.padded - at { win } else { job.padded - at }
        for n = 0; n < room; n = n + 1 {
          job.arena.unsafe_set(
            job.off_out + at + n,
            job.arena.unsafe_get(job.off_out + at + n) +
            job.slot.unsafe_get(n) * job.hann.unsafe_get(n),
          )
        }

        let state = (k + 1) * bins
        for b = 0; b < state; b = b + 1 {
          job.arena.unsafe_set(
            job.off_pcos + b,
            job.arena.unsafe_get(job.off_cos + b),
          )
          job.arena.unsafe_set(
            job.off_psin + b,
            job.arena.unsafe_get(job.off_sin + b),
          )
          job.arena.unsafe_set(
            job.off_pamp + b,
            job.arena.unsafe_get(job.off_amp + b),
          )
        }
        m = m + 1
      }
      m
    }
  }
}

///|
/// Finalizes a fully-run job: overlap-normalize and edge-fade into `y`.
///
/// The overlap envelope is accumulated in frame order, matching the reference bit for bit.
///
/// @param h Job handle; invalid handles are ignored. Call after every frame has been run.
#export_name("dsp_rtisi_finish")
pub fn rtisi_finish(h : Int) -> Unit {
  match rt_at(h) {
    None => ()
    Some(job) => {
      let win = job.size
      let a = job.hop
      let half = win / 2
      let w = job.hann
      for f = 0; f < job.frames; f = f + 1 {
        let s = f * a
        for mh = 0; mh < win; mh = mh + 1 {
          let ww = w.unsafe_get(mh) * w.unsafe_get(mh)
          job.arena.unsafe_set(
            job.off_cover + s + mh,
            job.arena.unsafe_get(job.off_cover + s + mh) + ww,
          )
        }
      }
      let mut top = 0.0
      for i = 0; i < job.padded; i = i + 1 {
        let v = job.arena.unsafe_get(job.off_cover + i)
        if v > top {
          top = v
        }
      }
      let floor = top * 0.05
      for i = 0; i < job.samples; i = i + 1 {
        let c = job.arena.unsafe_get(job.off_cover + half + i)
        job.arena.unsafe_set(
          job.off_y + i,
          if c > floor {
            job.arena.unsafe_get(job.off_out + half + i) / c
          } else {
            0.0
          },
        )
      }
    }
  }
}
