# Minesweeper policy checkpoints

Fixed-seed evaluation of the **nine** ONNX policy variations for the **8x8 / 10-mine** board. All numbers are produced by `tools/eval.py` using the exported models through `onnxruntime` (the same kernels `onnxruntime-web` runs on-device).

## Results

| Checkpoint | Family | Win rate | Mine-hit | Stuck | Avg safe reveals | Params | Size |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `m0` | baseline | 0.0000 | 1.0000 | 0.0000 | 20.43 | 16,193 | 64.8 KiB |
| `m1` | solver-imitation | 0.2880 | 0.7120 | 0.0000 | 37.93 | 16,225 | 64.9 KiB |
| `m2` | solver-imitation | 0.5640 | 0.4360 | 0.0000 | 46.78 | 31,233 | 123.5 KiB |
| `m3` | solver-imitation | 0.6140 | 0.3860 | 0.0000 | 46.89 | 87,777 | 344.7 KiB |
| `m4` | solver-imitation | 0.3600 | 0.6400 | 0.0000 | 38.79 | 16,225 | 64.9 KiB |
| `m5` | rl | 0.5740 | 0.4260 | 0.0000 | 46.60 | 31,233 | 123.5 KiB |
| `m6` | rl | 0.5780 | 0.4220 | 0.0000 | 46.54 | 31,233 | 123.5 KiB |
| `m7` | ablation | 0.5100 | 0.4900 | 0.0000 | 45.15 | 86,529 | 339.5 KiB |
| `m8` | ablation | 0.1180 | 0.8820 | 0.0000 | 35.77 | 10,449 | 42.0 KiB |

**Total points** (CONCURRENT score for these seeds, `1 pt/safe cell + 50 pt/win`): `m0`=10,216, `m1`=26,167, `m2`=37,490, `m3`=38,794, `m4`=28,394, `m5`=37,652, `m6`=37,718, `m7`=35,324, `m8`=20,837.

## Model details

### `m0` — M0 · Uniform baseline  ·  *baseline*

Zero-weight baseline: masked argmax collapses to the lowest-index legal cell, so it sweeps the grid blindly and detonates almost immediately. Defines the floor the trained variants must beat.

- **Method:** Uniform (zero logits)
- **Architecture:** width `32`, depth `3`, kernel `3x3`; layers: `conv3x3(8->32)+relu -> conv3x3(32->32)+relu -> conv3x3(32->16)+relu -> conv1x1(16->1) logits`; params `16,193`.
- **Training:** games `0`, epochs `0`, lr `0.0`, target `uniform (no training)`.
- **Train wall-clock:** ~0s on the current 10-vCPU build box (8 torch threads; board caps every cycle well under 10 minutes).
- **Reproduce:** `python3 tools/train.py --model m0`

### `m1` — M1 · Basic-rule imitation  ·  *solver-imitation*

Behaviour cloning of the deterministic solver using only the basic number rules (rem==0 / rem==len), no subset reasoning. Small width-32 net on a short schedule; the cheap weak-target floor that still guesses on hard frontiers.

- **Method:** Behaviour cloning (basic solver)
- **Architecture:** width `32`, depth `3`, kernel `3x3`; layers: `conv3x3(8->32)+relu -> conv3x3(32->32)+relu -> conv3x3(32->16)+relu -> conv1x1(16->1) logits`; params `16,225`.
- **Training:** games `2000`, epochs `16`, lr `0.002`, target `basic-solver`.
- **Train wall-clock:** ~61s on the current 10-vCPU build box (8 torch threads; board caps every cycle well under 10 minutes).
- **Reproduce:** `python3 tools/train.py --model m1`

### `m2` — M2 · Subset-solver imitation  ·  *solver-imitation*

Same cloning recipe as M1 but the demonstrations come from the solver with 1-level subset inference, so the target is stronger. Width raised to 48 to absorb the harder target; the workhorse mid-tier model and the warm-start for the two RL variants.

- **Method:** Behaviour cloning (subset solver)
- **Architecture:** width `48`, depth `3`, kernel `3x3`; layers: `conv3x3(8->48)+relu -> conv3x3(48->48)+relu -> conv3x3(48->16)+relu -> conv1x1(16->1) logits`; params `31,233`.
- **Training:** games `3000`, epochs `16`, lr `0.002`, target `subset-solver`.
- **Train wall-clock:** ~261s on the current 10-vCPU build box (8 torch threads; board caps every cycle well under 10 minutes).
- **Reproduce:** `python3 tools/train.py --model m2`

### `m3` — M3 · Wide + deep imitation  ·  *solver-imitation*

Capacity axis push: the same subset-solver target, but width 64 with an extra conv layer. Highest-parameter imitator, so it needs fewer epochs than M2 to converge; the reference to beat in CONCURRENT.

- **Method:** Behaviour cloning (subset solver, high capacity)
- **Architecture:** width `64`, depth `4`, kernel `3x3`; layers: `conv3x3(8->64)+relu -> conv3x3(64->64)+relu -> conv3x3(64->64)+relu -> conv3x3(64->16)+relu -> conv1x1(16->1) logits`; params `87,777`.
- **Training:** games `3000`, epochs `8`, lr `0.0015`, target `subset-solver`.
- **Train wall-clock:** ~421s on the current 10-vCPU build box (8 torch threads; board caps every cycle well under 10 minutes).
- **Reproduce:** `python3 tools/train.py --model m3`

### `m4` — M4 · Long-trained small imitation  ·  *solver-imitation*

Training-amount axis: identical width-32 architecture and basic-solver target as M1, but more demonstration games and a longer schedule. Isolates how far more data/optimisation steps help a small net on a weak target.

- **Method:** Behaviour cloning (basic solver, long schedule)
- **Architecture:** width `32`, depth `3`, kernel `3x3`; layers: `conv3x3(8->32)+relu -> conv3x3(32->32)+relu -> conv3x3(32->16)+relu -> conv1x1(16->1) logits`; params `16,225`.
- **Training:** games `3000`, epochs `24`, lr `0.002`, target `basic-solver`.
- **Train wall-clock:** ~321s on the current 10-vCPU build box (8 torch threads; board caps every cycle well under 10 minutes).
- **Reproduce:** `python3 tools/train.py --model m4`

### `m5` — M5 · Self-play (win reward)  ·  *rl*

Different objective: warm-started from M2 then optimised by REINFORCE on its own games, rewarded for each newly revealed safe cell plus a win bonus. Learns to chase clears directly instead of copying the solver.

- **Method:** REINFORCE fine-tune from M2
- **Architecture:** width `48`, depth `3`, kernel `3x3`; layers: `conv3x3(8->48)+relu -> conv3x3(48->48)+relu -> conv3x3(48->16)+relu -> conv1x1(16->1) logits`; params `31,233`.
- **Training:** games `2560`, epochs `10`, lr `0.0003`, target `self-play: +1/safe-reveal, +10 win, -10 mine`.
- **Train wall-clock:** ~93s on the current 10-vCPU build box (8 torch threads; board caps every cycle well under 10 minutes).
- **Reproduce:** `python3 tools/train.py --model m5`

### `m6` — M6 · Self-play (detonation-averse)  ·  *rl*

Second RL objective: same REINFORCE loop as M5 but a heavy detonation penalty. Trades some clears for caution, so its win/mine-hit profile differs from M5 and the imitators.

- **Method:** REINFORCE fine-tune from M2, safety-shaped reward
- **Architecture:** width `48`, depth `3`, kernel `3x3`; layers: `conv3x3(8->48)+relu -> conv3x3(48->48)+relu -> conv3x3(48->16)+relu -> conv1x1(16->1) logits`; params `31,233`.
- **Training:** games `2560`, epochs `10`, lr `0.0003`, target `self-play: +1/safe-reveal, +10 win, -40 mine`.
- **Train wall-clock:** ~83s on the current 10-vCPU build box (8 torch threads; board caps every cycle well under 10 minutes).
- **Reproduce:** `python3 tools/train.py --model m6`

### `m7` — M7 · Wide-kernel ablation (5x5)  ·  *ablation*

Architecture ablation: 5x5 kernels give every cell a two-cell receptive field instead of the one-cell 3x3 used by the other imitators, at the same width/depth as M2 (fewer games/epochs to stay in budget). Tests whether extra spatial context helps or hurts.

- **Method:** Behaviour cloning (subset solver, 5x5 kernels)
- **Architecture:** width `48`, depth `3`, kernel `5x5`; layers: `conv5x5(8->48)+relu -> conv5x5(48->48)+relu -> conv5x5(48->16)+relu -> conv1x1(16->1) logits`; params `86,529`.
- **Training:** games `2500`, epochs `8`, lr `0.002`, target `subset-solver`.
- **Train wall-clock:** ~242s on the current 10-vCPU build box (8 torch threads; board caps every cycle well under 10 minutes).
- **Reproduce:** `python3 tools/train.py --model m7`

### `m8` — M8 · Shallow ablation (single conv)  ·  *ablation*

Depth ablation: only one 3x3 feature-extraction conv before the 1x1 head, versus three in M2/M3. Same target and data as M2, so any gap is due to depth rather than target quality.

- **Method:** Behaviour cloning (subset solver, 1 hidden conv)
- **Architecture:** width `48`, depth `1`, kernel `3x3`; layers: `conv3x3(8->48)+relu -> conv3x3(48->16)+relu -> conv1x1(16->1) logits`; params `10,449`.
- **Training:** games `3000`, epochs `16`, lr `0.002`, target `subset-solver`.
- **Train wall-clock:** ~161s on the current 10-vCPU build box (8 torch threads; board caps every cycle well under 10 minutes).
- **Reproduce:** `python3 tools/train.py --model m8`

## Protocol

- **Seeds:** `1..500` (500 fixed seeds), one full game per seed.
- **Board:** 8x8, 10 mines, generated **exactly** like `src/engine.js` — canonical `mulberry32(seed)`, lazy placement on the first reveal, forbidden set `{first} ∪ neighbors(first)`, rejection sampling (one draw per attempt). Verified bit-identical for seeds `1..500`.
- **First click is guaranteed safe:** the first cell and its neighbors are always mine-free ("first-click safe" cascade).
- **Play loop:** featurize -> ONNX forward -> masked argmax over legal cells.
- **Action masking:** legal = `hidden & !flagged` (`hidden` = unrevealed and unflagged).
- **Determinism / tie-break:** `argmax` with the **lowest cell index** (row-major) wins ties. Given a (seed, checkpoint) the action sequence is fully reproducible.
- **win_rate** = cleared / seeds. **mine_hit_rate** = detonated / seeds. **stuck_rate** = no legal move and not won / seeds. **avg_safe_reveals** = mean safe cells revealed per game (54 = a full clear).

## Scoring

Frozen per-model score (POC v2): `points = safe_cells_revealed * 1 + (won ? 50 : 0)`. A detonation or stuck game ends with points earned so far.

## State contract (frozen)

`state = { hidden:Uint8Array(64), revealed:Uint8Array(64), flagged:Uint8Array(64), counts:Int8Array(64) }`, index `r*8+c`.
`hidden[i]` is 1 only for cells that are **unrevealed AND unflagged**. `counts[i]` is 0 for hidden cells (no leakage).

Channels (NCHW, `index = c*64 + i`): `0` hidden · `1` revealed · `2` flagged · `3` count/8 · `4` revealed-empty · `5` mines-remaining/hidden-count · `6` revealed-count/64 · `7` constant 1.

## Reproduce

```bash
python3 -m pip install -r tools/requirements.txt   # numpy, torch, onnx, onnxruntime

# Train all nine checkpoints (fully seeded, CPU only):
python3 tools/train.py --all
# …or a single model, e.g.:
for m in m0 m1 m2 m3 m4 m5 m6 m7 m8; do python3 tools/train.py --model $m; done

# Fixed-seed evaluation table + manifest v2 + docs:
python3 tools/eval.py --seeds 500 --manifest models/manifest.json --docs docs/checkpoints.md
```

Manifest version: `2`. ORT version pinned in `src/policy.js`: onnxruntime-web `1.19.2`, WASM backend single-threaded (`numThreads=1`) so it runs on GitHub Pages without COOP/COEP.

