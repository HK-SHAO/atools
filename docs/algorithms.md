# Algorithms and Quality

Format fields, pixel layout, and the ticket bitstream are in [format-spec.md](format-spec.md). This document covers the trade-offs in the current algorithms, the known boundaries, and the verification methods.

## Encoding

The input is converted to mono and resampled, then transformed with a Hann-window STFT. `hop = win / 4`, and the window length may be 256, 512, 1024, 2048, or 4096. Four-fold overlap governs image size and the phase reconstruction constraint at the same time; two-fold overlap damages the envelope of long windows, and eight-fold overlap grows the image.

Magnitude is mapped to bytes in dB. Compact mode then quantizes to 2, 4, or 8 bit; the bit depth changes the effective number of steps, not the in-memory element type. Exact mode uses a fixed 120 dB scale and stores phase as `cos(φ)` and `sin(φ)`, which avoids the discontinuity that a wrapped angle produces at the 2π boundary.

The image is bounded by two limits:

- 16 million pixels, which bounds time and memory cost.
- 65535 pixels per side, which avoids the silent-failure range of the browser canvas.

The encoder uses one geometry function to choose the highest configuration that fits the input. The approximate pixel count is `samples × overlap / 2`, independent of window length; short windows hit the width limit sooner, and long windows suit long audio better.

## Restoration

| Input | Default path |
| --- | --- |
| Reliable phase | Direct inverse STFT |
| No phase or weak phase | PGHI initialization → RTISI-LA, 8 iterations |
| User selects refinement | RTISI-LA 16 iterations → anchored Griffin–Lim with a budget cap |

The direct inverse transform keeps the phase from the original PNG and is the best path for a reversible image. Continuing to iterate on reliable phase reduces waveform consistency.

A compact image has lost its phase, so any algorithm can only look for a waveform consistent with the magnitude spectrum. PGHI supplies a deterministic initial phase, and RTISI-LA uses per-frame lookahead to reduce clicks. Refinement mainly lowers spectral error and does not guarantee better correlation with the original waveform.

At low bit depths the lowest quantization step means below threshold, not that the magnitude equals the step center. Reconstruction relaxes only the lower bound of that step, which avoids laying down an artificial noise floor; 8 bit has enough dynamic range and keeps the original path unchanged.

Weak phase enters Griffin–Lim as a per-bin weighted prior. JPEG phase perturbation usually keeps the direction, while rescaling mixes adjacent phases and destroys the direction quickly, so the reader combines the ticket dimensions and the mean phase vector length to decide between direct use, weak anchor, or discarding the phase. The exact thresholds belong to the format read policy and are in [format-spec.md](format-spec.md).

## Boundary with librosa

librosa is a Python audio analysis library; this project is a browser product and a transmissible sound-image format. The two overlap on STFT, resampling, and phase reconstruction, but neither replaces the other.

librosa suits research analysis, batch processing, MIR feature engineering, and Python integration; this project handles PNG encoding, Exact phase, parameter and ticket recovery, degraded-image fallback, and offline interaction. A compatible implementation written with librosa still has to implement the [format spec](format-spec.md). For same-convention STFT/ISTFT comparison see the [quantitative data](metrics.md#librosa-cross-check).

Phase reconstruction is compared at equal magnitude spectrum and iteration count, but PGHI+RTISI-LA and Griffin-Lim are not the same algorithm. A comparison on three real clips shows that after aligning the initial values the two iteration schemes differ in spectral convergence by no more than `1.7 dB`, while a random initial value differs from this project's default by more than `10.7 dB`: most of that gap comes from the PGHI initial value, not from the iteration scheme. Quality has to be read from spectral convergence, LSD, envelope, and correlation together; performance compares only the complete default scheme at equal frame counts. Method and data are in the [phase reconstruction data](metrics.md#phase-reconstruction).

## Measured Boundaries

An original Exact PNG stays close to the original waveform; JPEG perturbs the phase and rescaling mixes adjacent phases. Compact mode targets size and audibility and makes no promise about the original waveform. Quality, speed, and capacity are in the [quantitative data](metrics.md).

Short-window RTISI is sensitive to floating-point perturbation: a single input value differing by 1 ulp can converge to another valid waveform. Numeric changes therefore have to compare distributions over multiple clips, spectral error, and envelope; a correlation rise or fall on a single clip is not a conclusion. The reversible path instead requires sample-exact or byte-exact equality.

## Audio Decoding and Resampling

The browser tries `decodeAudioData` first and, on failure, picks a Wasm decoder from the container signature. Ogg distinguishes Opus from Vorbis by the first packet. WAV, FLAC, Ogg, Opus, and MP3 expose the sample rate from the container; M4A does not create a decoding context from it, because HE-AAC entries may report only the core sample rate.

Native decoding uses `OfflineAudioContext`, which keeps a device context from resampling the clip implicitly and keeps the first device-context creation from blocking decoding. The `AudioContext` needed for playback is created ahead of time once the clip is ready, overlapping Worker computation.

The band-limited resampler caches tap weights for identical output phases. The cache is capped by both entry count and 4 MB of memory; output is bit-identical to per-sample computation. `bun run perf` requires the cached path to be faster across every tested sample-rate combination.

## Worker and MoonBit Boundary

Decoded PCM stays on the main thread for playback, and most of the remaining headless pipeline runs in a Worker: resampling, STFT, quantization, image codec, phase reconstruction, and quality measurement. Result buffers transfer ownership; request buffers still used for interface playback stay on the main thread.

The MoonBit kernel handles hot, shape-stable work that can run to completion in one linear memory block: FFT, STFT frame operations, PGHI, RTISI-LA, and the ticket. Image DOM, Web Audio, format routing, and low-frequency control logic stay in TypeScript. This boundary avoids adding cross-thread copies, object lifetimes, or a second set of business rules for a few milliseconds of gain.

Kernel hot loops use unchecked access that Plan, Slot, and Job capacity already prove safe. White-box tests cover the FFT round trip, Parseval, plan dimensions, and pool lifetime. The host re-acquires array views after any operation that may grow linear memory.

Long computations yield the Worker message loop about every 12 ms through a one-shot `MessageChannel`, so cancellation and progress events are handled promptly. The channel is closed as soon as it completes, which keeps it from holding the Bun or browser event loop active.

## Performance and Verification

`bun run kernel` requires the complete numeric chain below `0.05×` real time. Absolute times vary by machine; the [quantitative data](metrics.md) records the results in this run environment.

The minimum verification set before release:

```sh
bun run typecheck
bun run lint
bun run test
bun run test:kernel
bun run moon:ports
bun run moon:fmt
bun run quality -- --gate
bun run kernel
bun run perf
bun run build:web
bun run ui
bun run offline
```

The complete chain on real clips through PNG, JPEG, and rescaling is covered by `bun run bench`. Commands, parameters, and the baseline comparison method are in [bench/README.md](../bench/README.md).
