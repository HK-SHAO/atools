# Measurements

Recorded 2026-09-16. Quality cases use fixed signals or real material; performance numbers come from the current development machine, take the fastest value after warm-up, and the phase-reconstruction table is measured alternately on both sides. Commands and thresholds live in the repository.

## Capacity

| Item | Limit |
| --- | ---: |
| Input file | 64 MiB |
| Image processing canvas | 24 million pixels, 65535 px per side; larger images are scaled down first |
| Output image | 16 million pixels, 65535 px per side |
| Audio | 8 million samples |
| FFT window length | 256, 512, 1024, 2048, 4096 |
| PNG magnitude bit depth | 2, 4, 8 bit; Exact uses 8 bit magnitude and two 8 bit phase components |

## Numeric error

`bun run test:kernel` checks the MoonBit kernel against an independent naive DFT and against analytic properties.

| Check | Threshold |
| --- | ---: |
| 256-point FFT against a naive DFT, relative peak error | `≤ 1e-12` |
| IFFT after FFT, per-sample error | `≤ 8 ULP` |
| Hann symmetry error | `< 1e-12` |
| Hann² overlap envelope ripple at `hop=win/4` | `< 1e-9` |

## librosa cross-check

`bun run compare:librosa` pins librosa 0.11.0 and compares window by window over 8192 deterministic samples. Both sides use a periodic Hann window, `hop=win/4`, centering, and a one-sided complex spectrum.

| Metric | Worst value across the five window lengths |
| --- | ---: |
| Complex STFT relative peak error | `6.14e-16` |
| Complex STFT relative RMS error | `5.92e-16` |

The STFT difference sits at the Float64 rounding limit.

The performance comparison runs a full STFT: 131072 samples, periodic Hann, `hop=win/4`, centering, one-sided complex spectrum, and preallocated output. MoonBit runs release/native; the other side calls `librosa.stft()` directly. Both are warmed up and the minimum is taken. The test machine is an Apple M4; lower is faster.

| Window | MoonBit native | librosa | MoonBit / librosa |
| ---: | ---: | ---: | ---: |
| 256 | 2.41 ms | 1.15 ms | 2.10× |
| 512 | 2.69 ms | 1.23 ms | 2.18× |
| 1024 | 2.98 ms | 1.26 ms | 2.37× |
| 2048 | 3.19 ms | 1.39 ms | 2.29× |
| 4096 | 3.54 ms | 1.48 ms | 2.39× |

On this shared numeric chain librosa is 2.10–2.39× faster. The table measures the ceiling of the MoonBit native kernel; the browser product runs Wasm. It excludes this project's quantization, PNG, restoration, and interaction, and says nothing about end-to-end product performance.

### Phase reconstruction

`bun run compare:librosa:phase` takes 2.5 seconds from each of three real clips: `app/assets/demo.ogg` at 4 s, `fixtures/speech-nb.amr` at 6 s, and `docs/audio-examples/love-story.m4a` at 30 s. All clips are resampled to 8 kHz, compared at `win=512`, `hop=128`, and 8 iterations, with both sides handed the same exact magnitude spectrum so only phase is reconstructed. Higher correlation and envelope are better; lower LSD and spectral convergence are better.

| Clip | Method | Correlation | SNR dB | LSD dB | Spectral convergence dB | Envelope |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| demo | PGHI+RTISI-LA | 0.303 | -1.44 | 2.22 | -28.86 | 0.990 |
| demo | RTISI-LA zero init | 0.370 | -1.00 | 2.80 | -25.04 | 0.991 |
| demo | Griffin-Lim random init | 0.354 | -1.07 | 3.26 | -16.97 | 0.968 |
| demo | Griffin-Lim PGHI init | 0.291 | -1.51 | 2.04 | -29.43 | 0.990 |
| speech | PGHI+RTISI-LA | 0.449 | -0.42 | 1.92 | -32.12 | 0.993 |
| speech | RTISI-LA zero init | 0.375 | -0.97 | 2.36 | -29.73 | 0.977 |
| speech | Griffin-Lim random init | 0.242 | -1.73 | 2.91 | -14.67 | 0.964 |
| speech | Griffin-Lim PGHI init | 0.439 | -0.50 | 1.76 | -32.85 | 0.995 |
| music | PGHI+RTISI-LA | 0.422 | -0.61 | 2.21 | -25.04 | 0.994 |
| music | RTISI-LA zero init | 0.416 | -0.64 | 2.60 | -17.91 | 0.968 |
| music | Griffin-Lim random init | 0.259 | -1.64 | 3.41 | -14.34 | 0.948 |
| music | Griffin-Lim PGHI init | 0.378 | -0.92 | 1.91 | -26.73 | 0.995 |

`Griffin-Lim random init` is the `librosa.griffinlim()` default (`random_state=0`); `Griffin-Lim PGHI init` uses the same update rule with a different initial guess, and the reproduction drift stays within `6.1e-15`. `RTISI-LA zero init` skips PGHI and uses only the kernel's own start-up phase.

Against librosa's default path, this project's default is better on LSD, spectral convergence, and envelope for all three clips; on waveform correlation it wins two of three, with `0.354` against `0.303` on the demo clip. Quadrupling the iteration budget (32 iterations) brings librosa's default spectral convergence to `-26.25`, `-28.14`, `-17.23`, still short of this project's `-28.86`, `-32.12`, `-25.04` at 8 iterations.

Once the initial guess is aligned, the LSD gap is within `0.3 dB` and the spectral convergence gap within `1.7 dB`, with correlation going either way; the gap between a random initial guess and this project's default is over `10.7 dB` of spectral convergence. That gap comes mainly from the PGHI initial guess rather than from the iteration scheme, and RTISI-LA has no consistent advantage over Griffin-Lim given the same initial guess. Waveform correlation is sensitive to phase-equivalent solutions and cannot stand in for listening.

The RMS gap between output and reference stays within `0.17 dB` for all three clips, so the spectral convergence column compares phase rather than level. With a true phase for the same magnitude spectrum all three clips score `1.000` correlation, `0.00` LSD, and `0.00 dB` gain; the benchmark asserts that row at runtime and fails when it does not hold.

Performance uses 501 frames, a 512-point window, and 8 iterations. MoonBit release/native takes 8.17 ms for PGHI and 37.10 ms for RTISI-LA, 45.27 ms together; warmed-up librosa fast Griffin-Lim takes 23.49 ms at the same frame count and budget, so this project is `1.93×` slower. Both sides were measured alternately and keep their fastest value. The two initialize differently, so the comparison covers the full default pipeline at one input size and budget rather than step-by-step micro-benchmarks.

## Reconstruction quality

`bun run quality -- --gate` generates 2.5 seconds of audio for each of voice, music, and a transient/noise mix. The table holds the results of one run.

| Signal | Mode | Correlation | SNR dB | Spectral convergence dB | LSD dB | Envelope correlation |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| voice | exact 8k | 1.000 | 42.5 | -44.0 | 0.2 | 1.000 |
| music | exact 8k | 1.000 | 41.8 | -43.4 | 0.4 | 1.000 |
| harsh | exact 8k | 1.000 | 41.9 | -43.1 | 0.4 | 1.000 |
| voice | compact 8k 8bit | 0.272 | -1.6 | -18.9 | 3.2 | 0.989 |
| music | compact 8k 8bit | 0.674 | 2.2 | -22.9 | 2.2 | 0.886 |
| harsh | compact 8k 8bit | 0.101 | -1.0 | -8.3 | 2.4 | 0.990 |
| music | compact 8k 4bit | 0.533 | 0.8 | -9.9 | 16.2 | 0.664 |

Compact stores no phase. The correlation coefficient measures waveform agreement, while LSD and envelope correlation add spectral and time-domain envelope information.

The real image chain uses 6 clips, the first 8 seconds of each. `bun run bench` covers PNG, JPEG, and a scaled read-back.

| Mode | Image path | Median correlation | Median LSD |
| --- | --- | ---: | ---: |
| Compact 8 kHz / 4 bit / win 256 | PNG | 0.466 | 10.2 |
| Compact 8 kHz / 8 bit / win 512 | PNG | 0.299 | 3.5 |
| Exact / source rate / win 512 | PNG | 1.000 | 0.3 |
| Exact / source rate / win 512 | JPEG | 0.745 | 4.2 |
| Exact / source rate / win 512 | 0.75× scale | 0.112 | 4.5 |

## Speed

`bun run kernel` processes 30 seconds of fixed material at 44.1 kHz, including resampling, encoding, and restoration. The threshold is `0.05×` real time.

| Case | Total | Real-time factor |
| --- | ---: | ---: |
| win 256 | 234.4 ms | 0.008× |
| win 512 | 172.6 ms | 0.006× |
| win 1024 | 171.9 ms | 0.006× |
| win 2048 | 171.1 ms | 0.006× |
| win 4096 | 172.1 ms | 0.006× |
| Exact / win 1024 | 49.2 ms | 0.002× |

`bun run perf` exercises the resampling cache with 60 seconds at 44.1 kHz, 2.646 million samples. Output at 8/16/48 kHz is 6.9×, 5.6×, and 5.2× faster than a per-sample computation; the test combination with the most distinct phases runs 4.27× to 5.66×.

## Reproducing

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
bun run test:kernel
bun run compare:librosa # the four librosa comparisons need librosa==0.11.0 in a Python environment
bun run compare:librosa:stft
bun run compare:librosa:phase
bun run compare:librosa:phase-perf
bun run bench:kernel:native # the MoonBit side of the phase and STFT performance tables
bun run quality -- --gate
bun run kernel
bun run perf
bun run build:web
bun run ui
bun run offline
```

`bun run bench` reads local real audio, and the phase-reconstruction comparison also reads local material under `docs/audio-examples`. Material selection and case parameters are in [`bench/README.md`](../bench/README.md).
