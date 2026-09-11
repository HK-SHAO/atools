// Session slots: the fixed-size workspace a long computation borrows.
//
// The kernel has no single global workspace — `encode` and `synthesise` can overlap inside one
// worker, and each needs its own. A slot is statically sized (`4·max_win + 4·(max_win/2+1)`
// doubles: the largest union of the pair-transform layout) and never moves, so the host slices
// a view of it once per use. `memory.grow` still detaches those views — that is the host's
// problem to re-slice, the same rule as job arenas.
//
// A bound plan index doubles as the busy flag: -1 means the slot is free. See moon/README.md.

///|
/// Slot pool size. Six is the ceiling on concurrent computations; asking for a seventh fails.
let max_slots : Int = 6

///|
/// Doubles per slot.
let slot_words : Int = 4 * max_win + 4 * (max_win / 2 + 1)

///|
/// Plan-group index bound to each slot; -1 marks a free slot.
let slot_plan : FixedArray[Int] = FixedArray::make(max_slots, -1)

///|
let slot_mem : FixedArray[FixedArray[Double]] = FixedArray::makei(max_slots, _ => {
  FixedArray::make(slot_words, 0.0)
})

///|
/// Whether slot `s` is open.
fn slot_live(s : Int) -> Bool {
  s >= 0 && s < max_slots && slot_plan.unsafe_get(s) >= 0
}

///|
/// Claims a slot bound to the plan group for `win`, and clears its workspace.
///
/// @param win Window length, forwarded to `dsp_plan`.
/// @return Slot index (>= 0); -1 if `win` is unsupported; -2 if every slot is busy.
#export_name("dsp_slot_open")
pub fn slot_open(win : Int) -> Int {
  let pi = plan(win)
  if pi < 0 {
    return -1
  }
  let mut s = 0
  while s < max_slots && slot_live(s) {
    s = s + 1
  }
  if s == max_slots {
    return -2
  }
  slot_plan.unsafe_set(s, pi)
  // Slots are reused, so the caller must never see the previous tenant's values: the pair
  // inverse reads halves the caller did not write.
  slot_mem.unsafe_get(s).fill(0.0)
  s
}

///|
/// Releases a session slot.
///
/// @param s Slot index; out-of-range indices are ignored.
#export_name("dsp_slot_close")
pub fn slot_close(s : Int) -> Unit {
  if s >= 0 && s < max_slots {
    slot_plan.unsafe_set(s, -1)
  }
}

///|
/// The slot's double workspace, as a live view into kernel memory.
///
/// @return The workspace, or an empty array if `s` is invalid. The host derives its address, so
/// the view must be re-sliced after every `await` (`memory.grow` detaches it).
#export_name("dsp_slot_mem")
pub fn slot_mem_of(s : Int) -> FixedArray[Double] {
  if !slot_live(s) {
    FixedArray::make(0, 0.0)
  } else {
    slot_mem.unsafe_get(s)
  }
}

///|
/// Capacity of a slot workspace, in elements. The host must not derive `4S+4H` itself.
///
/// @return The element capacity; 0 if `s` is invalid.
#export_name("dsp_slot_words")
pub fn slot_words_of(s : Int) -> Int {
  if !slot_live(s) {
    0
  } else {
    slot_words
  }
}
