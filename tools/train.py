"""Training pipeline for the 8x8 / 10-mine Minesweeper policy.

Strategy: behaviour cloning of a deterministic constraint solver, followed by
optional self-play reinforcement fine-tuning. The network is a small fully
convolutional (spatially tied) net so it generalises across board positions and
stays tiny (< ~100 KB) for on-device inference.

Reproducible commands (CPU only):

    python3 tools/train.py --stage m0 --out models/policy-m0.onnx
    python3 tools/train.py --stage m1 --out models/policy-m1.onnx
    python3 tools/train.py --stage m2 --out models/policy-m2.onnx

Each command is fully seeded; rerunning reproduces the same weights.
"""

from __future__ import annotations

import argparse
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from mines import (
    N,
    Game,
    MINES,
    encode_state,
    guess_probabilities,
    infer,
)
from export_onnx import export_model, validate_onnx


# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

class PolicyNet(nn.Module):
    """Fully-convolutional logits head: [B,8,8,8] NCHW -> [B,64] logits."""

    def __init__(self, width: int = 32):
        super().__init__()
        self.conv1 = nn.Conv2d(8, width, 3, padding=1)
        self.conv2 = nn.Conv2d(width, width, 3, padding=1)
        self.conv3 = nn.Conv2d(width, 16, 3, padding=1)
        self.head = nn.Conv2d(16, 1, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h = F.relu(self.conv1(x))
        h = F.relu(self.conv2(h))
        h = F.relu(self.conv3(h))
        logits = self.head(h)  # [B,1,8,8]
        return logits.reshape(logits.shape[0], N)


# ---------------------------------------------------------------------------
# Demonstration generation (behaviour cloning targets)
# ---------------------------------------------------------------------------

def _uniform_target(cells) -> np.ndarray:
    t = np.zeros(N, dtype=np.float32)
    for c in cells:
        t[c] = 1.0
    s = t.sum()
    if s > 0:
        t /= s
    return t


def generate_demos(use_subset: bool, n_games: int, seed0: int, max_steps: int = 300):
    X, Y = [], []
    wins = 0
    for g in range(n_games):
        game = Game(seed0 + g)
        steps = 0
        while not game.over and steps < max_steps:
            steps += 1
            legal = game.legal_mask()
            if not any(legal):
                break
            feats = game.features()
            safe, mines = infer(game.revealed, game.flagged, game.counts, use_subset=use_subset)
            safe = [c for c in safe if legal[c]]
            if safe:
                X.append(feats)
                Y.append(_uniform_target(safe))
                game.reveal(min(safe))
            elif mines:
                new = [c for c in mines if not game.flagged[c]]
                if not new:
                    # Nothing new to flag; fall through to a guess.
                    probs = guess_probabilities(game.revealed, game.flagged, game.counts)
                    best = min((i for i in range(N) if legal[i]), key=lambda i: (probs[i], i))
                    X.append(feats)
                    Y.append(_uniform_target([best]))
                    game.reveal(best)
                else:
                    for c in new:
                        game.toggle_flag(c)
            else:
                probs = guess_probabilities(game.revealed, game.flagged, game.counts)
                best = min((i for i in range(N) if legal[i]), key=lambda i: (probs[i], i))
                X.append(feats)
                Y.append(_uniform_target([best]))
                game.reveal(best)
        if game.won:
            wins += 1
    return (
        np.asarray(X, dtype=np.float32),
        np.asarray(Y, dtype=np.float32),
        wins / max(1, n_games),
    )


# ---------------------------------------------------------------------------
# Training / evaluation helpers
# ---------------------------------------------------------------------------

def masked_log_softmax(logits: torch.Tensor, feats: torch.Tensor) -> torch.Tensor:
    # Channel 0 of the feature tensor is exactly the legal mask.
    mask = feats[:, 0].reshape(-1, N)
    neg = (1.0 - mask) * -1e9
    return F.log_softmax(logits + neg, dim=1)


def play_game(net: nn.Module, seed: int, max_steps: int = 300) -> str:
    game = Game(seed)
    steps = 0
    while not game.over and steps < max_steps:
        steps += 1
        state = game.state()
        feats = encode_state(state["hidden"], state["revealed"], state["flagged"], state["counts"])
        mask = np.array(game.legal_mask(), dtype=np.float32)
        with torch.no_grad():
            xt = torch.from_numpy(feats).reshape(1, 8, 8, 8)
            logits = net(xt).numpy()[0]
        logits = logits + (1.0 - mask) * -1e9
        action = int(np.argmax(logits))
        game.reveal(action)
    return "win" if game.won else "loss"


def quick_win_rate(net: nn.Module, seeds) -> float:
    wins = 0
    for s in seeds:
        if play_game(net, s) == "win":
            wins += 1
    return wins / len(seeds)


def train(stage: str, out: str, games: int, epochs: int, width: int, lr: float,
          seed: int, batch: int, use_subset: bool, val_games: int,
          threads: int, val_every: int) -> None:
    torch.set_num_threads(max(1, threads))
    torch.manual_seed(seed)
    np.random.seed(seed)

    if stage == "m0":
        net = PolicyNet(width=width)
        with torch.no_grad():
            for p in net.parameters():
                p.zero_()
        export_model(net, out)
        info = validate_onnx(out, net)
        print(f"[m0] baseline (uniform logits) exported -> {out} ({info['size_mb']} MB)")
        return

    t0 = time.time()
    X, Y, solver_wr = generate_demos(use_subset, games, seed0=1000 + seed, max_steps=400)
    print(f"[{stage}] demos: {X.shape[0]} states  (solver win rate on gen games: {solver_wr:.3f}) "
          f"in {time.time() - t0:.1f}s")

    net = PolicyNet(width=width)
    opt = torch.optim.AdamW(net.parameters(), lr=lr, weight_decay=1e-4)
    Xt = torch.from_numpy(X)
    Yt = torch.from_numpy(Y)
    n = X.shape[0]
    gen = torch.Generator().manual_seed(seed)

    for epoch in range(epochs):
        perm = torch.randperm(n, generator=gen)
        net.train()
        total = 0.0
        for i in range(0, n, batch):
            idx = perm[i:i + batch]
            xb = Xt[idx].reshape(-1, 8, 8, 8)
            yb = Yt[idx]
            logits = net(xb)
            logp = masked_log_softmax(logits, xb)
            loss = -(yb * logp).sum(dim=1).mean()
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += float(loss.detach()) * len(idx)
        last = (epoch + 1) == epochs
        if last or (epoch + 1) % val_every == 0:
            val_seeds = list(range(500000, 500000 + val_games))
            wr = quick_win_rate(net, val_seeds)
            print(f"[{stage}] epoch {epoch + 1:2d}/{epochs}  loss={total / n:.4f}  val_win_rate={wr:.3f}", flush=True)
        else:
            print(f"[{stage}] epoch {epoch + 1:2d}/{epochs}  loss={total / n:.4f}", flush=True)

    export_model(net, out)
    info = validate_onnx(out, net)
    print(f"[{stage}] exported -> {out} ({info['size_mb']} MB, max torch/onnx diff={info['max_diff']})")


def main() -> None:
    p = argparse.ArgumentParser(description="Train Minesweeper policy milestones.")
    p.add_argument("--stage", choices=["m0", "m1", "m2"], required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--games", type=int, default=None)
    p.add_argument("--epochs", type=int, default=None)
    p.add_argument("--width", type=int, default=32)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--batch", type=int, default=256)
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--val-games", type=int, default=200)
    p.add_argument("--threads", type=int, default=4)
    p.add_argument("--val-every", type=int, default=4)
    args = p.parse_args()

    presets = {
        "m0": dict(games=0, epochs=0, seed=0, use_subset=True),
        "m1": dict(games=1500, epochs=6, seed=1, use_subset=False),
        "m2": dict(games=6000, epochs=16, seed=2, use_subset=True),
    }
    pre = presets[args.stage]
    games = args.games if args.games is not None else pre["games"]
    epochs = args.epochs if args.epochs is not None else pre["epochs"]
    seed = args.seed if args.seed is not None else pre["seed"]

    train(args.stage, args.out, games, epochs, args.width, args.lr, seed,
          args.batch, pre["use_subset"], args.val_games, args.threads, args.val_every)


if __name__ == "__main__":
    main()
