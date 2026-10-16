"""Validate ``models/manifest.json`` (v2) against the frozen POC v2 schema.

Checks the shape the Frontend/Platform/Design tasks depend on:

* ``version`` is ``2`` and a ``scoring`` block is present;
* exactly 9 checkpoints, each with id / label / family / method / file /
  description / architecture{width,layers,params} / training{games,epochs,lr,
  target} / size_bytes / eval{win_rate,mine_hit_rate,stuck_rate,
  avg_safe_reveals};
* at least two distinct families and no duplicate ids/files;
* every ``file`` exists, ``size_bytes`` matches, and the graph loads in
  ``onnxruntime`` with the frozen ``[1,8,8,8] -> [1,64]`` float32 contract.

    python3 tools/validate_manifest.py --manifest models/manifest.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import onnxruntime as ort

REQUIRED = ("id", "label", "family", "method", "file", "description",
            "architecture", "training", "size_bytes", "eval")
REQUIRED_EVAL = ("win_rate", "mine_hit_rate", "stuck_rate", "avg_safe_reveals")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default="models/manifest.json")
    args = ap.parse_args()

    root = Path(args.manifest).resolve().parent.parent
    manifest = json.loads(Path(args.manifest).read_text())

    assert manifest.get("version") == 2, "version must be 2"
    assert isinstance(manifest.get("scoring"), dict), "missing scoring block"
    assert "safe_reveal_points" in manifest["scoring"], "scoring.safe_reveal_points"
    assert "win_bonus" in manifest["scoring"], "scoring.win_bonus"

    ckpts = manifest["checkpoints"]
    assert len(ckpts) == 9, f"expected 9 checkpoints, got {len(ckpts)}"

    ids, families, files = set(), set(), set()
    for c in ckpts:
        for key in REQUIRED:
            assert key in c, f"{c.get('id')}: missing {key}"
        assert c["id"] not in ids, f"duplicate id {c['id']}"
        ids.add(c["id"])
        families.add(c["family"])
        assert c["file"] not in files, f"duplicate file {c['file']}"
        files.add(c["file"])
        assert len(c["description"]) > 40, f"{c['id']}: description too short"
        assert set(("width", "layers", "params")) <= set(c["architecture"]), f"{c['id']}: architecture keys"
        assert set(("games", "epochs", "lr", "target")) <= set(c["training"]), f"{c['id']}: training keys"
        for key in REQUIRED_EVAL:
            assert key in c["eval"], f"{c['id']}: eval missing {key}"

        path = root / c["file"]
        assert path.exists(), f"{c['id']}: missing file {path}"
        assert path.stat().st_size == c["size_bytes"], f"{c['id']}: size_bytes mismatch"
        sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        inp, out = sess.get_inputs()[0], sess.get_outputs()[0]
        assert list(inp.shape) == [1, 8, 8, 8], f"{c['id']}: input {inp.shape}"
        assert list(out.shape) == [1, 64], f"{c['id']}: output {out.shape}"
        assert inp.type == "tensor(float)", f"{c['id']}: input type {inp.type}"
        print(f"  ok {c['id']:>2}  {c['family']:<16} {c['file']}")

    assert len(families) >= 2, "need at least 2 distinct families"
    print(f"\nOK: {len(ckpts)} checkpoints, {len(families)} families: {sorted(families)}")
    print(f"scoring: {manifest['scoring']}")


if __name__ == "__main__":
    main()
