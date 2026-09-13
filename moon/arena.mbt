///|
let max_jobs : Int = 4

///|
let max_job_words : Int = 1 << 26

///|
let max_job_bytes : Int = 1 << 26

///|
let job_mem : FixedArray[FixedArray[Double]] = FixedArray::makei(max_jobs, _ => {
  FixedArray::make(0, 0.0)
})

///|
let job_bmem : FixedArray[FixedArray[Byte]] = FixedArray::makei(max_jobs, _ => {
  FixedArray::make(0, b'\x00')
})

///|
let job_live : FixedArray[Bool] = FixedArray::make(max_jobs, false)

///|
fn job_seg(h : Int) -> Int {
  let j = h - 1
  if j < 0 || j >= max_jobs || !job_live.unsafe_get(j) {
    return -1
  }
  j
}

///|
/// Opens a zeroed job arena, returning zero when the request cannot be served.
#export_name("dsp_job_open")
pub fn job_open(dwords : Int, bytes : Int) -> Int {
  if dwords < 0 || bytes < 0 || dwords > max_job_words || bytes > max_job_bytes {
    return 0
  }
  let mut j = 0
  while j < max_jobs && job_live.unsafe_get(j) {
    j = j + 1
  }
  if j == max_jobs {
    return 0
  }
  job_mem.unsafe_set(j, FixedArray::make(dwords, 0.0))
  job_bmem.unsafe_set(j, FixedArray::make(bytes, b'\x00'))
  job_live.unsafe_set(j, true)
  j + 1
}

///|
/// Releases a job arena; invalid handles are ignored.
#export_name("dsp_job_close")
pub fn job_close(h : Int) -> Unit {
  let j = job_seg(h)
  if j < 0 {
    return
  }
  job_live.unsafe_set(j, false)
  job_mem.unsafe_set(j, FixedArray::make(0, 0.0))
  job_bmem.unsafe_set(j, FixedArray::make(0, b'\x00'))
}

///|
/// Returns the double arena for an open job, or an empty array.
#export_name("dsp_job_d")
pub fn job_d(h : Int) -> FixedArray[Double] {
  let j = job_seg(h)
  if j < 0 {
    FixedArray::make(0, 0.0)
  } else {
    job_mem.unsafe_get(j)
  }
}

///|
/// Returns the byte arena for an open job, or an empty array.
#export_name("dsp_job_b")
pub fn job_b(h : Int) -> FixedArray[Byte] {
  let j = job_seg(h)
  if j < 0 {
    FixedArray::make(0, b'\x00')
  } else {
    job_bmem.unsafe_get(j)
  }
}

///|
/// Returns the double capacity of an open job.
#export_name("dsp_job_words")
pub fn job_words_of(h : Int) -> Int {
  let j = job_seg(h)
  if j < 0 {
    0
  } else {
    job_mem.unsafe_get(j).length()
  }
}

///|
/// Returns the byte capacity of an open job.
#export_name("dsp_job_bytes")
pub fn job_bytes_of(h : Int) -> Int {
  let j = job_seg(h)
  if j < 0 {
    0
  } else {
    job_bmem.unsafe_get(j).length()
  }
}

///|
/// Returns the number of open job arenas.
#export_name("dsp_job_live")
pub fn job_live_count() -> Int {
  let mut n = 0
  for j = 0; j < max_jobs; j = j + 1 {
    if job_live.unsafe_get(j) {
      n = n + 1
    }
  }
  n
}
