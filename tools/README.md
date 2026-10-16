# tools/ — Minesweeper policy training + evaluation

CPU-only pipeline that produces the nine ONNX checkpoints in `models/`.

| File | Purpose |
| --- | --- |
| `mines.py` | 8x8/10 engine, deterministic constraint solver, feature encoder. **Reference implementation of `src/featurize.js`.** |
| `registry.py` | The nine model variations: id, family, method, description, architecture, training recipe, seed. Shared by `train.py` and `eval.py`. |
| `train.py` | Uniform / behaviour-cloning / REINFORCE training of the fully-convolutional policy; exports ONNX. |
| `eval.py` | Fixed 500-seed evaluation through `onnxruntime`; writes manifest **v2** (`models/manifest.json`) and `docs/checkpoints.md`. |
| `export_onnx.py` | ONNX export + validation helpers. |
| `requirements.txt` | numpy / torch / onnx / onnxruntime. |

## Reproduce

```bash
python3 -m pip install -r tools/requirements.txt

# Train all nine checkpoints, in dependency order (RL models warm-start from m2):
python3 tools/train.py --all

# …or one at a time (hyperparameters come from registry.py):
for m in m0 m1 m2 m3 m4 m5 m6 m7 m8; do python3 tools/train.py --model $m; done

# Fixed-seed evaluation table + manifest v2 + docs:
python3 tools/eval.py --seeds 500 --manifest models/manifest.json --docs docs/checkpoints.md
```

Every model is fully seeded (`torch.manual_seed`, seeded `torch.Generator`), so reruns
reproduce the same weights and the same evaluation table.

**Compute budget:** the board capped training cycles at well under 10 minutes each on
the current hardware, so the demonstration counts and epochs in `registry.py` are
deliberately small — all nine checkpoints train in a few minutes each (and `--threads`
defaults to every core). See `docs/checkpoints.md` for measured wall-clock per model.

## The nine variations

Grouped into four families so CONCURRENT mode shows real spread:

| id | family | method | axis |
| --- | --- | --- | --- |
| `m0` | baseline | uniform weights | floor / uniform |
| `m1` | solver-imitation | BC, basic rules | target (weak) |
| `m2` | solver-imitation | BC, subset solver | target (stronger) |
| `m3` | solver-imitation | BC, subset solver | capacity (width+depth) |
| `m4` | solver-imitation | BC, basic rules, long schedule | training amount |
| `m5` | rl | REINFORCE from `m2`, win reward | objective (self-play) |
| `m6` | rl | REINFORCE from `m2`, detonation penalty | objective (safety-shaped) |
| `m7` | ablation | BC, subset solver, 5x5 convs | receptive field |
| `m8` | ablation | BC, subset solver, single conv | depth |

## Approach

1. **Demonstrations.** A deterministic constraint solver plays full games. Basic rules
   (`m1`/`m4` data) and basic + 1-subset reasoning (`m2`/`m3`/`m7`/`m8` data) label each
   visited state with a uniform distribution over the cells that are *provably safe*.
2. **Behaviour cloning.** A small fully-convolutional net maps `[1,8,8,8]` features to
   `[1,64]` logits. Training uses a masked soft-log-softmax cross-entropy whose legal mask
   is recovered from feature channel 0, so optimisation matches inference-time masking.
   `m7` widens every kernel to 5x5 (two-cell receptive field); `m8` keeps a single conv.
3. **Reinforcement learning.** `m5`/`m6` fine-tune `m2` with REINFORCE on their own games
   (safe-reveal reward + win bonus, with an optional heavy detonation penalty) — a different
   objective from imitation.
4. **Deterministic play.** At inference the logits are masked to the legal cells, softmaxed,
   and the argmax (lowest-index tie-break) is taken. This is what `src/policy.js` does in
   the browser. The exported graph is always `input float32[1,8,8,8] NCHW -> logits float32[1,64]`.
