// Job arenas: the third kind of memory, alongside plan tables (read-only cache) and session
// slots (fixed size). Their size is *not* a compile-time constant — one encode or invert needs
// anywhere from a few hundred kilobytes to tens of megabytes depending on the material.
//
// One job owns its own arrays rather than carving regions out of a shared bump-allocated buffer.
// The host reaches kernel memory through the array an exported function returns, so "handle →
// array" is the shortest path: segment bases, growth relocation and growth generations all
// disappear, and with them the class of bug where the first segment hides a missing base.
//
// Two buffers, because `levels` and the stub's pixels are byte data: putting them in a
// `FixedArray[Double]` would cost 8× (a 16M-pixel profile alone would be 128 MB). See
// moon/README.md.

///|
/// Concurrent job limit. A worker peaks at two encodes plus one invert.
let max_jobs : Int = 4

///|
/// Double-segment cap: 64M elements = 512 MB, far above any real material (the pixel budget is
/// 16M, so `frames×bins` tops out there). It exists only so one bad size cannot blow up the
/// wasm memory.
let max_job_words : Int = 1 << 26

///|
/// Byte-segment cap. The largest users are `levels` (`frames×bins` bytes) and stub pixels.
let max_job_bytes : Int = 1 << 26

///|
/// Double main buffer per job; a free slot holds a zero-length array so the GC can reclaim it.
let job_mem : FixedArray[FixedArray[Double]] = FixedArray::makei(max_jobs, _ => {
  FixedArray::make(0, 0.0)
})

///|
/// Byte segment per job.
let job_bmem : FixedArray[FixedArray[Byte]] = FixedArray::makei(max_jobs, _ => {
  FixedArray::make(0, b'\x00')
})

///|
let job_live : FixedArray[Bool] = FixedArray::make(max_jobs, false)

///|
/// Handle to job index; -1 for an invalid or released handle.
fn job_seg(h : Int) -> Int {
  let j = h - 1
  if j < 0 || j >= max_jobs || !job_live.unsafe_get(j) {
    return -1
  }
  j
}

///|
/// Allocates one job area with a fresh, zero-initialized double buffer and byte segment.
///
/// Both segments are newly allocated, so nothing here needs to clear them: a caller must never
/// be able to read a previous job's leftovers, and the allocation itself guarantees it.
///
/// @param dwords Elements for the main buffer.
/// @param bytes Bytes for the byte segment (0 if unused).
/// @return Handle (>= 1); 0 if the pool is full or a size is negative or over the segment cap.
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
/// Releases a job area and drops both of its segments.
///
/// @param h Job handle; invalid or already-released handles are ignored.
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
/// The job's double main buffer, as a live view into kernel memory.
///
/// @return The buffer, or an empty array if `h` is invalid. The host reads its data pointer to
/// build a typed view; `memory.grow` detaches that view, so re-slice after every `await`.
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
/// The job's byte segment, as a live view into kernel memory.
///
/// @return The segment, or an empty array if `h` is invalid.
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
/// Length of the job's double main buffer, in elements. The host must not infer this from the
/// address.
///
/// @return The element count; 0 if `h` is invalid.
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
/// Length of the job's byte segment, in bytes.
///
/// @return The byte count; 0 if `h` is invalid.
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
/// White-box: how many jobs are allocated. Guards the open/close balance.
///
/// @return Count of live jobs, from 0 to the pool size.
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
