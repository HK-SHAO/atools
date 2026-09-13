///|
/// Returns the host ABI version expected by the JavaScript loader.
#export_name("dsp_abi")
pub fn abi() -> Int {
  7
}

///|
let probe_n : Int = 8

///|
fn probe_seg(h : Int) -> (FixedArray[Double], FixedArray[Byte])? {
  if job_words_of(h) < probe_n || job_bytes_of(h) < probe_n {
    None
  } else {
    Some((job_d(h), job_b(h)))
  }
}

///|
/// Writes the kernel probe pattern into an open job arena.
#export_name("dsp_probe_stamp")
pub fn probe_stamp(h : Int) -> Int {
  match probe_seg(h) {
    None => 0
    Some((d, b)) => {
      for i = 0; i < probe_n; i = i + 1 {
        d.unsafe_set(i, (1000 + i).to_double())
        b.unsafe_set(i, (200 + i).to_byte())
      }
      1
    }
  }
}

///|
/// Checks that the kernel can read a probe pattern written by the host.
#export_name("dsp_probe_check")
pub fn probe_check(h : Int, want_d : Int, want_b : Int) -> Int {
  match probe_seg(h) {
    None => 0
    Some((d, b)) => {
      for i = 0; i < probe_n; i = i + 1 {
        if d.unsafe_get(i) != (want_d + i).to_double() {
          return 0
        }
        if b.unsafe_get(i).to_int() != ((want_b + i) & 0xff) {
          return 0
        }
      }
      1
    }
  }
}

///|
/// Returns a probe seed or the required probe length.
#export_name("dsp_probe_want")
pub fn probe_want(which : Int) -> Int {
  match which {
    0 => 1000
    1 => 200
    _ => probe_n
  }
}
