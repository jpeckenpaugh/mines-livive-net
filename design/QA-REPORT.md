# mines.livive.net — POC QA Report

**v2 gate — Issue:** AIA-19 · **Owner:** Design · **Build reviewed:** live `https://mines.livive.net/` @ `fd3bc8d`
**Date:** 2026-10-16 · **Viewports:** Chromium 1280×900 and mobile 390×844 · **Engine:** Playwright 1.62.1 (Chromium)

Machine-readable evidence: [`qa/shots/results.json`](qa/shots/results.json) · [`qa/shots/a11y-extra.json`](qa/shots/a11y-extra.json).
Screenshots: [`qa/shots/`](qa/shots/). Harness: [`qa/run-qa.mjs`](qa/run-qa.mjs), [`qa/a11y-extra.mjs`](qa/a11y-extra.mjs).

**Result: PASS — 35/35 functional & accessibility gates, 0 console/page errors, 0 AA-contrast failures.**
Two low-risk legibility fixes were applied and deployed; one structural bug (pre-manifest CONCURRENT race) is filed to Frontend.

> Scope of this revision: the **Models details panel** and **CONCURRENT** mode added in POC v2, plus a
> regression pass over the original **Play / AI / Race** modes and the four structural a11y items filed in the
> [v1 report (AIA-14)](#appendix-a--v1-baseline-aia-14-still-passing).

---

## 1. Models details panel — all 9 checkpoints

| # | Gate | Result | Evidence |
| --- | --- | --- | --- |
| 1 | All 9 checkpoints render (manifest v2) | ✅ PASS | `results.json` `models.nine-checkpoints`; `desktop-models.png` |
| 2 | Every card shows label, family, description **and** Family/Method/Architecture/Training/File size/Eval rows | ✅ PASS | `models.all-fields-present` |
| 3 | Rendered values match `models/manifest.json` byte-for-byte (label, family, description, size, arch width+params, training games/epochs, eval win %) | ✅ PASS | `models.values-match-manifest` — 9/9 |
| 4 | Panel is a `role="tabpanel"`; content is a `role="list"` of 9 `listitem`s | ✅ PASS | `models.aria-structure` (`a11y-extra.json` `models`) |
| 5 | Content is keyboard-reachable: ArrowRight ×4 across the tablist lands on MODELS and exposes the 9 cards | ✅ PASS | `models.keyboard-reachable` |
| 6 | Readable at 390×844 — 9 cards, widest card 362px ≤ 390px viewport, 0px horizontal overflow, body text 11px / labels 10px | ✅ PASS | `models.mobile-readable`; `mobile-models.png` |

The panel notes "Manifest v2 · 9 checkpoints" from the live manifest. The currently-selected checkpoint carries
`aria-current="true"` (cyan border) — the m8 card in `desktop-models.png`.

## 2. CONCURRENT mode — 9 boards in lockstep

| # | Gate | Result | Evidence |
| --- | --- | --- | --- |
| 7 | 9 boards render (9 cards × 64 cells = 576) | ✅ PASS | `concurrent.nine-boards` (`desktop-concurrent-done.png`) |
| 8 | All 9 ONNX policies load (no LOADING/ERROR) | ✅ PASS | `concurrent.policies-loaded` |
| 9 | Stepping advances every model's status/moves/points | ✅ PASS | `concurrent.stepping-advances` (`results.json` `concurrentStep`) |
| 10 | All 9 settle to a final classification; counts sum to 9 | ✅ PASS | `concurrent.final-classification` |
| 11 | `TOTAL POINTS` equals the sum of per-model points | ✅ PASS | `concurrent.total-points-correct` (291 == 291) |
| 12 | Cleared models include the +50 win bonus (scoring contract) | ✅ PASS | `concurrent.points-include-win-bonus` |
| 13 | Leaderboard lists all 9, sorted by points | ✅ PASS | `concurrent.leaderboard-renders` |
| 14 | Classification + `TOTAL POINTS` are legible (AA contrast; total 40px desktop / 27.3px mobile) | ✅ PASS | `concurrent.total-legible` |
| 15 | Per-card state is announced (`aria-label` = model + status + moves + points) and the sr-only live region announces start/finish | ✅ PASS | `concurrent.states-announced`; live text recorded in `results.json` |
| 16 | Deterministic for `?seed=` — two fresh contexts on `seed=4242` produce byte-identical outcomes | ✅ PASS | `concurrent.deterministic-seed` |
| 17 | No horizontal overflow at 390×844 (2-col grid, 176px columns) | ✅ PASS | `concurrent.mobile-no-horizontal-overflow`; `mobile-concurrent.png` |

**Determinism record (`seed=4242`, both runs identical, total 593):**
`m0:detonated:22 · m1:detonated:53 · m2:cleared:104 · m3:cleared:104 · m4:detonated:52 · m5:detonated:52 · m6:cleared:104 · m7:detonated:52 · m8:detonated:50`
(`m2/m3/m6` clear, the rest detonate — a real spread across families.)

> The harness's default board (`seed=12345`) is a hard board where all nine detonate (total 291). That is a
> correct, reproducible outcome, not a fault: the policy never flags and its first reveal is always safe, but a
> 61%-win imitator still loses many boards. `?seed=4242` above shows the cleared/detonated split.

## 3. Original modes regression — Play / AI / Race

All v1 gates still pass on this build: ONNX runtime loads; first-click is mine-safe across 8 seeds;
`seed=777` reproduces byte-identically; AI autoplay steps with overlays and the **9-checkpoint** selector drives
every model (m0–m8 each produce an action); Race renders both 64-cell boards with advancing HUDs; mobile tap
reveals; no horizontal overflow; reduced motion collapses animation (`results.json` §1, `a11y-extra.json`).

| # | Gate | Result |
| --- | --- | --- |
| 18 | ONNX runtime loads; badge = "ONNX checkpoints live" | ✅ PASS |
| 19 | Play first-click-safe across 8 seeds | ✅ PASS |
| 20 | `?seed=` reproducible (Play) | ✅ PASS |
| 21 | AI autoplay steps + distribution + overlays | ✅ PASS |
| 22 | Checkpoint selector drives all 9 checkpoints | ✅ PASS (m0–m8) |
| 23 | Race mode: both boards + HUDs + auto AI play | ✅ PASS |
| 24 | Mobile tap reveals; no horizontal overflow | ✅ PASS |
| 25 | Reduced motion respected | ✅ PASS |
| 26–30 | `lang`, pinch-zoom, grid semantics + roving tabindex, visible focus, no new-tab ambiguity | ✅ PASS |
| 31 | 0 uncaught console / page errors, 0 failed requests | ✅ PASS |

## 4. AA contrast (WCAG 1.4.3) — 24/24 pairs pass, 0 failures

Minimum measured ratio **5.65** (`muted` on `panel-2`, leaderboard). v2 surfaces added to the matrix:

| New v2 pair | Ratio | Min | |
| --- | ---: | ---: | --- |
| `yellow` on `panel` (TOTAL POINTS) | 12.97 | 4.5 | ✅ |
| `green` on `panel` (cleared) | 14.24 | 4.5 | ✅ |
| `red` on `panel` (detonated) | 5.77 | 4.5 | ✅ |
| `cyan` on `panel` (cc-id / family) | 11.75 | 4.5 | ✅ |
| `ink` on `panel` (cc-points / model rows) | 15.57 | 4.5 | ✅ |
| `muted` on `panel` (model labels / status) | 6.08 | 4.5 | ✅ |
| `muted` on `panel-2` (leader stat) | 5.65 | 4.5 | ✅ |
| `ink` on `panel-2` (leader name) | 14.47 | 4.5 | ✅ |

Full 24-row table in `results.json` `contrast`.

## 5. Deployed fixes (applied in `src/style.css`, commit `fd3bc8d`)

| Fix | Why | Before → After |
| --- | --- | --- |
| `.model-family` 9px → 10px; `.model-row dt` 9px → 10px | Models panel micro-labels were below the legibility floor at 390×844. | Labels now 10px (`a11y-extra.json` `models.smallestFont: 10`). |
| `.cc-status` 9px → 10px + `.cc-line { flex-wrap: wrap; gap: 2px 8px }` | The CONCURRENT classification word (CLEARED/DETONATED/STUCK) — the most important text in a card — was 9px and cramped next to the move/points line on 2-col mobile. | Classification on its own 10px line, moves/pts wrap cleanly; still 0px overflow at 390×844. |

Both are token-driven and change no layout footprint; re-verified on the deployed build (commits pushed, Pages
rebuilt, harness re-run against the live URL).

## 6. Structural issue filed to Frontend

**P2 — CONCURRENT caches an empty field if opened before the manifest resolves.** `buildConcurrent()` runs on
the first `setMode('concurrent')`, but if `state.contract` is still `null` (manifest fetch in flight), `listCheckpoints()`
returns `[]`, yet `concurrent.built` is set `true`. Nothing rebuilds it when the manifest arrives, so the grid stays
**empty** until the user presses RESET. Reproduced deterministically by delaying `models/manifest.json` 3s and
opening CONCURRENT immediately: `0` cards rendered while `9` checkpoints loaded later (`results.json`
`concurrent.pre-manifest-race`, recorded as an info gate). Because `RUN = f(seed)` never starts, this also means no
per-model status is shown. Fix: rebuild concurrent (and re-`renderModels`) once the contract resolves, or gate
`buildConcurrent()` on `state.contract`. Attributed to Frontend (JS state owner); the harness already waits for the
manifest so the determinism gate itself is unaffected.

**P3 — Checkpoint `<select>` truncates long labels in the closed control.** On desktop it shows `M8 · Shallow ablation (`
(max-width 220px) and on mobile `M0 · Unif` (the select shares the row with the wide ONNX badge), so the selected
model name is not fully readable without opening the list. Options are correct and complete; this is a control-sizing
nit. Frontend/Design.

All four structural a11y issues filed in v1 are now **closed and verified**: HUD clock no longer in a live region
(`clockMutatePerSec: 0`), the 5-tab WAI-ARIA tablist is fully wired with Arrow/Home/End, the grid has 8 real
`role="row"`s, and non-interactive AI/Race/CONCURRENT boards expose 0 tab stops.

## 7. Reproduce

```bash
python3 -m http.server 8080     # in the repo root, then browse http://localhost:8080/?seed=12345
```

Automated suite (needs Playwright's Chromium and its system libs; the runner injects `LD_LIBRARY_PATH`/`FONTCONFIG_PATH`):

```bash
SITE=https://mines.livive.net SHOTS=design/qa/shots node design/qa/run-qa.mjs
SITE=https://mines.livive.net SHOTS=design/qa/shots node design/qa/a11y-extra.mjs
```

Console is clean on the reviewed build: no uncaught errors, no failed requests, and the ONNX WASM backend
initialises single-threaded without COOP/COEP.

---

## Appendix A — v1 baseline (AIA-14), still passing

The v1 report reviewed build `aa28047` (18/18 gates). Its three deployed focus/contrast CSS fixes
(`.tab:focus-visible` inset ring, `color-scheme: dark`, explicit link focus ring) remain in effect and are
re-covered by the current suite; its four filed structural issues are resolved (see §6).
