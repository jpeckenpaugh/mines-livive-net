# 💣 MINES.livive.net — RL Minesweeper Arcade Cabinet

> **Human Intuition vs. 9 ONNX Neural Policies** — Play deterministic 8×8 Minesweeper seeds, inspect live action-mask and confidence heatmaps, race an RL policy side-by-side, or watch all 9 checkpoints compete in lockstep.

[![Play Now on Livive](https://img.shields.io/badge/▶_PLAY_NOW-mines.livive.net-10b981?style=for-the-badge)](https://mines.livive.net/)

---

## 🎮 Play in Your Browser ([mines.livive.net](https://mines.livive.net/))

This arcade cabinet features **5 distinct modes** powered by ONNX Runtime Web and custom reinforcement learning checkpoints trained on 8×8 Minesweeper:

1. **`PLAY`** — Classic 8×8 Minesweeper with first-click safety, timer, flag counter, and win/loss tracking.
2. **`AI`** — Step or autoplay any of the 9 ONNX model checkpoints with live cyan confidence heatmaps ($P(\text{reveal})$) and legal-action rings.
3. **`RACE`** — Head-to-head match: human player vs. chosen RL policy side-by-side on the exact same deterministic seed.
4. **`CONCURRENT`** — Simultaneous lockstep race of all 9 ONNX model checkpoints across the same board.
5. **`MODELS`** — Full architecture breakdown, evaluation metrics, and training parameters for all checkpoints.

### 🔗 Shareable Seeds
Every board can be reproduced or shared via URL parameters:
```
https://mines.livive.net/?seed=12345
```

---

## 🛠️ For Developers (The Other 10%)

### Local Static Serving
You can run the web cabinet locally using any static HTTP server:
```bash
python3 -m http.server 8000
```
Then open `http://localhost:8000`.

### Test Runner & Showcase Generator
We include a Playwright-based test runner that exercises all arcade tabs and generates a 30.5-second showcase video (`demo.webm`) and UI screenshots:
```bash
cd test-runner
./run.sh --showcase
```

### Architecture Overview
- [`index.html`](file:///Users/jarad/git/netfix/mines-livive-net/index.html) — Single-file responsive arcade UI and Tailwind styling.
- [`src/`](file:///Users/jarad/git/netfix/mines-livive-net/src/) — JavaScript modules for game logic, ONNX inference, and rendering.
- [`models/manifest.json`](file:///Users/jarad/git/netfix/mines-livive-net/models/manifest.json) — Registry of ONNX policy checkpoints.
- [`docs/`](file:///Users/jarad/git/netfix/mines-livive-net/docs/) — Design docs, specs, and training notes.
