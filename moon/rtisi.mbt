///|
using @math {cos, log2, round, sin}

///|
let rtisi_budget : Double = 5.0e7

///|
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
  slot_id : Int
  has_warm : Bool
  has_band : Bool
  arena : FixedArray[Double]
  slot : FixedArray[Double]
  hann : FixedArray[Double]
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
fn rt_at(h : Int) -> RtJob? {
  let j = job_seg(h)
  if j < 0 {
    None
  } else {
    rt_jobs.unsafe_get(j)
  }
}

///|
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
  let a = hop.max(1)
  if frames < 1 || bins < 2 || win < 2 || samples < 0 {
    return 0
  }
  let plan_id = plan(win)
  if plan_id < 0 {
    return 0
  }
  let r = round(win.to_double() / a.to_double()).to_int()
  let mut k = (frames - 1).min(r.max(1) - 1).max(0)
  let mut it = iters.max(1)
  let b = if budget > 0.0 { budget } else { rtisi_budget }
  let unit = frames.to_double() * win.to_double() * log2(win.to_double())
  while k > 1 && unit * (k + 1).to_double() * it.to_double() > b {
    k = k - 1
  }
  while it > 1 && unit * (k + 1).to_double() * it.to_double() > b {
    it = it - 1
  }

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
fn rt_fit(job : RtJob, d : Double, i : Int) -> Double {
  if !job.has_band {
    return job.arena.unsafe_get(job.off_mag + i)
  }
  let lv = job.levels.unsafe_get(i).to_int()
  let lo = job.arena.unsafe_get(job.off_band + lv)
  let hi = job.arena.unsafe_get(job.off_band + 256 + lv)
  d.clamp(min=lo, max=hi)
}

///|
fn rt_load(job : RtJob, at : Int) -> Unit {
  for n = 0; n < job.span; n = n + 1 {
    job.arena.unsafe_set(job.off_local + n, 0.0)
  }
  let room = job.padded - at
  let avail = job.span.min(room)
  for n = 0; n < avail; n = n + 1 {
    job.arena.unsafe_set(
      job.off_local + n,
      job.arena.unsafe_get(job.off_out + at + n),
    )
  }
}

///|
fn rt_put(job : RtJob, kk : Int, from : Int) -> Unit {
  let at = kk * job.bins
  for b = 0; b < job.bins; b = b + 1 {
    let p = job.arena.unsafe_get(job.off_warm + from + b)
    job.arena.unsafe_set(job.off_cos + at + b, cos(p))
    job.arena.unsafe_set(job.off_sin + at + b, sin(p))
    job.arena.unsafe_set(job.off_amp + at + b, 0.0)
  }
}

///|
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
  for b = job.bins; b < job.full; b = b + 1 {
    job.slot.unsafe_set(rr + b, 0.0)
    job.slot.unsafe_set(ii + b, 0.0)
  }
}

///|
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
fn rt_second(kk : Int, act : Int) -> Int {
  if kk + 1 < act {
    kk + 1
  } else {
    -1
  }
}

///|
#export_name("dsp_rtisi_run")
pub fn rtisi_run(h : Int, from : Int, to : Int) -> Int {
  match rt_at(h) {
    None => 0
    Some(job) => {
      let frames = job.frames
      let bins = job.bins
      let k = job.k
      let win = job.size
      let mut m = from.max(0)
      let stop = to.min(frames)
      while m < stop {
        let act = (k + 1).min(frames - m)
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
        ignore(real_ifft(job.slot_id, job.full))
        let room = win.min(job.padded - at)
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
        top = top.max(job.arena.unsafe_get(job.off_cover + i))
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
