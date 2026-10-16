# design/qa — mines.livive.net QA harness

Automated cross-browser / mobile / accessibility checks for the deployed POC, plus the
captured evidence used by [`../QA-REPORT.md`](../QA-REPORT.md).

## Contents

| File | Purpose |
| --- | --- |
| `run-qa.mjs` | Full suite: ONNX load, Play/AI/Race modes, first-click safety, `?seed=` determinism, the 9-checkpoint selector, **MODELS details panel** (all 9 cards vs manifest, ARIA, keyboard reach), **CONCURRENT mode** (9 boards, stepping, final classification + TOTAL POINTS, seed determinism), mobile (390×844), reduced motion, contrast math, console-error capture, screenshots. |
| `a11y-extra.mjs` | Deeper keyboard/ARIA probe: real key presses, 5-tab ARIA wiring, grid structure, focusability of non-interactive boards (AI, Race, **CONCURRENT**), **MODELS** list roles, `aria-live` mutation rate, touch-target sizes. |
| `shots/` | PNG screenshots + `results.json` / `a11y-extra.json` (machine-readable evidence). |

## Checks added for POC v2

- **Models panel** — 9 cards render; every card exposes label / family / description plus
  Family, Method, Architecture, Training, File size and Eval rows; rendered values are
  cross-checked against `models/manifest.json` (v2, 9 checkpoints); the panel is a
  `role="tabpanel"` with a `role="list"` of 9 `listitem`s and is reachable by arrow-key
  navigation across the tablist; readable (no overflow) at 390×844.
- **CONCURRENT mode** — 9 boards × 64 cells render; every policy loads; stepping advances
  per-model status/points; all 9 settle into cleared / detonated / stuck; `TOTAL POINTS`
  equals the sum of per-model points and includes the win bonus; the classification and
  total are legible (AA contrast, ≥24px total); the outcome is byte-identical for a fixed
  `?seed=` across two fresh contexts; no horizontal overflow at 390×844.

## Run

The harness uses Playwright's Chromium. In a Paperclip runner the browser and its
shared libraries are provided out-of-band; set the loader paths before invoking:

```bash
export LD_LIBRARY_PATH=<sysroot>/usr/lib/aarch64-linux-gnu
export FONTCONFIG_PATH=<sysroot>/etc/fonts
export XDG_DATA_DIRS=<sysroot>/usr/share:/usr/share
export PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs   # optional; defaults to 'playwright'
SITE=https://mines.livive.net SHOTS=design/qa/shots node design/qa/run-qa.mjs
SITE=https://mines.livive.net SHOTS=design/qa/shots node design/qa/a11y-extra.mjs
```

Point `SITE` at `http://localhost:8080` (after `python3 -m http.server 8080`) to check a
local checkout before deploying.
