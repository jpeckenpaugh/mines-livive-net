# design/qa — mines.livive.net QA harness

Automated cross-browser / mobile / accessibility checks for the deployed POC, plus the
captured evidence used by [`../QA-REPORT.md`](../QA-REPORT.md).

## Contents

| File | Purpose |
| --- | --- |
| `run-qa.mjs` | Full suite: ONNX load, Play/AI/Race modes, first-click safety, `?seed=` determinism, checkpoint selector, mobile (390×844), reduced motion, contrast math, console-error capture, screenshots. |
| `a11y-extra.mjs` | Deeper keyboard/ARIA probe: real key presses, tab ARIA wiring, grid structure, focusability of non-interactive boards, `aria-live` mutation rate. |
| `shots/` | PNG screenshots + `results.json` / `a11y-extra.json` (machine-readable evidence). |

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
