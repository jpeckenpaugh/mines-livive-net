"""Training pipeline for the 8x8 / 10-mine Minesweeper policy library.

Builds the nine documented checkpoints registered in ``registry.py``. Three
recipes are supported, all fully seeded and CPU-only:

* ``uniform``  — zero-logit baseline (``m0``).
* ``bc``       — behaviour cloning of the deterministic constraint solver; the
                 target can be basic rules or basic + 1-level subset reasoning.
* ``rl``       — REINFORCE self-play fine-tuning of a cloned policy, with either
                 a win-chasing or detonation-averse reward.

The network is a small fully-convolutional (spatially tied) net so it
generalises across board positions and stays tiny (< ~1 MB) for on-device
inference.

Reproducible commands (CPU only):

    python3 tools/train.py --model m0          # zero-logit baseline
    python3 tools/train.py --model m2          # subset-solver imitation
    python3 tools/train.py --model m5          # self-play from m2
    python3 tools/train.py --all               # all nine, in dependency order

Each command is fully seeded; rerunning reproduces the same weights.
"""

from __future__ import annotations

import argparse
import copy
import os
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from mines import N, Game, encode_state
from export_onnx import export_model, validate_onnx
from registry import MODELS, by_id


# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

class PolicyNet(nn.Module):
    """Fully-convolutional logits head: [B,8,8,8] NCHW -> [B,64] logits.

    ``depth`` counts the convolution layers before the 1x1 logits head
    (a conv->mid bottleneck plus the head). ``kernel`` controls the receptive
    field: 3x3 mixes neighbours, 1x1 is the per-cell ablation.
    """

    def __init__(self, in_ch: int = 8, width: int = 32, depth: int = 3,
                 kernel: int = 3, mid: int = 16):
        super().__init__()
        pad = kernel // 2
        layers: list[nn.Module] = [nn.Conv2d(in_ch, width, kernel, padding=pad), nn.ReLU()]
        for _ in range(max(0, depth - 2)):
            layers += [nn.Conv2d(width, width, kernel, padding=pad), nn.ReLU()]
        layers += [nn.Conv2d(width, mid, kernel, padding=pad), nn.ReLU()]
        self.body = nn.Sequential(*layers)
        self.head = nn.Conv2d(mid, 1, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h = self.body(x)
        logits = self.head(h)  # [B,1,8,8]
        return logits.reshape(logits.shape[0], N)


def build_net(spec: dict) -> PolicyNet:
    a = spec["arch"]
    net = PolicyNet(in_ch=8, width=a["width"], depth=a["depth"],
                    kernel=a["kernel"], mid=a["mid"])
    with torch.no_grad():
        for p in net.parameters():
            nn.init.kaiming_uniform_(p, nonlinearity="relu") if p.dim() > 1 else p.zero_()
    return net


def net_params(net: nn.Module) -> int:
    return sum(p.numel() for p in net.parameters())


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


def generate_demos(use_subset: bool, n_games: int, seed0: int, max_steps: int = 400):
    from mines import infer, guess_probabilities

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
        if not mask[action]:
            break
        game.reveal(action)
    return "win" if game.won else "loss"


def quick_win_rate(net: nn.Module, seeds) -> float:
    wins = 0
    for s in seeds:
        if play_game(net, s) == "win":
            wins += 1
    return wins / len(seeds)


# ---------------------------------------------------------------------------
# Recipes
# ---------------------------------------------------------------------------

def train_uniform(spec: dict) -> nn.Module:
    net = build_net(spec)
    with torch.no_grad():
        for p in net.parameters():
            p.zero_()
    return net


def train_bc(spec: dict, threads: int, val_games: int = 200, val_every: int = 10) -> nn.Module:
    tr = spec["training"]
    seed = spec["seed"]
    torch.set_num_threads(max(1, threads))
    torch.manual_seed(seed)
    np.random.seed(seed)

    t0 = time.time()
    X, Y, solver_wr = generate_demos(spec["use_subset"], tr["games"], seed0=1000 + seed, max_steps=400)
    print(f"[{spec['id']}] demos: {X.shape[0]} states  (solver win rate on gen games: {solver_wr:.3f}) "
          f"in {time.time() - t0:.1f}s")

    net = build_net(spec)
    opt = torch.optim.AdamW(net.parameters(), lr=tr["lr"], weight_decay=1e-4)
    Xt = torch.from_numpy(X)
    Yt = torch.from_numpy(Y)
    n = X.shape[0]
    gen = torch.Generator().manual_seed(seed)
    batch = 256

    for epoch in range(tr["epochs"]):
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
        last = (epoch + 1) == tr["epochs"]
        if last or (epoch + 1) % val_every == 0:
            val_seeds = list(range(500000, 500000 + val_games))
            wr = quick_win_rate(net, val_seeds)
            print(f"[{spec['id']}] epoch {epoch + 1:2d}/{tr['epochs']}  loss={total / n:.4f}  val_win_rate={wr:.3f}", flush=True)
        else:
            print(f"[{spec['id']}] epoch {epoch + 1:2d}/{tr['epochs']}  loss={total / n:.4f}", flush=True)
    return net


def train_rl(spec: dict, base_net: nn.Module, threads: int) -> nn.Module:
    """REINFORCE fine-tuning of a cloned policy on its own games.

    Reward per step: ``safe`` * newly-revealed safe cells, plus ``win`` on a
    cleared board, minus ``mine`` on detonation. Advantage = normalised
    discounted return.
    """
    tr = spec["training"]
    rw = spec["reward"]
    seed = spec["seed"]
    gamma = 0.99
    episodes_per_iter = max(1, tr["games"] // tr["epochs"])

    torch.set_num_threads(max(1, threads))
    torch.manual_seed(seed)
    np.random.seed(seed)

    net = copy.deepcopy(base_net)
    opt = torch.optim.AdamW(net.parameters(), lr=tr["lr"], weight_decay=1e-4)
    gen = torch.Generator().manual_seed(seed)
    max_steps = 200

    for it in range(tr["epochs"]):
        nets_states, nets_logps, all_returns = [], [], []
        wins = 0
        for g in range(episodes_per_iter):
            game = Game(seed * 1_000_000 + it * episodes_per_iter + g + 7)
            states, logps, rewards = [], [], []
            steps = 0
            while not game.over and steps < max_steps:
                steps += 1
                legal = np.asarray(game.legal_mask(), dtype=np.float32)
                if not legal.any():
                    break
                state = game.state()
                feats = encode_state(state["hidden"], state["revealed"], state["flagged"], state["counts"])
                xt = torch.from_numpy(feats).reshape(1, 8, 8, 8)
                logits = net(xt)
                masked = logits + torch.from_numpy(1.0 - legal).reshape(1, N) * -1e9
                logp = F.log_softmax(masked, dim=1)
                probs = logp.exp()
                probs = probs / probs.sum(dim=1, keepdim=True).clamp_min(1e-12)
                a = int(torch.multinomial(probs, 1, generator=gen).item())
                before = game._revealed_count()
                res = game.reveal(a)
                newly = game._revealed_count() - before
                if res == "mine":
                    r = -rw["mine"]
                else:
                    r = rw["safe"] * newly
                    if game.won:
                        r += rw["win"]
                states.append(xt)
                logps.append(logp[0, a])
                rewards.append(r)
            if game.won:
                wins += 1
            G = 0.0
            rets = [0.0] * len(rewards)
            for t in reversed(range(len(rewards))):
                G = rewards[t] + gamma * G
                rets[t] = G
            nets_states.extend(states)
            nets_logps.extend(logps)
            all_returns.extend(rets)

        if not nets_logps:
            continue
        ret_t = torch.tensor(all_returns, dtype=torch.float32)
        adv = (ret_t - ret_t.mean()) / (ret_t.std() + 1e-6)
        loss = -(torch.stack(nets_logps) * adv).mean()
        opt.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(net.parameters(), 5.0)
        opt.step()
        print(f"[{spec['id']}] iter {it + 1:2d}/{tr['epochs']}  episodes={episodes_per_iter}  "
              f"wins={wins}  mean_return={ret_t.mean().item():.2f}  loss={float(loss.detach()):.4f}", flush=True)
    return net


def train_model(spec: dict, cache: dict, threads: int) -> nn.Module:
    if spec["id"] in cache:
        return cache[spec["id"]]
    kind = spec["kind"]
    if kind == "uniform":
        net = train_uniform(spec)
    elif kind == "bc":
        net = train_bc(spec, threads)
    elif kind == "rl":
        base_spec = by_id(spec["warm_start"])
        base = train_model(base_spec, cache, threads)
        t0 = time.time()
        net = train_rl(spec, base, threads)
        print(f"[{spec['id']}] RL fine-tune finished in {time.time() - t0:.1f}s")
    else:
        raise ValueError(f"unknown kind {kind}")
    cache[spec["id"]] = net
    return net


def save(spec: dict, net: nn.Module, out: str | None = None) -> None:
    path = out or spec["file"]
    export_model(net, path)
    info = validate_onnx(path, net)
    print(f"[{spec['id']}] exported -> {path} ({info['size_mb']} MB, "
          f"params={net_params(net)}, max torch/onnx diff={info['max_diff']})")


def main() -> None:
    p = argparse.ArgumentParser(description="Train Minesweeper policy checkpoints.")
    p.add_argument("--model", action="append", default=None,
                   help="model id from registry.py (repeatable)")
    p.add_argument("--all", action="store_true", help="train every registered model")
    p.add_argument("--out", default=None, help="override output path (single model only)")
    p.add_argument("--games", type=int, default=None)
    p.add_argument("--epochs", type=int, default=None)
    p.add_argument("--lr", type=float, default=None)
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--threads", type=int, default=min(os.cpu_count() or 4, 8),
                   help="torch CPU threads (default: up to 8; the recipes are "
                        "sized so each model trains in a few minutes)")
    args = p.parse_args()

    if args.all:
        ids = [m["id"] for m in MODELS]
    elif args.model:
        ids = args.model
    else:
        p.error("pass --model <id> (repeatable) or --all")

    cache: dict = {}
    for mid in ids:
        spec = copy.deepcopy(by_id(mid))
        if args.games is not None:
            spec["training"]["games"] = args.games
        if args.epochs is not None:
            spec["training"]["epochs"] = args.epochs
        if args.lr is not None:
            spec["training"]["lr"] = args.lr
        if args.seed is not None:
            spec["seed"] = args.seed
        t0 = time.time()
        net = train_model(spec, cache, args.threads)
        out = args.out if (args.out and len(ids) == 1) else spec["file"]
        save(spec, net, out)
        print(f"[{mid}] total {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
