// Engine-level handshake.
//
// Exactly one convention crosses the language boundary, and it is not documented behaviour of
// the toolchain: an exported function that returns a `FixedArray` hands the host the address of
// its data area. White-box tests cannot prove it (both sides are the same memory), so the proof
// lives on the side that consumes it: boot stamps a pattern and the host reads it back through
// two views, then the host writes and the kernel reads back. See moon/README.md.

///|
/// Kernel ABI revision, compared during the host handshake.
///
/// @return Current revision. The host must refuse to start on a mismatch: a build/loader
/// mismatch otherwise shows up as plausible but wrong numbers.
#export_name("dsp_abi")
pub fn abi() -> Int {
  7
}

///|
/// Probe length in elements, shared by both probe directions.
let probe_n : Int = 8

///|
/// A job's two segments, or `None` when the handle is invalid or a segment is shorter than a probe.
fn probe_seg(h : Int) -> (FixedArray[Double], FixedArray[Byte])? {
  if job_words_of(h) < probe_n || job_bytes_of(h) < probe_n {
    None
  } else {
    Some((job_d(h), job_b(h)))
  }
}

///|
/// Stamps a verifiable pattern into both segments of a job, for the host to read back.
///
/// @return 1 on success; 0 if the handle is invalid or either segment is too small.
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
/// Reads both segments back and checks them against the host-written baselines.
///
/// @param want_d Expected base of the double segment: element `i` must equal `want_d + i`.
/// @param want_b Expected base byte of the byte segment.
/// @return 1 if both segments match; 0 on any mismatch, an invalid handle, or a short segment.
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
/// Kernel-side probe pattern, for the host to check the kernel-to-host direction.
///
/// @param which 0 = double-segment base, 1 = byte-segment base.
/// @return The requested base; the probe length for any other value.
#export_name("dsp_probe_want")
pub fn probe_want(which : Int) -> Int {
  match which {
    0 => 1000
    1 => 200
    _ => probe_n
  }
}
