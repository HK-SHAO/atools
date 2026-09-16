import time

import librosa
import numpy as np


sr = 8000
win = 512
hop = 128
frames = 501
samples = (frames - 1) * hop
t = np.arange(samples) / sr
source = 0.6 * np.sin(2 * np.pi * 440 * t)
magnitude = np.abs(
    librosa.stft(
        source,
        n_fft=win,
        hop_length=hop,
        win_length=win,
        window="hann",
        center=True,
        pad_mode="constant",
    )[:, :frames]
)
args = dict(
    n_iter=8,
    hop_length=hop,
    win_length=win,
    n_fft=win,
    window="hann",
    center=True,
    length=samples,
    momentum=0.99,
    init="random",
    random_state=0,
)
librosa.griffinlim(magnitude, **args)
runs = []
for _ in range(10):
    before = time.perf_counter_ns()
    librosa.griffinlim(magnitude, **args)
    runs.append((time.perf_counter_ns() - before) / 1_000_000)
print(f"librosa {librosa.__version__} · Griffin-Lim · 501 frames · win 512 · 8 iterations")
print(f"best {min(runs):.2f} ms · mean {np.mean(runs):.2f} ms")
