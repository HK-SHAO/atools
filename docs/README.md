---
name: atools-spectrum
description: Implement, integrate, test, or review the atools audio-to-spectrum-image format and its MoonBit/Wasm browser pipeline.
---

# atools Spectrum

Read only the documents needed for the task:

- Implement an encoder or decoder: [format-spec.md](format-spec.md)
- Change DSP or reconstruction: [algorithms.md](algorithms.md)
- Change Worker, Wasm, PWA, or module boundaries: [architecture.md](architecture.md)
- Check limits, quality, speed, or bundle size: [metrics.md](metrics.md)
- Build, deploy, or test offline behavior: [build.md](build.md)
- Run benchmarks or compare a baseline: [../bench/README.md](../bench/README.md)

Treat `format-spec.md` as the interoperability contract. Keep machine-dependent measurements in `metrics.md`. Run the narrowest relevant gate first, then the full CI sequence before release.
