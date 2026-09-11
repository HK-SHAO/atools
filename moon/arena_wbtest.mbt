///|
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
test "white box: both segments have exactly the requested lengths" {
  let h = job_open(37, 91)
  assert_true(h >= 1)
  assert_eq(job_words_of(h), 37)
  assert_eq(job_bytes_of(h), 91)
  assert_eq(job_d(h).length(), 37)
  assert_eq(job_b(h).length(), 91)
  let h2 = job_open(5, 0)
  assert_true(h2 >= 1)
  assert_eq(job_words_of(h2), 5)
  assert_eq(job_bytes_of(h2), 0)
  release_jobs([h, h2])
}

///|
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
  for i = 0; i < 16; i = i + 1 {
    ba.unsafe_set(i, b'\xff')
  }
  for i = 0; i < 16; i = i + 1 {
    assert_eq(da.unsafe_get(i), (100 + i).to_double())
  }
  release_jobs([ha, hb])
}

///|
test "white box: the handle is dead after release" {
  let h = job_open(16, 16)
  assert_true(h >= 1)
  let keep = job_open(16, 0)
  assert_true(keep >= 1 && keep != h)
  job_close(h)
  assert_eq(job_words_of(h), 0)
  assert_eq(job_bytes_of(h), 0)
  assert_eq(job_d(h).length(), 0)
  assert_eq(job_b(h).length(), 0)
  assert_eq(job_live_count(), 1)
  job_close(h)
  job_close(0)
  job_close(-1)
  job_close(max_jobs + 1)
  assert_eq(job_live_count(), 1)
  assert_eq(job_words_of(keep), 16)
  release_jobs([keep])
}

///|
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
