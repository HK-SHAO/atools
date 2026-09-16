# Verification

Every script runs under Bun. The browser checks look for Chrome / Chromium automatically; point at one with `CHROME=/path/to/browser` when they cannot find it.

| Command | What it does |
| --- | --- |
| `bun run test` | TypeScript, browser API adapters, and Wasm boundary tests |
| `bun run test:kernel` | MoonBit numeric kernel tests |
| `bun run quality -- --gate` | encoding and reconstruction quality gate on deterministic material |
| `bun run kernel` | real-time factor gate for the four complete numeric chains |
| `bun run bench:kernel:native` | MoonBit release/native micro-benchmarks |
| `bun run perf` | resampling cache against a per-sample computation |
| `bun run compare:librosa` | STFT numerics cross-checked against librosa 0.11.0 |
| `bun run compare:librosa:stft` | warmed-up `librosa.stft()` performance baseline |
| `bun run compare:librosa:phase` | PGHI+RTISI-LA against fast Griffin-Lim on real material |
| `bun run compare:librosa:phase-perf` | warmed-up librosa fast Griffin-Lim performance baseline |
| `bun run ui` | demo, playback, verify, fine render, and exact mode in Chrome |
| `bun run offline` | PWA install, update, cache isolation, and reload with the network gone |
| `bun run bench` | end-to-end evaluation of real audio through PNG, JPEG, and scaling |

`quality` and `kernel` need no browser. `ui` and `offline` read `dist/`, so run `bun run build:web` first.

`UI_BASELINE=/path/to/old/dist bun run ui` compares two builds. `SUBPATH=/sub/path bun run ui` verifies a subpath deployment. The end-to-end evaluation reads local audio under `docs/` by default, and accepts explicit material:

```sh
FILES='voice/greeting.mp3' \
CASES='[{"sr":8000,"bits":8,"fineness":1,"fmax":0,"mode":"exact","via":"jpeg"}]' \
bun run bench
```

For a numeric change, run the MoonBit tests, the quality gate, and the kernel performance gate first, then compare before and after with the same material and parameters. Phase reconstruction at short windows is sensitive to floating-point perturbation, so a small move on one clip proves nothing; conclusions have to come from a distribution over several clips. Metrics and algorithmic limits are in [algorithms.md](../docs/algorithms.md), build and offline rules in [build.md](../docs/build.md).

Numeric acceptance uses an independent naive DFT as the reference: FFT relative peak error within `1e-12`, per-sample inverse error within 8 ULP, and Hann squared-envelope ripple at a quarter-window shift below `1e-9`. A mathematical definition is the fixed oracle, which keeps a library upgrade from moving the gate; cross-checking against librosa means using the same periodic Hann, centering, and one-sided spectrum conventions.

The librosa comparison stays out of the default gates so no Python runtime is required. To reproduce, install `librosa==0.11.0` in an isolated environment and run with `PYTHON=/path/to/venv/bin/python`: `compare:librosa` for numerics, `compare:librosa:phase` for phase quality, and `bench:kernel:native` with `compare:librosa:stft` or `compare:librosa:phase-perf` for performance. Measure both sides alternately and keep the fastest value on each; never draw conclusions from Wasm numbers against librosa native numbers.

The phase quality comparison reads `app/assets/demo.ogg`, `fixtures/speech-nb.amr`, and `docs/audio-examples/love-story.m4a`; the third is local evaluation material kept out of the repository, and the script fails outright when it is missing.
