///|
let max_win : Int = 4096

///|
let min_win : Int = 256

///|
let plan_count : Int = 5

///|
priv struct Plan {
  rev : FixedArray[Int]
  cos : FixedArray[Double]
  sin : FixedArray[Double]
  hann : FixedArray[Double]
}

///|
let plans : FixedArray[Plan?] = FixedArray::make(plan_count, None)

///|
fn plan_of(win : Int) -> Int {
  if win < min_win || win > max_win || (win & (win - 1)) != 0 {
    return -1
  }
  let i = (@math.log2(win.to_double()) - @math.log2(min_win.to_double())).to_int()
  if i >= plan_count {
    return -1
  }
  i
}

///|
fn plan_at(i : Int) -> Plan? {
  if i < 0 || i >= plan_count {
    None
  } else {
    plans.unsafe_get(i)
  }
}

///|
#export_name("dsp_plan")
pub fn plan(win : Int) -> Int {
  let i = plan_of(win)
  if i < 0 {
    return -1
  }
  match plans.unsafe_get(i) {
    Some(_) => i
    None => {
      let mut levels = 0
      while 1 << levels < win {
        levels = levels + 1
      }
      let rev = FixedArray::make(win, 0)
      for k = 0; k < win; k = k + 1 {
        let mut r = 0
        for b = 0; b < levels; b = b + 1 {
          if (k & (1 << b)) != 0 {
            r = r | (1 << (levels - 1 - b))
          }
        }
        rev.unsafe_set(k, r)
      }
      let half = win / 2
      let n = win.to_double()
      let cos = FixedArray::make(half, 0.0)
      let sin = FixedArray::make(half, 0.0)
      for k = 0; k < half; k = k + 1 {
        let angle = 2.0 * @math.PI * k.to_double() / n
        cos.unsafe_set(k, @math.cos(angle))
        sin.unsafe_set(k, @math.sin(angle))
      }
      let hann = FixedArray::make(win, 0.0)
      for k = 0; k < win; k = k + 1 {
        hann.unsafe_set(
          k,
          0.5 - 0.5 * @math.cos(2.0 * @math.PI * k.to_double() / n),
        )
      }
      let p : Plan = { rev, cos, sin, hann, }
      plans.unsafe_set(i, Some(p))
      i
    }
  }
}

///|
#export_name("dsp_plan_rev")
pub fn plan_rev_of(i : Int) -> FixedArray[Int] {
  match plan_at(i) {
    Some(p) => p.rev
    None => FixedArray::make(0, 0)
  }
}

///|
#export_name("dsp_plan_cos")
pub fn plan_cos_of(i : Int) -> FixedArray[Double] {
  match plan_at(i) {
    Some(p) => p.cos
    None => FixedArray::make(0, 0.0)
  }
}

///|
#export_name("dsp_plan_sin")
pub fn plan_sin_of(i : Int) -> FixedArray[Double] {
  match plan_at(i) {
    Some(p) => p.sin
    None => FixedArray::make(0, 0.0)
  }
}

///|
#export_name("dsp_plan_hann")
pub fn plan_hann_of(i : Int) -> FixedArray[Double] {
  match plan_at(i) {
    Some(p) => p.hann
    None => FixedArray::make(0, 0.0)
  }
}
