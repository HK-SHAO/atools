// White-box invariants of the job area.
//
// After the job area moved from "one backing buffer + segmented bump allocation" to "each job owns
// its own array", the three old concerns (growth relocation, growth generation, segment-head
// contiguity) **ceased to exist as a class**: no backing buffer means no relocation, no buffer swap
// means no generation, and the segment head is no longer an offset computed by someone else. The
// new invariants are four, each falsifiable in one shot:
//   1. a full pool refuses, release makes it available again (same as the old version);
//   2. the length is **exactly** what was asked (the host sizes its view by it; one either way is a
//      silent out-of-bounds);
//   3. what is handed out is zero-initialized (a caller must not read the previous job's residue);
//   4. two live jobs do not interfere (the only direct evidence for the concurrency property).
//
// "Host view and kernel read/write the same cell" is not here — it is cross-language, and what
// cannot be proven should not be pretended: that is guarded by the two-way handshake in
// `app/lib/dsp.test.ts` (kernel writes, both host views read back; host writes, kernel reads back).

///|
/// Return every still-live handle. Cases share one module-level job area and leftover state bleeds
/// across — worse, the "pool full" assertion would then pass by luck.
fn release_jobs(handles : FixedArray[Int]) -> Unit {
  for h in handles {
    if h >= 1 {
      job_close(h)
    }
  }
}

///|
test "white box: a full job pool refuses, and release makes it available again" {
  let hs = FixedArray::make(max_jobs, 0)
  for i = 0; i < max_jobs; i = i + 1 {
    hs.unsafe_set(i, job_open(64, 0))
  }
  assert_true(hs.unsafe_get(max_jobs - 1) >= 1)
  assert_eq(job_open(64, 0), 0)
  assert_eq(job_live_count(), max_jobs)
  job_close(hs.unsafe_get(0))
  assert_eq(job_live_count(), max_jobs - 1)
  let again = job_open(64, 0)
  assert_true(again >= 1)
  hs.unsafe_set(0, again)
  release_jobs(hs)
  assert_eq(job_live_count(), 0)
}

///|
/// Lengths are part of the exported surface: the host sizes its views from `dsp_job_words` /
/// `dsp_job_bytes` while the kernel reads/writes by the size table. One off either way is a silent
/// out-of-bounds — hence the field-by-field check.
test "white box: both segments have exactly the requested lengths" {
  let h = job_open(37, 91)
  assert_true(h >= 1)
  assert_eq(job_words_of(h), 37)
  assert_eq(job_bytes_of(h), 91)
  assert_eq(job_d(h).length(), 37)
  assert_eq(job_b(h).length(), 91)
  // Main buffer only is also allowed (the ticket decode path); the byte segment length is 0, not
  // "absent".
  let h2 = job_open(5, 0)
  assert_true(h2 >= 1)
  assert_eq(job_words_of(h2), 5)
  assert_eq(job_bytes_of(h2), 0)
  release_jobs([h, h2])
}

///|
/// Segments are reused (handle numbers get handed out again) but **storage is not**: a freshly
/// opened segment is always zero. A caller must not read the previous job's residue — same
/// rationale as the session slot `slot_open`.
test "white box: a freshly opened segment is zero-initialized (including the byte segment)" {
  let h1 = job_open(32, 32)
  assert_true(h1 >= 1)
  let d1 = job_d(h1)
  let b1 = job_b(h1)
  for i = 0; i < 32; i = i + 1 {
    d1.unsafe_set(i, 7.5)
    b1.unsafe_set(i, b'\xee')
  }
  job_close(h1)
  let h2 = job_open(32, 32)
  assert_true(h2 >= 1)
  let d2 = job_d(h2)
  let b2 = job_b(h2)
  for i = 0; i < 32; i = i + 1 {
    assert_eq(d2.unsafe_get(i), 0.0)
    assert_eq(b2.unsafe_get(i).to_int(), 0)
  }
  release_jobs([h2])
}

///|
/// The only direct evidence for the concurrency property: one job writes its own segment and not a
/// single byte of the other's may change. The old version relied on "the segment base offset is
/// computed right", the new one on "each has its own array" — the latter was right, the former was
/// wrong once.
test "white box: two live jobs write their own segments without interfering" {
  let ha = job_open(16, 16)
  let hb = job_open(16, 16)
  assert_true(ha >= 1 && hb >= 1)
  let da = job_d(ha)
  let db = job_d(hb)
  let ba = job_b(ha)
  let bb = job_b(hb)
  for i = 0; i < 16; i = i + 1 {
    da.unsafe_set(i, (100 + i).to_double())
    ba.unsafe_set(i, (200 + i).to_byte())
  }
  for i = 0; i < 16; i = i + 1 {
    assert_eq(db.unsafe_get(i), 0.0)
    assert_eq(bb.unsafe_get(i).to_int(), 0)
  }
  // The word segment and the byte segment do not overlap: touching the byte segment must not move
  // the word segment.
  for i = 0; i < 16; i = i + 1 {
    ba.unsafe_set(i, b'\xff')
  }
  for i = 0; i < 16; i = i + 1 {
    assert_eq(da.unsafe_get(i), (100 + i).to_double())
  }
  release_jobs([ha, hb])
}

///|
/// A handle is dead the instant it is returned: lengths go to zero and accessors give empty arrays.
/// Reading after release is the easiest thing to miss, and under the new structure it is "get a
/// length-0 array", which cannot read someone else's data.
test "white box: the handle is dead after release" {
  let h = job_open(16, 16)
  assert_true(h >= 1)
  // Open another job and **confirm its handle differs from `h`**: handle numbers are reused, so if
  // this got the same number the following `job_close(h)` would actually close it and "double
  // release is harmless" would pass falsely.
  let keep = job_open(16, 0)
  assert_true(keep >= 1 && keep != h)
  job_close(h)
  assert_eq(job_words_of(h), 0)
  assert_eq(job_bytes_of(h), 0)
  assert_eq(job_d(h).length(), 0)
  assert_eq(job_b(h).length(), 0)
  assert_eq(job_live_count(), 1)
  // Double release and illegal handles must not touch anyone else's segment.
  job_close(h)
  job_close(0)
  job_close(-1)
  job_close(max_jobs + 1)
  assert_eq(job_live_count(), 1)
  assert_eq(job_words_of(keep), 16)
  release_jobs([keep])
}

///|
/// Illegal sizes are rejected (return 0), not crashed on — same degradation convention as the
/// session slots. **But 0×0 is legal**: it means "this job wants neither segment", not an illegal
/// argument (`probe_*` relies on it to exercise the "valid handle, segment too small" branch).
/// Treating it as illegal would make that branch unreachable.
test "white box: illegal sizes and illegal handles are rejected, not crashed on" {
  let empty = job_open(0, 0)
  assert_true(empty >= 1)
  assert_eq(job_words_of(empty), 0)
  assert_eq(job_bytes_of(empty), 0)
  job_close(empty)
  assert_eq(job_open(-4, 0), 0)
  assert_eq(job_open(0, -4), 0)
  assert_eq(job_open(max_job_words + 1, 0), 0)
  assert_eq(job_open(0, max_job_bytes + 1), 0)
  assert_eq(job_words_of(0), 0)
  assert_eq(job_bytes_of(max_jobs + 1), 0)
  assert_eq(job_d(0).length(), 0)
  assert_eq(job_b(0).length(), 0)
  job_close(0)
  job_close(-1)
  job_close(max_jobs + 1)
}
