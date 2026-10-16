"""Registry of the 9 policy checkpoints for mines.livive.net (manifest v2).

One place that describes *how each model was made* and *how it differs*, shared
by ``train.py`` (to build/train them) and ``eval.py`` (to publish the enriched
``models/manifest.json`` v2 and ``docs/checkpoints.md``).

The nine checkpoints deliberately vary along real axes so CONCURRENT mode shows
spread rather than nine copies of one net:

* **family**      ``baseline`` | ``solver-imitation`` | ``rl`` | ``ablation``
* **method**      uniform weights, behaviour cloning (BC), or REINFORCE self-play
* **target**      which solver/reward the policy was fit to (basic vs subset vs
                  safety-shaped self-play)
* **capacity**    network width / depth (params)
* **training**    number of demonstration games and epochs
* **architecture** kernel size (5x5 wide vs 3x3, and depth)

Every entry pins a deterministic seed so the pipeline reproduces on CPU.

**Compute budget (board directive AIA-16).** Training cycles must finish in
well under 10 minutes on the current hardware, so the demonstration counts and
epochs below are deliberately capped (all nine train in a few minutes each on
a ~10-CPU box; see ``docs/checkpoints.md`` for the measured wall-clock). Do not
raise these budgets without re-checking the 10-minute ceiling.
"""

from __future__ import annotations

from typing import Dict, List

# Families used by the Models panel / docs.
FAMILIES = ("baseline", "solver-imitation", "rl", "ablation")


def _layers(width: int, depth: int, kernel: int, mid: int) -> List[str]:
    """Human-readable layer list for the manifest ``architecture.layers`` field."""
    k = f"{kernel}x{kernel}"
    out = [f"conv{k}(8->{width})+relu"]
    for _ in range(max(0, depth - 2)):
        out.append(f"conv{k}({width}->{width})+relu")
    out.append(f"conv{k}({width}->{mid})+relu")
    out.append(f"conv1x1({mid}->1) logits")
    return out


# Each spec carries everything the UI needs plus the training recipe.
MODELS: List[Dict] = [
    {
        "id": "m0",
        "label": "M0 · Uniform baseline",
        "family": "baseline",
        "method": "Uniform (zero logits)",
        "file": "models/policy-m0.onnx",
        "description": (
            "Zero-weight baseline: masked argmax collapses to the lowest-index "
            "legal cell, so it sweeps the grid blindly and detonates almost "
            "immediately. Defines the floor the trained variants must beat."
        ),
        "kind": "uniform",
        "arch": {"width": 32, "depth": 3, "kernel": 3, "mid": 16},
        "training": {"games": 0, "epochs": 0, "lr": 0.0, "target": "uniform (no training)"},
        "seed": 0,
        "train_seconds": 0,
        "use_subset": False,
    },
    {
        "id": "m1",
        "label": "M1 · Basic-rule imitation",
        "family": "solver-imitation",
        "method": "Behaviour cloning (basic solver)",
        "file": "models/policy-m1.onnx",
        "description": (
            "Behaviour cloning of the deterministic solver using only the basic "
            "number rules (rem==0 / rem==len), no subset reasoning. Small width-32 "
            "net on a short schedule; the cheap weak-target floor that still guesses "
            "on hard frontiers."
        ),
        "kind": "bc",
        "arch": {"width": 32, "depth": 3, "kernel": 3, "mid": 16},
        "training": {"games": 2000, "epochs": 16, "lr": 0.002, "target": "basic-solver"},
        "seed": 1,
        "train_seconds": 61,
        "use_subset": False,
    },
    {
        "id": "m2",
        "label": "M2 · Subset-solver imitation",
        "family": "solver-imitation",
        "method": "Behaviour cloning (subset solver)",
        "file": "models/policy-m2.onnx",
        "description": (
            "Same cloning recipe as M1 but the demonstrations come from the solver "
            "with 1-level subset inference, so the target is stronger. Width raised "
            "to 48 to absorb the harder target; the workhorse mid-tier model and the "
            "warm-start for the two RL variants."
        ),
        "kind": "bc",
        "arch": {"width": 48, "depth": 3, "kernel": 3, "mid": 16},
        "training": {"games": 3000, "epochs": 16, "lr": 0.002, "target": "subset-solver"},
        "seed": 2,
        "train_seconds": 261,
        "use_subset": True,
    },
    {
        "id": "m3",
        "label": "M3 · Wide + deep imitation",
        "family": "solver-imitation",
        "method": "Behaviour cloning (subset solver, high capacity)",
        "file": "models/policy-m3.onnx",
        "description": (
            "Capacity axis push: the same subset-solver target, but width 64 with an "
            "extra conv layer. Highest-parameter imitator, so it needs fewer epochs "
            "than M2 to converge; the reference to beat in CONCURRENT."
        ),
        "kind": "bc",
        "arch": {"width": 64, "depth": 4, "kernel": 3, "mid": 16},
        "training": {"games": 3000, "epochs": 8, "lr": 0.0015, "target": "subset-solver"},
        "seed": 3,
        "train_seconds": 421,
        "use_subset": True,
    },
    {
        "id": "m4",
        "label": "M4 · Long-trained small imitation",
        "family": "solver-imitation",
        "method": "Behaviour cloning (basic solver, long schedule)",
        "file": "models/policy-m4.onnx",
        "description": (
            "Training-amount axis: identical width-32 architecture and basic-solver "
            "target as M1, but more demonstration games and a longer schedule. "
            "Isolates how far more data/optimisation steps help a small net on a weak target."
        ),
        "kind": "bc",
        "arch": {"width": 32, "depth": 3, "kernel": 3, "mid": 16},
        "training": {"games": 3000, "epochs": 24, "lr": 0.002, "target": "basic-solver"},
        "seed": 4,
        "train_seconds": 321,
        "use_subset": False,
    },
    {
        "id": "m5",
        "label": "M5 · Self-play (win reward)",
        "family": "rl",
        "method": "REINFORCE fine-tune from M2",
        "file": "models/policy-m5.onnx",
        "description": (
            "Different objective: warm-started from M2 then optimised by REINFORCE on "
            "its own games, rewarded for each newly revealed safe cell plus a win "
            "bonus. Learns to chase clears directly instead of copying the solver."
        ),
        "kind": "rl",
        "arch": {"width": 48, "depth": 3, "kernel": 3, "mid": 16},
        "training": {
            "games": 2560,
            "epochs": 10,
            "lr": 0.0003,
            "target": "self-play: +1/safe-reveal, +10 win, -10 mine",
        },
        "seed": 5,
        "train_seconds": 93,
        "use_subset": True,
        "warm_start": "m2",
        "reward": {"safe": 1.0, "win": 10.0, "mine": 10.0},
    },
    {
        "id": "m6",
        "label": "M6 · Self-play (detonation-averse)",
        "family": "rl",
        "method": "REINFORCE fine-tune from M2, safety-shaped reward",
        "file": "models/policy-m6.onnx",
        "description": (
            "Second RL objective: same REINFORCE loop as M5 but a heavy detonation "
            "penalty. Trades some clears for caution, so its win/mine-hit profile "
            "differs from M5 and the imitators."
        ),
        "kind": "rl",
        "arch": {"width": 48, "depth": 3, "kernel": 3, "mid": 16},
        "training": {
            "games": 2560,
            "epochs": 10,
            "lr": 0.0003,
            "target": "self-play: +1/safe-reveal, +10 win, -40 mine",
        },
        "seed": 6,
        "train_seconds": 83,
        "use_subset": True,
        "warm_start": "m2",
        "reward": {"safe": 1.0, "win": 10.0, "mine": 40.0},
    },
    {
        "id": "m7",
        "label": "M7 · Wide-kernel ablation (5x5)",
        "family": "ablation",
        "method": "Behaviour cloning (subset solver, 5x5 kernels)",
        "file": "models/policy-m7.onnx",
        "description": (
            "Architecture ablation: 5x5 kernels give every cell a two-cell receptive "
            "field instead of the one-cell 3x3 used by the other imitators, at the same "
            "width/depth as M2 (fewer games/epochs to stay in budget). Tests whether "
            "extra spatial context helps or hurts."
        ),
        "kind": "bc",
        "arch": {"width": 48, "depth": 3, "kernel": 5, "mid": 16},
        "training": {"games": 2500, "epochs": 8, "lr": 0.002, "target": "subset-solver"},
        "seed": 7,
        "train_seconds": 242,
        "use_subset": True,
    },
    {
        "id": "m8",
        "label": "M8 · Shallow ablation (single conv)",
        "family": "ablation",
        "method": "Behaviour cloning (subset solver, 1 hidden conv)",
        "file": "models/policy-m8.onnx",
        "description": (
            "Depth ablation: only one 3x3 feature-extraction conv before the 1x1 "
            "head, versus three in M2/M3. Same target and data as M2, so any gap is "
            "due to depth rather than target quality."
        ),
        "kind": "bc",
        "arch": {"width": 48, "depth": 1, "kernel": 3, "mid": 16},
        "training": {"games": 3000, "epochs": 16, "lr": 0.002, "target": "subset-solver"},
        "seed": 8,
        "train_seconds": 161,
        "use_subset": True,
    },
]


def by_id(model_id: str) -> Dict:
    for m in MODELS:
        if m["id"] == model_id:
            return m
    raise KeyError(f"unknown model id: {model_id}")


def layers_for(spec: Dict) -> List[str]:
    a = spec["arch"]
    return _layers(a["width"], a["depth"], a["kernel"], a["mid"])
