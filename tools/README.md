# tools/ — Minesweeper policy training + evaluation

CPU-only pipeline that produces the ONNX milestone checkpoints in `models/`.

| File | Purpose |
| --- | --- |
| `mines.py` | 8x8/10 engine, deterministic constraint solver, feature encoder. **Reference implementation of `src/featurize.js`.** |
| `train.py` | Behaviour-cloning training of the fully-convolutional policy; exports ONNX (`m0` baseline, `m1`/`m2` trained). |
| `eval.py` | Fixed 500-seed evaluation through `onnxruntime`; writes `models/manifest.json` and `docs/checkpoints.md`. |
| `export_onnx.py` | ONNX export + validation helpers. |
| `requirements.txt` | numpy / torch / onnx / onnxruntime. |

## Reproduce

```bash
python3 -m pip install -r tools/requirements.txt

python3 tools/train.py --stage m0 --out models/policy-m0.onnx
python3 tools/train.py --stage m1 --out models/policy-m1.onnx --games 2500 --epochs 40 --width 32 --lr 2e-3
python3 tools/train.py --stage m2 --out models/policy-m2.onnx --games 6000 --epochs 30 --width 48 --lr 2e-3

python3 tools/eval.py --seeds 500 --manifest models/manifest.json --docs docs/checkpoints.md
```

Every stage is fully seeded (`torch.manual_seed` / `random.Random`), so reruns reproduce the
same weights and the same evaluation table.

## Approach

1. **Demonstrations.** A deterministic constraint solver plays full games. Basic rules
   (`m1` data) and basic + 1-subset reasoning (`m2` data) label each visited state with a
   uniform distribution over the cells that are *provably safe*.
2. **Behaviour cloning.** A small fully-convolutional net maps `[1,8,8,8]` features to
   `[1,64]` logits. Training uses a masked soft-log-softmax cross-entropy whose legal mask
   is recovered from feature channel 0, so optimisation matches inference-time masking.
3. **Deterministic play.** At inference the logits are masked to the legal cells, softmaxed,
   and the argmax (lowest-index tie-break) is taken. This is what `src/policy.js` does in
   the browser.
