"""ONNX export + validation helpers for the Minesweeper policy.

The exported graph contract (frozen):
  input  : float32 [1, 8, 8, 8]  NCHW   name = "input"
  output : float32 [1, 64]       logits name = "logits"

Everything here runs on CPU and produces small (< ~1 MB) models that load in
onnxruntime (Python) and onnxruntime-web (WASM).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch

OPSET = 17
INPUT_NAME = "input"
OUTPUT_NAME = "logits"


def export_model(model: torch.nn.Module, path: str) -> None:
    model.eval()
    dummy = torch.zeros(1, 8, 8, 8, dtype=torch.float32)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        dummy,
        path,
        input_names=[INPUT_NAME],
        output_names=[OUTPUT_NAME],
        opset_version=OPSET,
        do_constant_folding=True,
        dynamo=False,
    )


def validate_onnx(path: str, torch_model: torch.nn.Module | None = None) -> dict:
    """Check the ONNX model on disk: protobuf validity, shapes, and (optionally)
    numerical agreement with the source PyTorch model."""
    onnx.checker.check_model(path)
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0]
    out = sess.get_outputs()[0]
    if list(inp.shape) != [1, 8, 8, 8]:
        raise ValueError(f"{path}: unexpected input shape {inp.shape}")
    if list(out.shape) != [1, 64]:
        raise ValueError(f"{path}: unexpected output shape {out.shape}")

    rng = np.random.default_rng(0)
    x = rng.uniform(-1, 1, size=(1, 8, 8, 8)).astype(np.float32)
    logits = sess.run([out.name], {inp.name: x})[0]
    if logits.shape != (1, 64):
        raise ValueError(f"{path}: runtime output shape {logits.shape}")

    max_diff = None
    if torch_model is not None:
        torch_model.eval()
        with torch.no_grad():
            ref = torch_model(torch.from_numpy(x)).numpy()
        max_diff = float(np.abs(ref - logits).max())
        if max_diff > 1e-4:
            raise ValueError(f"{path}: torch/onnx mismatch {max_diff}")
    size_mb = Path(path).stat().st_size / (1024 * 1024)
    return {"path": path, "size_mb": round(size_mb, 4), "max_diff": max_diff}


def write_manifest(path: str, checkpoints: list) -> None:
    manifest = {
        "version": 2,
        "board": {"h": 8, "w": 8, "mines": 10},
        "input": {"shape": [1, 8, 8, 8], "layout": "nchw"},
        "output": {"shape": [1, 64], "type": "logits"},
        "checkpoints": checkpoints,
    }
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
