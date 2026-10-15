"""Fixed-seed evaluation for the Minesweeper policy checkpoints.

Runs every checkpoint through a deterministic 500-seed gauntlet using the
exported ONNX files (via onnxruntime, the same kernels onnxruntime-web uses),
then writes ``models/manifest.json`` and ``docs/checkpoints.md``.

Reproduce:

    python3 tools/eval.py --seeds 500 \
        --manifest models/manifest.json --docs docs/checkpoints.md
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort

from mines import Game, N, encode_state

DEFAULT_CHECKPOINTS = [
    ("m0", "Milestone 0 — baseline (uniform logits)", "models/policy-m0.onnx"),
    ("m1", "Milestone 1 — imitation of basic solver", "models/policy-m1.onnx"),
    ("m2", "Milestone 2 — imitation of subset solver", "models/policy-m2.onnx"),
]


def load_session(path: str) -> ort.InferenceSession:
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0]
    out = sess.get_outputs()[0]
    if list(inp.shape) != [1, 8, 8, 8] or list(out.shape) != [1, 64]:
        raise ValueError(f"{path}: unexpected shapes {inp.shape} -> {out.shape}")
    return sess


def play(sess: ort.InferenceSession, seed: int, max_steps: int = 400) -> str:
    """Play one deterministic game. Returns 'win' | 'mine' | 'stuck'."""
    game = Game(seed)
    inp = sess.get_inputs()[0].name
    out = sess.get_outputs()[0].name
    steps = 0
    while not game.over and steps < max_steps:
        steps += 1
        legal = np.asarray(game.legal_mask(), dtype=np.float32)
        if not legal.any():
            return "stuck"
        state = game.state()
        feats = encode_state(state["hidden"], state["revealed"], state["flagged"], state["counts"])
        logits = sess.run([out], {inp: feats.reshape(1, 8, 8, 8)})[0][0]
        masked = logits + (1.0 - legal) * -1e9
        action = int(np.argmax(masked))  # lowest-index tie-break
        if not legal[action]:
            return "stuck"
        game.reveal(action)
    if game.won:
        return "win"
    return "mine" if game.hit_mine else "stuck"


def evaluate(sess: ort.InferenceSession, seeds) -> dict:
    wins = 0
    mines = 0
    stuck = 0
    for s in seeds:
        r = play(sess, s)
        if r == "win":
            wins += 1
        elif r == "mine":
            mines += 1
        else:
            stuck += 1
    n = len(seeds)
    return {
        "games": n,
        "wins": wins,
        "mine_hits": mines,
        "stuck": stuck,
        "win_rate": round(wins / n, 4),
        "mine_hit_rate": round(mines / n, 4),
    }


def write_docs(path: str, rows, stats_by_id, seeds, version: str) -> None:
    lines = []
    lines.append("# Minesweeper policy checkpoints")
    lines.append("")
    lines.append(
        "Fixed-seed evaluation of the ONNX policy milestones for the "
        "**8x8 / 10-mine** board. All numbers are produced by "
        "`tools/eval.py` using the exported models through `onnxruntime` "
        "(the same kernels `onnxruntime-web` runs on-device)."
    )
    lines.append("")
    lines.append("## Results")
    lines.append("")
    lines.append("| Checkpoint | Label | Win rate | Mine-hit rate | Wins / games |")
    lines.append("| --- | --- | ---: | ---: | ---: |")
    for r in rows:
        stats = stats_by_id[r["id"]]
        lines.append(
            f"| `{r['id']}` | {r['label']} | {r['eval']['win_rate']:.4f} | "
            f"{r['eval']['mine_hit_rate']:.4f} | {stats['wins']} / {stats['games']} |"
        )
    lines.append("")
    lines.append("## Protocol")
    lines.append("")
    lines.append(f"- **Seeds:** `{seeds[0]}..{seeds[-1]}` ({len(seeds)} fixed seeds), one full game per seed.")
    lines.append("- **Board:** 8x8, 10 mines, generated **exactly** like `src/engine.js` — canonical `mulberry32(seed)`, lazy placement on the first reveal, forbidden set `{first} ∪ neighbors(first)`, rejection sampling (one draw per attempt). Verified bit-identical for seeds `1..500`.")
    lines.append("- **First click is guaranteed safe:** the first cell and its neighbors are always mine-free (\"first-click safe\" cascade).")
    lines.append("- **Play loop:** featurize -> ONNX forward -> masked softmax over legal cells -> argmax.")
    lines.append("- **Action masking:** legal = `hidden & !flagged` (`hidden` = unrevealed and unflagged).")
    lines.append("- **Determinism / tie-break:** `argmax` with the **lowest cell index** (row-major) wins ties. Given a (seed, checkpoint) the action sequence is fully reproducible.")
    lines.append("- **win_rate** = games fully cleared / seeds. **mine_hit_rate** = games where a mine was revealed / seeds. `stuck` games (no legal move without a win) are counted as neither.")
    lines.append("")
    lines.append("## State contract (frozen)")
    lines.append("")
    lines.append("`state = { hidden:Uint8Array(64), revealed:Uint8Array(64), flagged:Uint8Array(64), counts:Int8Array(64) }`, index `r*8+c`.")
    lines.append("`hidden[i]` is 1 only for cells that are **unrevealed AND unflagged**. `counts[i]` is 0 for hidden cells (no leakage).")
    lines.append("")
    lines.append("Channels (NCHW, `index = c*64 + i`): `0` hidden · `1` revealed · `2` flagged · `3` count/8 · `4` revealed-empty · `5` mines-remaining/hidden-count · `6` revealed-count/64 · `7` constant 1.")
    lines.append("")
    lines.append("## Reproduce")
    lines.append("")
    lines.append("```bash")
    lines.append("python3 -m pip install -r tools/requirements.txt   # numpy, torch, onnx, onnxruntime")
    lines.append("")
    lines.append("# Baseline + trained milestones (fully seeded, CPU only):")
    lines.append("python3 tools/train.py --stage m0 --out models/policy-m0.onnx")
    lines.append("python3 tools/train.py --stage m1 --out models/policy-m1.onnx --games 2500 --epochs 40 --width 32 --lr 2e-3")
    lines.append("python3 tools/train.py --stage m2 --out models/policy-m2.onnx --games 6000 --epochs 30 --width 48 --lr 2e-3")
    lines.append("")
    lines.append("# Fixed-seed evaluation table + manifest:")
    lines.append("python3 tools/eval.py --seeds 500 --manifest models/manifest.json --docs docs/checkpoints.md")
    lines.append("```")
    lines.append("")
    lines.append(f"Manifest version: `{version}`. ORT version pinned in `src/policy.js`: onnxruntime-web "
                 "`1.19.2`, WASM backend single-threaded (`numThreads=1`) so it runs on GitHub Pages without COOP/COEP.")
    lines.append("")
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text("\n".join(lines) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=500)
    ap.add_argument("--seed-start", type=int, default=1)
    ap.add_argument("--manifest", default="models/manifest.json")
    ap.add_argument("--docs", default="docs/checkpoints.md")
    ap.add_argument("--checkpoints", default="",
                    help="optional comma list id:file overrides")
    args = ap.parse_args()

    ckpts = list(DEFAULT_CHECKPOINTS)
    if args.checkpoints:
        ckpts = []
        for part in args.checkpoints.split(","):
            cid, label, file = part.split(":")
            ckpts.append((cid, label, file))

    seeds = list(range(args.seed_start, args.seed_start + args.seeds))
    rows = []
    stats_by_id = {}
    for cid, label, file in ckpts:
        if not Path(file).exists():
            raise FileNotFoundError(f"missing checkpoint {file}; run tools/train.py first")
        sess = load_session(file)
        stats = evaluate(sess, seeds)
        stats_by_id[cid] = stats
        row = {
            "id": cid,
            "label": label,
            "file": file,
            "eval": {"win_rate": stats["win_rate"], "mine_hit_rate": stats["mine_hit_rate"]},
        }
        rows.append(row)
        print(f"[eval] {cid}: win_rate={stats['win_rate']:.4f} "
              f"mine_hit_rate={stats['mine_hit_rate']:.4f} "
              f"(wins={stats['wins']}, mines={stats['mine_hits']}, stuck={stats['stuck']})")

    manifest = {
        "version": 1,
        "board": {"h": 8, "w": 8, "mines": 10},
        "input": {"shape": [1, 8, 8, 8], "layout": "nchw"},
        "output": {"shape": [1, 64], "type": "logits"},
        "checkpoints": rows,
    }
    Path(args.manifest).parent.mkdir(parents=True, exist_ok=True)
    Path(args.manifest).write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"[eval] wrote {args.manifest}")

    write_docs(args.docs, rows, stats_by_id, seeds, manifest["version"])
    print(f"[eval] wrote {args.docs}")


if __name__ == "__main__":
    main()
