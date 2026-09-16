import time

import librosa
import numpy as np


rng = np.random.default_rng(1)
samples = rng.standard_normal(131072)
print(f"librosa {librosa.__version__} · 131072 samples · centered periodic Hann · ms")
for win in (256, 512, 1024, 2048, 4096):
    hop = win // 4
    frames = len(samples) // hop + 1
    output = np.empty((win // 2 + 1, frames), dtype=np.complex128, order="F")
    for _ in range(10):
        librosa.stft(
            samples,
            n_fft=win,
            hop_length=hop,
            win_length=win,
            window="hann",
            center=True,
            pad_mode="constant",
            out=output,
        )
    runs = []
    for _ in range(10):
        before = time.perf_counter_ns()
        librosa.stft(
            samples,
            n_fft=win,
            hop_length=hop,
            win_length=win,
            window="hann",
            center=True,
            pad_mode="constant",
            out=output,
        )
        runs.append((time.perf_counter_ns() - before) / 1_000_000)
    print(f"{win:4d}  {min(runs):.3f}")
