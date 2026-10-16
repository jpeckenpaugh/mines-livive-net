"""Fixed-seed evaluation for the Minesweeper policy library (manifest v2).

Runs every registered checkpoint through a deterministic 500-seed gauntlet
using the exported ONNX files (via onnxruntime, the same kernels
onnxruntime-web uses), then writes the enriched ``models/manifest.json`` (v2)
and ``docs/checkpoints.md``.

Reproduce:

    python3 tools/eval.py --seeds 500 \
        --manifest models/manifest.json --docs docs/checkpoints.md
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnx import numpy_helper

from mines import Game, N, encode_state
from registry import MODELS, layers_for

# Frozen scoring contract (see POC v2 plan): points = safe cells revealed *
# safe_reveal_points + (won ? win_bonus : 0).
SCORING = {"safe_reveal_points": 1, "win_bonus": 50}


def load_session(path: str) -> ort.InferenceSession:
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0]
    out = sess.get_outputs()[0]
    if list(inp.shape) != [1, 8, 8, 8] or list(out.shape) != [1, 64]:
        raise ValueError(f"{path}: unexpected shapes {inp.shape} -> {out.shape}")
    return sess


def onnx_params(path: str) -> int:
    """Count parameters as the sum of all initializer elements in the graph."""
    model = onnx.load(path)
    total = 0
    for init in model.graph.initializer:
        total += int(numpy_helper.to_array(init).size)
    return total


def play(sess: ort.InferenceSession, seed: int, max_steps: int = 400) -> dict:
    """Play one deterministic game. Returns classification + score data."""
    game = Game(seed)
    inp = sess.get_inputs()[0].name
    out = sess.get_outputs()[0].name
    steps = 0
    while not game.over and steps < max_steps:
        steps += 1
        legal = np.asarray(game.legal_mask(), dtype=np.float32)
        if not legal.any():
            break
        state = game.state()
        feats = encode_state(state["hidden"], state["revealed"], state["flagged"], state["counts"])
        logits = sess.run([out], {inp: feats.reshape(1, 8, 8, 8)})[0][0]
        masked = logits + (1.0 - legal) * -1e9
        action = int(np.argmax(masked))  # lowest-index tie-break
        if not legal[action]:
            break
        game.reveal(action)
    if game.won:
        result = "win"
    elif game.hit_mine:
        result = "mine"
    else:
        result = "stuck"
    safe_reveals = game._revealed_count()
    points = safe_reveals * SCORING["safe_reveal_points"] + (SCORING["win_bonus"] if game.won else 0)
    return {"result": result, "safe_reveals": safe_reveals, "points": points}


def evaluate(sess: ort.InferenceSession, seeds) -> dict:
    wins = mines = stuck = 0
    total_safe = 0
    total_points = 0
    for s in seeds:
        r = play(sess, s)
        total_safe += r["safe_reveals"]
        total_points += r["points"]
        if r["result"] == "win":
            wins += 1
        elif r["result"] == "mine":
            mines += 1
        else:
            stuck += 1
    n = len(seeds)
    return {
        "games": n,
        "wins": wins,
        "mine_hits": mines,
        "stuck": stuck,
        "total_points": total_points,
        "win_rate": round(wins / n, 4),
        "mine_hit_rate": round(mines / n, 4),
        "stuck_rate": round(stuck / n, 4),
        "avg_safe_reveals": round(total_safe / n, 2),
    }


def build_entry(spec: dict, stats: dict, params: int, size_bytes: int) -> dict:
    return {
        "id": spec["id"],
        "label": spec["label"],
        "family": spec["family"],
        "method": spec["method"],
        "file": spec["file"],
        "description": spec["description"],
        "architecture": {
            "width": spec["arch"]["width"],
            "layers": layers_for(spec),
            "params": params,
        },
        "training": dict(spec["training"]),
        "size_bytes": size_bytes,
        "eval": {
            "win_rate": stats["win_rate"],
            "mine_hit_rate": stats["mine_hit_rate"],
            "stuck_rate": stats["stuck_rate"],
            "avg_safe_reveals": stats["avg_safe_reveals"],
        },
    }


def write_docs(path: str, spec_by_id, stats_by_id, entries, seeds) -> None:
    L = []
    L.append("# Minesweeper policy checkpoints")
    L.append("")
    L.append(
        "Fixed-seed evaluation of the **nine** ONNX policy variations for the "
        "**8x8 / 10-mine** board. All numbers are produced by `tools/eval.py` "
        "using the exported models through `onnxruntime` (the same kernels "
        "`onnxruntime-web` runs on-device)."
    )
    L.append("")
    L.append("## Results")
    L.append("")
    L.append("| Checkpoint | Family | Win rate | Mine-hit | Stuck | Avg safe reveals | Params | Size |")
    L.append("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |")
    for e in entries:
        st = stats_by_id[e["id"]]
        L.append(
            f"| `{e['id']}` | {e['family']} | {st['win_rate']:.4f} | {st['mine_hit_rate']:.4f} | "
            f"{st['stuck_rate']:.4f} | {st['avg_safe_reveals']:.2f} | {e['architecture']['params']:,} | "
            f"{e['size_bytes'] / 1024:.1f} KiB |"
        )
    L.append("")
    L.append(
        "**Total points** (CONCURRENT score for these seeds, "
        f"`{SCORING['safe_reveal_points']} pt/safe cell + {SCORING['win_bonus']} pt/win`): "
        + ", ".join(f"`{e['id']}`={stats_by_id[e['id']]['total_points']:,}" for e in entries)
        + "."
    )
    L.append("")
    L.append("## Model details")
    L.append("")
    for e in entries:
        spec = spec_by_id[e["id"]]
        tr = spec["training"]
        L.append(f"### `{e['id']}` — {e['label']}  ·  *{e['family']}*")
        L.append("")
        L.append(e["description"])
        L.append("")
        L.append(f"- **Method:** {e['method']}")
        L.append(f"- **Architecture:** width `{spec['arch']['width']}`, depth `{spec['arch']['depth']}`, "
                 f"kernel `{spec['arch']['kernel']}x{spec['arch']['kernel']}`; layers: "
                 f"`{' -> '.join(e['architecture']['layers'])}`; params `{e['architecture']['params']:,}`.")
        L.append(f"- **Training:** games `{tr['games']}`, epochs `{tr['epochs']}`, "
                 f"lr `{tr['lr']}`, target `{tr['target']}`.")
        if spec.get("train_seconds") is not None:
            L.append(f"- **Train wall-clock:** ~{spec['train_seconds']}s on the current "
                     f"10-vCPU build box (8 torch threads; board caps every cycle well "
                     f"under 10 minutes).")
        L.append(f"- **Reproduce:** `python3 tools/train.py --model {e['id']}`")
        L.append("")
    L.append("## Protocol")
    L.append("")
    L.append(f"- **Seeds:** `{seeds[0]}..{seeds[-1]}` ({len(seeds)} fixed seeds), one full game per seed.")
    L.append("- **Board:** 8x8, 10 mines, generated **exactly** like `src/engine.js` — canonical `mulberry32(seed)`, lazy placement on the first reveal, forbidden set `{first} ∪ neighbors(first)`, rejection sampling (one draw per attempt). Verified bit-identical for seeds `1..500`.")
    L.append("- **First click is guaranteed safe:** the first cell and its neighbors are always mine-free (\"first-click safe\" cascade).")
    L.append("- **Play loop:** featurize -> ONNX forward -> masked argmax over legal cells.")
    L.append("- **Action masking:** legal = `hidden & !flagged` (`hidden` = unrevealed and unflagged).")
    L.append("- **Determinism / tie-break:** `argmax` with the **lowest cell index** (row-major) wins ties. Given a (seed, checkpoint) the action sequence is fully reproducible.")
    L.append("- **win_rate** = cleared / seeds. **mine_hit_rate** = detonated / seeds. **stuck_rate** = no legal move and not won / seeds. **avg_safe_reveals** = mean safe cells revealed per game (54 = a full clear).")
    L.append("")
    L.append("## Scoring")
    L.append("")
    L.append(f"Frozen per-model score (POC v2): `points = safe_cells_revealed * {SCORING['safe_reveal_points']} "
             f"+ (won ? {SCORING['win_bonus']} : 0)`. A detonation or stuck game ends with points earned so far.")
    L.append("")
    L.append("## State contract (frozen)")
    L.append("")
    L.append("`state = { hidden:Uint8Array(64), revealed:Uint8Array(64), flagged:Uint8Array(64), counts:Int8Array(64) }`, index `r*8+c`.")
    L.append("`hidden[i]` is 1 only for cells that are **unrevealed AND unflagged**. `counts[i]` is 0 for hidden cells (no leakage).")
    L.append("")
    L.append("Channels (NCHW, `index = c*64 + i`): `0` hidden · `1` revealed · `2` flagged · `3` count/8 · `4` revealed-empty · `5` mines-remaining/hidden-count · `6` revealed-count/64 · `7` constant 1.")
    L.append("")
    L.append("## Reproduce")
    L.append("")
    L.append("```bash")
    L.append("python3 -m pip install -r tools/requirements.txt   # numpy, torch, onnx, onnxruntime")
    L.append("")
    L.append("# Train all nine checkpoints (fully seeded, CPU only):")
    L.append("python3 tools/train.py --all")
    L.append("# …or a single model, e.g.:")
    L.append("for m in m0 m1 m2 m3 m4 m5 m6 m7 m8; do python3 tools/train.py --model $m; done")
    L.append("")
    L.append("# Fixed-seed evaluation table + manifest v2 + docs:")
    L.append("python3 tools/eval.py --seeds 500 --manifest models/manifest.json --docs docs/checkpoints.md")
    L.append("```")
    L.append("")
    L.append("Manifest version: `2`. ORT version pinned in `src/policy.js`: onnxruntime-web "
             "`1.19.2`, WASM backend single-threaded (`numThreads=1`) so it runs on GitHub Pages without COOP/COEP.")
    L.append("")
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text("\n".join(L) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=500)
    ap.add_argument("--seed-start", type=int, default=1)
    ap.add_argument("--manifest", default="models/manifest.json")
    ap.add_argument("--docs", default="docs/checkpoints.md")
    ap.add_argument("--models", default="", help="optional comma list of ids to restrict")
    args = ap.parse_args()

    wanted = [m for m in MODELS if not args.models or m["id"] in args.models.split(",")]
    seeds = list(range(args.seed_start, args.seed_start + args.seeds))

    entries, stats_by_id, spec_by_id = [], {}, {}
    for spec in wanted:
        path = spec["file"]
        if not Path(path).exists():
            raise FileNotFoundError(f"missing checkpoint {path}; run tools/train.py --all first")
        size_bytes = Path(path).stat().st_size
        params = onnx_params(path)
        sess = load_session(path)
        stats = evaluate(sess, seeds)
        stats_by_id[spec["id"]] = stats
        spec_by_id[spec["id"]] = spec
        entries.append(build_entry(spec, stats, params, size_bytes))
        print(f"[eval] {spec['id']} ({spec['family']}): win={stats['win_rate']:.4f} "
              f"mine={stats['mine_hit_rate']:.4f} stuck={stats['stuck_rate']:.4f} "
              f"safe={stats['avg_safe_reveals']:.2f} pts={stats['total_points']} "
              f"params={params} size={size_bytes}B", flush=True)

    if len(entries) != 9:
        print(f"[eval] WARNING: expected 9 checkpoints, got {len(entries)}")

    manifest = {
        "version": 2,
        "board": {"h": 8, "w": 8, "mines": 10},
        "input": {"shape": [1, 8, 8, 8], "layout": "nchw"},
        "output": {"shape": [1, 64], "type": "logits"},
        "scoring": dict(SCORING),
        "checkpoints": entries,
    }
    Path(args.manifest).parent.mkdir(parents=True, exist_ok=True)
    Path(args.manifest).write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"[eval] wrote {args.manifest}")

    write_docs(args.docs, spec_by_id, stats_by_id, entries, seeds)
    print(f"[eval] wrote {args.docs}")


if __name__ == "__main__":
    main()
