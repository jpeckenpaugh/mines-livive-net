# mines-livive-net

An in-browser retro arcade cabinet running Reinforcement Learning policies on a discrete 8x8 Minesweeper engine. Race human intuition against ONNX-exported checkpoints across training milestones with live action-masking and deterministic board seeds. The v2 library ships **nine** documented checkpoints across four families and five modes: **PLAY**, **AI**, **RACE**, **CONCURRENT**, and **MODELS**.

**Live:** https://mines.livive.net/

## Layout

| Path | Owner | Purpose |
| --- | --- | --- |
| `index.html`, `src/*.js`, `src/style.css` | Frontend | Arcade cabinet UI, deterministic engine, mode orchestration |
| `models/*.onnx`, `src/featurize.js`, `src/policy.js`, `tools/*` | Prototype | Policy checkpoints + CPU training/eval pipeline |
| `.nojekyll`, `robots.txt`, `sitemap.xml`, `404.html`, `.github/workflows/*` | Platform | Hosting, caching, uptime/smoke |

## Run locally

The app is a static ES-module bundle that fetches `models/manifest.json` and
`models/*.onnx`, so it must be served over HTTP (not opened via `file://`):

```bash
python3 -m http.server 8080
# open http://localhost:8080/
```

Optional pinned query string for a reproducible board: `/?seed=12345`.

## Modes

| Tab | What it does |
| --- | --- |
| **PLAY** | You clear a seeded 8×8/10 board (first click is always safe). |
| **AI** | The selected checkpoint plays the same seed with live confidence, per-cell distribution, and legal-action mask. |
| **RACE** | You vs the checkpoint on the identical seed, side by side, with an outcome comparison. |
| **CONCURRENT** | Every checkpoint in the library plays the same `?seed=` board in lockstep, with a CLEARED/DETONATED/STUCK scoreboard and a points-sorted leaderboard. |
| **MODELS** | Details for every manifest checkpoint: family, method, architecture, training recipe, file size, and fixed-seed evaluation. |

Scores come from `manifest.scoring` when present, else the documented default:
`1 pt` per safely revealed cell plus a `50 pt` win bonus.

## Model library (v2)

Nine ONNX checkpoints across four families, documented in
[`docs/checkpoints.md`](docs/checkpoints.md) and the live MODELS tab:

| ID | Family | Method | Win rate |
| --- | --- | --- | ---: |
| `m0` | baseline | Uniform (zero logits) | 0.0% |
| `m1` | solver-imitation | Behaviour cloning (basic solver) | 28.8% |
| `m2` | solver-imitation | Behaviour cloning (subset solver) | 56.4% |
| `m3` | solver-imitation | Behaviour cloning (subset, wide + deep) | 61.4% |
| `m4` | solver-imitation | Behaviour cloning (basic, long schedule) | 36.0% |
| `m5` | rl | REINFORCE (win reward) | 57.4% |
| `m6` | rl | REINFORCE (detonation-averse) | 57.8% |
| `m7` | ablation | Behaviour cloning (5×5 kernels) | 51.0% |
| `m8` | ablation | Behaviour cloning (single conv) | 11.8% |

`models/manifest.json` is the single source of truth: `version: 2` plus a
`checkpoints[]` array whose `file` paths drive both the app and the smoke
workflow. The frozen state contract (`src/featurize.js`, `src/policy.js`,
`src/engine.js` board/seed generation) is unchanged.

## Deploy

Hosting is the **GitHub Pages legacy build from `main` `/`** (source = branch
`main`, folder `/`), served at the custom domain `mines.livive.net` (TLS cert
approved). Pushing to `main` is the whole deploy:

1. Commit to `main`.
2. Pages rebuilds automatically (legacy source, ~30-50s). Watch it:
   `gh api repos/jpeckenpaugh/mines-livive-net/pages/builds/latest`
3. The build is complete when `status` is `built` and `commit` matches `git rev-parse main`.

`.nojekyll` at the repo root disables Jekyll so Pages serves the repo **verbatim** —
required so `models/`, `src/`, and binary `.onnx` assets are never transformed or
dropped. Do not remove it. `CNAME` holds the custom domain; `404.html` is served
(for HTTP 404s) by Pages automatically.

> **Why legacy and not Actions Pages?** The `main` `/` legacy source already serves
> the committed `index.html` at the custom domain over HTTPS with zero moving parts.
> Keeping it avoids a build step that could regress the board demo. The external
> `smoke` workflow (below) is our guard that the live site stays correct.

## Verify (uptime + asset smoke)

`.github/workflows/smoke.yml` runs on every push to `main`, every 15 minutes, and
on demand. It asserts, from outside the repo:

- `https://mines.livive.net/` is **200** and **byte-identical to the committed `index.html`** (i.e. the app, not the README);
- `models/manifest.json` is 200, parses as **v2** (`version: 2`) with exactly **9** unique checkpoints, and **every** checkpoint `file` is 200;
- the full ES module graph (`src/app.js` → `engine.js`/`ui.js`/`contract.js`/`featurize.js`/`policy.js`/`stub/*`) and `src/style.css` are 200;
- the pinned onnxruntime-web CDN runtime (`ort.wasm.min.mjs`, `ort-wasm-simd-threaded.wasm`) is 200;
- unknown paths return **404**.

Run it manually: `gh workflow run smoke` (or **Actions → smoke → Run workflow**).

Manual one-liner:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://mines.livive.net/
curl -sS -o /dev/null -w '%{http_code}\n' https://mines.livive.net/models/manifest.json
```

## Assets, content types, and caching

- **ONNX models** are binary and are served as `application/octet-stream`. Fetching
  them as `arrayBuffer` (see `src/policy.js`) is type-agnostic, so this is correct.
- **onnxruntime-web `1.19.2`** is loaded from the pinned jsDelivr CDN
  (`https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/`), not vendored. jsDelivr
  serves `.wasm` as `application/wasm` and caches versioned URLs immutably.
- **GitHub Pages sets `Cache-Control: max-age=600` on every response and does not
  allow custom response headers.** Long-cache guidance therefore is:
  - Do **not** expect to set long `max-age`/`immutable` here — 10 minutes is fixed.
  - Treat published filenames as **append-only**. When a model or hashed asset
    changes, publish it under a new name/path (e.g. `policy-m3.onnx`,
    `policy-m2.<hash>.onnx`) and reference the new path; never overwrite a
    long-lived URL in place, since caches (browser/CDN) may hold it for up to 10
    minutes plus revalidation.
  - Keep the heavy, immutable runtime (ORT wasm) on the versioned CDN, which does
    cache it long and offloads it from the Pages origin.
- **No COOP/COEP on GitHub Pages**, so `SharedArrayBuffer` is unavailable and the
  ORT WASM backend must run single-threaded. `src/policy.js` already pins
  `ort.env.wasm.numThreads = 1` and `proxy = false`; keep it that way.
