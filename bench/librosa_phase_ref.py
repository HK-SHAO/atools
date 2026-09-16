import json
import sys

import librosa
import numpy as np
from librosa import util


MOMENTUM = 0.99


def window_args(case):
    return dict(
        n_fft=case["win"],
        hop_length=case["hop"],
        win_length=case["win"],
        window="hann",
        center=True,
    )


def fast_gl(magnitude, angles, case, n_iter):
    eps = util.tiny(np.complex128)
    tprev = None
    for _ in range(n_iter):
        inverse = librosa.istft(angles, length=case["samples"], **window_args(case))
        rebuilt = librosa.stft(inverse, pad_mode="constant", **window_args(case))
        angles = rebuilt
        if tprev is not None:
            angles = angles - (MOMENTUM / (1 + MOMENTUM)) * tprev
        angles = angles / (np.abs(angles) + eps)
        angles = angles * magnitude
        rebuilt, tprev = tprev, rebuilt
    return librosa.istft(angles, length=case["samples"], **window_args(case))


payload = json.load(sys.stdin)
rows = []
for case in payload["cases"]:
    frames = case["frames"]
    bins = case["bins"]
    magnitude = np.asarray(case["magnitude"], dtype=np.float64).reshape(frames, bins).T
    phase = np.asarray(case["phase"], dtype=np.float64).reshape(frames, bins).T
    seed = np.exp(1j * 2 * np.pi * np.random.RandomState(seed=0).random(size=magnitude.shape))
    official = librosa.griffinlim(
        magnitude,
        n_iter=case["iters"][0],
        init="random",
        random_state=0,
        momentum=MOMENTUM,
        length=case["samples"],
        **window_args(case),
    )
    drift = np.abs(fast_gl(magnitude, seed * magnitude, case, case["iters"][0]) - official)
    drift = float(drift.max() / np.abs(official).max())
    if drift > 1e-6:
        raise SystemExit(f"{case['name']} 复现的 Griffin-Lim 与 librosa 不一致：{drift}")

    runs = []
    for n_iter in case["iters"]:
        random = (
            official
            if n_iter == case["iters"][0]
            else fast_gl(magnitude, seed * magnitude, case, n_iter)
        )
        runs.append(
            {
                "iters": n_iter,
                "random": random.tolist(),
                "warm": fast_gl(magnitude, np.exp(1j * phase) * magnitude, case, n_iter).tolist(),
            }
        )
    rows.append({"name": case["name"], "drift": drift, "runs": runs})

json.dump({"librosa": librosa.__version__, "rows": rows}, sys.stdout)
