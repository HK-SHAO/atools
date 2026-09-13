///|
let max_slots : Int = 6

///|
let slot_words : Int = 4 * max_win + 4 * (max_win / 2 + 1)

///|
let slot_plan : FixedArray[Int] = FixedArray::make(max_slots, -1)

///|
let slot_mem : FixedArray[FixedArray[Double]] = FixedArray::makei(max_slots, _ => {
  FixedArray::make(slot_words, 0.0)
})

///|
fn slot_live(s : Int) -> Bool {
  s >= 0 && s < max_slots && slot_plan.unsafe_get(s) >= 0
}

///|
/// Opens a zeroed FFT slot for a supported window size.
#export_name("dsp_slot_open")
pub fn slot_open(win : Int) -> Int {
  let plan_id = plan(win)
  if plan_id < 0 {
    return -1
  }
  let mut s = 0
  while s < max_slots && slot_live(s) {
    s = s + 1
  }
  if s == max_slots {
    return -2
  }
  slot_plan.unsafe_set(s, plan_id)
  slot_mem.unsafe_get(s).fill(0.0)
  s
}

///|
/// Releases an FFT slot; invalid slot IDs are ignored.
#export_name("dsp_slot_close")
pub fn slot_close(s : Int) -> Unit {
  if s >= 0 && s < max_slots {
    slot_plan.unsafe_set(s, -1)
  }
}

///|
/// Returns the memory of an open FFT slot, or an empty array.
#export_name("dsp_slot_mem")
pub fn slot_mem_of(s : Int) -> FixedArray[Double] {
  if !slot_live(s) {
    FixedArray::make(0, 0.0)
  } else {
    slot_mem.unsafe_get(s)
  }
}

///|
/// Returns the double capacity of an open FFT slot.
#export_name("dsp_slot_words")
pub fn slot_words_of(s : Int) -> Int {
  if !slot_live(s) {
    0
  } else {
    slot_words
  }
}
