import json
import sys

import librosa
import numpy as np


def relative_peak(a, b):
    return float(np.max(np.abs(a - b)) / np.max(np.abs(b)))


def relative_rms(a, b):
    return float(np.linalg.norm(a - b) / np.linalg.norm(b))


payload = json.load(sys.stdin)
x = np.asarray(payload["samples"], dtype=np.float64)
rows = []

for case in payload["cases"]:
    win = case["win"]
    hop = win // 4
    expected = librosa.stft(
        x,
        n_fft=win,
        hop_length=hop,
        win_length=win,
        window="hann",
        center=True,
        pad_mode="constant",
    ).T
    actual = (np.asarray(case["re"]) + 1j * np.asarray(case["im"])).reshape(
        expected.shape
    )
    restored = librosa.istft(
        expected.T,
        hop_length=hop,
        win_length=win,
        window="hann",
        center=True,
        length=len(x),
    )
    ours = np.asarray(case["restored"])
    rows.append(
        {
            "win": win,
            "stft_peak": relative_peak(actual, expected),
            "stft_rms": relative_rms(actual, expected),
            "atools_roundtrip": relative_peak(ours, x),
            "librosa_roundtrip": relative_peak(restored, x),
            "inverse_cross": relative_peak(ours, restored),
        }
    )

json.dump({"librosa": librosa.__version__, "rows": rows}, sys.stdout)
