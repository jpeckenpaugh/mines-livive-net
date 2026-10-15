# Minesweeper policy checkpoints

Fixed-seed evaluation of the ONNX policy milestones for the **8x8 / 10-mine** board. All numbers are produced by `tools/eval.py` using the exported models through `onnxruntime` (the same kernels `onnxruntime-web` runs on-device).

## Results

| Checkpoint | Label | Win rate | Mine-hit rate | Wins / games |
| --- | --- | ---: | ---: | ---: |
| `m0` | Milestone 0 — baseline (uniform logits) | 0.0000 | 1.0000 | 0 / 500 |
| `m1` | Milestone 1 — imitation of basic solver | 0.4140 | 0.5860 | 207 / 500 |
| `m2` | Milestone 2 — imitation of subset solver | 0.5560 | 0.4440 | 278 / 500 |

## Protocol

- **Seeds:** `1..500` (500 fixed seeds), one full game per seed.
- **Board:** 8x8, 10 mines, generated **exactly** like `src/engine.js` — canonical `mulberry32(seed)`, lazy placement on the first reveal, forbidden set `{first} ∪ neighbors(first)`, rejection sampling (one draw per attempt). Verified bit-identical for seeds `1..500`.
- **First click is guaranteed safe:** the first cell and its neighbors are always mine-free ("first-click safe" cascade).
- **Play loop:** featurize -> ONNX forward -> masked softmax over legal cells -> argmax.
- **Action masking:** legal = `hidden & !flagged` (`hidden` = unrevealed and unflagged).
- **Determinism / tie-break:** `argmax` with the **lowest cell index** (row-major) wins ties. Given a (seed, checkpoint) the action sequence is fully reproducible.
- **win_rate** = games fully cleared / seeds. **mine_hit_rate** = games where a mine was revealed / seeds. `stuck` games (no legal move without a win) are counted as neither.

## State contract (frozen)

`state = { hidden:Uint8Array(64), revealed:Uint8Array(64), flagged:Uint8Array(64), counts:Int8Array(64) }`, index `r*8+c`.
`hidden[i]` is 1 only for cells that are **unrevealed AND unflagged**. `counts[i]` is 0 for hidden cells (no leakage).

Channels (NCHW, `index = c*64 + i`): `0` hidden · `1` revealed · `2` flagged · `3` count/8 · `4` revealed-empty · `5` mines-remaining/hidden-count · `6` revealed-count/64 · `7` constant 1.

## Reproduce

```bash
python3 -m pip install -r tools/requirements.txt   # numpy, torch, onnx, onnxruntime

# Baseline + trained milestones (fully seeded, CPU only):
python3 tools/train.py --stage m0 --out models/policy-m0.onnx
python3 tools/train.py --stage m1 --out models/policy-m1.onnx --games 2500 --epochs 40 --width 32 --lr 2e-3
python3 tools/train.py --stage m2 --out models/policy-m2.onnx --games 6000 --epochs 30 --width 48 --lr 2e-3

# Fixed-seed evaluation table + manifest:
python3 tools/eval.py --seeds 500 --manifest models/manifest.json --docs docs/checkpoints.md
```

Manifest version: `1`. ORT version pinned in `src/policy.js`: onnxruntime-web `1.19.2`, WASM backend single-threaded (`numThreads=1`) so it runs on GitHub Pages without COOP/COEP.

