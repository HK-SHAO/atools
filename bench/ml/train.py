# 训练小型相位修正网络：输入（损伤 cos/sin、幅度、置信度）的 7×7 时频 patch，
# 输出该 bin 的干净相位单位矢量。数据由 bench DATA 模式经真实管线转储。
# 用法：python train.py [--data ../.data] [--out weights.json] [--epochs 10]
import argparse, glob, json, os, struct, sys
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

VAL_FILES = {"voice_hurt-1", "ra2_iconsea", "audio-examples_popipo"}
PATCH = 7
PAD = PATCH // 2
CH = 6  # damCos, damSin, lv, w, f位置, b位置

def load(path):
    b = open(path, "rb").read()
    frames, bins, win, hop, sr, bits, exact = struct.unpack_from("<7I", b, 0)
    n = frames * bins
    off = 40
    lv = np.frombuffer(b, np.uint16, n, off); off += n * 2
    dc = np.frombuffer(b, np.uint8, n, off); off += n
    ds = np.frombuffer(b, np.uint8, n, off); off += n
    w = np.frombuffer(b, np.uint8, n, off); off += n
    tc = np.frombuffer(b, np.uint8, n, off); off += n
    ts = np.frombuffer(b, np.uint8, n, off); off += n
    F_, B_ = frames, bins
    lv = lv.reshape(F_, B_).astype(np.float32) / 65535
    dc = dc.reshape(F_, B_).astype(np.float32) / 127.5 - 1
    ds = ds.reshape(F_, B_).astype(np.float32) / 127.5 - 1
    w = w.reshape(F_, B_).astype(np.float32) / 127.5 - 1
    tc = tc.reshape(F_, B_).astype(np.float32) / 127.5 - 1
    ts = ts.reshape(F_, B_).astype(np.float32) / 127.5 - 1
    tn = np.hypot(tc, ts)
    ok = tn > 1e-6
    tc = np.where(ok, tc / np.maximum(tn, 1e-9), 0).astype(np.float32)
    ts = np.where(ok, ts / np.maximum(tn, 1e-9), 0).astype(np.float32)
    # 绝对位置通道：相位帧间推进 2π·hop·b/win 逐 bin 不同，网络需要频率坐标
    fb = (np.arange(B_) / max(B_ - 1, 1) * 2 - 1).astype(np.float32)[None, :].repeat(F_, 0)
    ft = (np.arange(F_) / max(F_ - 1, 1) * 2 - 1).astype(np.float32)[:, None].repeat(B_, 1)
    return dict(name=os.path.basename(path)[:-4], x=np.stack([dc, ds, lv * 2 - 1, w, fb, ft]), lv=lv,
                t=np.stack([tc, ts]), F=F_, B=B_)

def gather_patch(d, fc, bc, patch=PATCH):
    # 边界 clamp 的 patch×patch patch，返回 [N,CH,patch,patch]
    F_, B_ = d["F"], d["B"]
    P = patch // 2
    fi = np.clip(fc[:, None] + np.arange(-P, P + 1)[None, :], 0, F_ - 1)
    bi = np.clip(bc[:, None] + np.arange(-P, P + 1)[None, :], 0, B_ - 1)
    out = np.empty((len(fc), CH, patch, patch), np.float32)
    for c in range(CH):
        out[:, c] = d["x"][c][fi[:, :, None], bi[:, None, :]]
    return out

class Net(nn.Module):
    def __init__(self, patch=7, width=32):
        super().__init__()
        self.patch = patch
        c = patch // 2
        self.c1 = nn.Conv2d(CH, width, 5)      # patch → patch-4
        self.c2 = nn.Conv2d(width, width, 3)   # → patch-6
        self.fc = nn.Linear(width * (patch - 6) ** 2, 2)
        assert (patch - 6) % 2 == 1 or True
        self.ci = c  # 中心索引
    def forward(self, x):
        h = F.relu(self.c1(x))
        h = F.relu(self.c2(h))
        d = self.fc(h.flatten(1))
        cc = self.patch // 2
        base = torch.stack([x[:, 0, cc, cc], x[:, 1, cc, cc]], 1)  # patch 中心的损伤矢量
        return F.normalize(base + d, dim=1)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(os.path.dirname(__file__), "..", ".data"))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "weights.json"))
    ap.add_argument("--epochs", type=int, default=16)
    ap.add_argument("--per-pair", type=int, default=2000, help="每对每epoch采样patch数")
    ap.add_argument("--batch", type=int, default=4096)
    ap.add_argument("--patch", type=int, default=7)
    ap.add_argument("--width", type=int, default=32)
    args = ap.parse_args()

    pairs = [load(p) for p in sorted(glob.glob(os.path.join(args.data, "*.bin")))]
    train = [d for d in pairs if d["name"].rsplit(".", 1)[0] not in VAL_FILES]
    val = [d for d in pairs if d["name"].rsplit(".", 1)[0] in VAL_FILES]
    print(f"train {len(train)} 对, val {len(val)} 对")

    torch.manual_seed(0)
    net = Net(patch=args.patch, width=args.width)
    n_par = sum(p.numel() for p in net.parameters())
    print(f"参数 {n_par} ({n_par * 4 / 1024:.0f}KB fp32)")
    opt = torch.optim.Adam(net.parameters(), lr=1e-3)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, args.epochs)
    rng = np.random.default_rng(0)

    def circ_err_deg(d, batch=65536):
        # 全网格加权圆误差
        net.eval()
        errs = []
        with torch.no_grad():
            for s in range(0, d["F"] * d["B"], batch):
                n = min(batch, d["F"] * d["B"] - s)
                fc = np.arange(s, s + n) // d["B"]
                bc = np.arange(s, s + n) % d["B"]
                x = torch.from_numpy(gather_patch(d, fc, bc, net.patch))
                p = net(x).numpy()
                dot = np.clip(p[:, 0] * d["t"][0].ravel()[s:s+n] + p[:, 1] * d["t"][1].ravel()[s:s+n], -1, 1)
                errs.append(np.arccos(dot))
        e = np.concatenate(errs)
        wt = d["lv"].ravel() ** 2
        return float(np.sqrt(np.mean(wt * e ** 2) / np.mean(wt)) * 180 / np.pi)

    def base_err(d):
        x0, x1 = d["x"][0].ravel(), d["x"][1].ravel()
        dot = np.clip(x0 * d["t"][0].ravel() + x1 * d["t"][1].ravel(), -1, 1)
        wt = d["lv"].ravel() ** 2
        return float(np.sqrt(np.mean(wt * np.arccos(dot) ** 2) / np.mean(wt)) * 180 / np.pi)

    for ep in range(args.epochs):
        net.train()
        tot, cnt = 0.0, 0
        rng.shuffle(train)
        for d in train:
            n = d["F"] * d["B"]
            k = min(args.per_pair, n)
            idx = rng.choice(n, k, replace=False)
            fc, bc = idx // d["B"], idx % d["B"]
            x = torch.from_numpy(gather_patch(d, fc, bc, net.patch))
            t = torch.from_numpy(np.stack([d["t"][0][fc, bc], d["t"][1][fc, bc]], 1))
            w = d["lv"][fc, bc] ** 2
            wgt = torch.from_numpy(w / max(w.mean(), 1e-12))
            for s in range(0, k, args.batch):
                xb, tb, wb = x[s:s+args.batch], t[s:s+args.batch], wgt[s:s+args.batch]
                p = net(xb)
                loss = (wb * (1 - (p * tb).sum(1))).mean()
                opt.zero_grad(); loss.backward(); opt.step()
                tot += float(loss) * len(xb); cnt += len(xb)
        sched.step()
        msg = f"ep{ep:02d} loss {tot/max(cnt,1):.4f}"
        if ep % 4 == 3 or ep == args.epochs - 1:
            per = {}
            for d in val:
                via = d["name"].rsplit(".", 1)[1]
                per.setdefault(via, []).append((base_err(d), circ_err_deg(d)))
            msg += "  val " + "  ".join(
                f"{v}: {np.mean([b for b, _ in vs]):.0f}°→{np.mean([a for _, a in vs]):.0f}°" for v, vs in sorted(per.items()))
        print(msg, flush=True)

    wts = {"c1w": net.c1.weight.detach().numpy().round(5).tolist(),
           "c1b": net.c1.bias.detach().numpy().round(5).tolist(),
           "c2w": net.c2.weight.detach().numpy().round(5).tolist(),
           "c2b": net.c2.bias.detach().numpy().round(5).tolist(),
           "fcw": net.fc.weight.detach().numpy().round(5).tolist(),
           "fcb": net.fc.bias.detach().numpy().round(5).tolist(),
           "patch": PATCH, "width": args.width}
    json.dump(wts, open(args.out, "w"))
    print(f"导出 {args.out} ({os.path.getsize(args.out)/1024:.0f}KB)")

if __name__ == "__main__":
    main()
