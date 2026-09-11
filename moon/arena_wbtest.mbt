// 作业区的白盒不变量。
//
// 作业区从「单一后备缓冲 + 分段 bump 分配」改成「一个作业一段自己的数组」之后，
// 原先要盯的三件事（扩容搬数据、扩容世代、段首连续）**整类不存在了**：
// 没有后备缓冲就没有搬运，没有换缓冲就没有世代，段首也不再是别人算出来的偏移。
// 换来的新不变量只有四条，且都能一次证伪：
//   ① 池满拒绝、归还后能再拿到（与旧版同一条）；
//   ② 长度**恰好**是要的那么多（宿主按它定视图长度，多一个少一个都是静默越界）；
//   ③ 交出去的是零初值（调用方不该读到上一件活的残值）；
//   ④ 两件活互不干扰（这是并发那条性质的唯一直接证据）。
//
// 「宿主视图与内核读写的是同一格」不在这里 —— 它跨语言，证不了的就别假装证了：
// 那条由 `app/lib/dsp.test.ts` 的两向握手守着（内核写、宿主两把视图读回；宿主写、内核读回）。

///|
/// 把还活着的句柄都还回去。测试之间共用同一个模块级作业区，不还干净会串味 ——
/// 而且「池满」那条断言会因此变得看运气。
fn release_jobs(handles : FixedArray[Int]) -> Unit {
  for h in handles {
    if h >= 1 {
      job_close(h)
    }
  }
}

///|
test "白盒：作业区池满后拒绝，归还后能再拿到" {
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
/// 长度是导出面的一部分：宿主拿 `dsp_job_words` / `dsp_job_bytes` 定视图长度，
/// 内核按尺寸表读写。两边差一个就是静默越界 —— 所以这里逐字段对。
test "白盒：两段的长度恰好是要的那个数" {
  let h = job_open(37, 91)
  assert_true(h >= 1)
  assert_eq(job_words_of(h), 37)
  assert_eq(job_bytes_of(h), 91)
  assert_eq(job_d(h).length(), 37)
  assert_eq(job_b(h).length(), 91)
  // 只给主缓冲也行（票根 decode 就是这种），字节段长度 0 而不是「没这回事」。
  let h2 = job_open(5, 0)
  assert_true(h2 >= 1)
  assert_eq(job_words_of(h2), 5)
  assert_eq(job_bytes_of(h2), 0)
  release_jobs([h, h2])
}

///|
/// 段是复用的（句柄号会被重新发出去），但**存储不是**：新开的那段一定是零。
/// 调用方不该从上一件活的残值里读出东西来 —— 与会话槽 `slot_open` 同一条理由。
test "白盒：新开的段是零初值（含字节段）" {
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
/// 并发那条性质的唯一直接证据：一件活写自己的段，另一件活的段一个字节都不许动。
/// 旧版这里靠「段基址偏移算对」，新版靠「各是各的数组」—— 后者对，前者错过一次。
test "白盒：两件活各写各的，互不干扰" {
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
  // 主语段与字节段互不重叠：改字节段不该让主语段动。
  for i = 0; i < 16; i = i + 1 {
    ba.unsafe_set(i, b'\xff')
  }
  for i = 0; i < 16; i = i + 1 {
    assert_eq(da.unsafe_get(i), (100 + i).to_double())
  }
  release_jobs([ha, hb])
}

///|
/// 归还之后句柄即刻失效：长度归零、访问器给空表。归还了还接着读是最容易漏的一条，
/// 而它在新结构下是「拿到一段长度 0 的数组」，不会越界读到别人的数据。
test "白盒：归还之后句柄失效" {
  let h = job_open(16, 16)
  assert_true(h >= 1)
  // 另开一件活，并**确认句柄号与 h 不同**：句柄号是会复用的，若这里又拿到同一个号，
  // 下面那句 `job_close(h)` 关掉的其实是它，「双归还不伤人」就假绿了。
  let keep = job_open(16, 0)
  assert_true(keep >= 1 && keep != h)
  job_close(h)
  assert_eq(job_words_of(h), 0)
  assert_eq(job_bytes_of(h), 0)
  assert_eq(job_d(h).length(), 0)
  assert_eq(job_b(h).length(), 0)
  assert_eq(job_live_count(), 1)
  // 双归还、以及非法句柄，都不许动到别人的段。
  job_close(h)
  job_close(0)
  job_close(-1)
  job_close(max_jobs + 1)
  assert_eq(job_live_count(), 1)
  assert_eq(job_words_of(keep), 16)
  release_jobs([keep])
}

///|
/// 非法尺寸一律拒绝（返回 0），不是崩溃 —— 与会话槽同一套降级约定。
/// **但 0×0 是合法的**：它表示「这一件活两段都不要」，不是参数非法（`probe_*` 就靠它
/// 自证「句柄合法、段太小」这条分支）。把它一起当非法会让那条分支永远走不到。
test "白盒：非法尺寸与非法句柄都被拒（不是崩溃）" {
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
