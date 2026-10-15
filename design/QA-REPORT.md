# mines.livive.net — POC QA Report

**Issue:** AIA-14 · **Owner:** Design · **Build reviewed:** live `https://mines.livive.net/` @ `aa28047`
**Date:** 2026-10-15 · **Viewports:** Chromium 1280×900 and mobile 390×844 · **Engine:** Playwright 1.62.1 (Chromium)

Machine-readable evidence: [`qa/shots/results.json`](qa/shots/results.json) · [`qa/shots/a11y-extra.json`](qa/shots/a11y-extra.json).
Screenshots: [`qa/shots/`](qa/shots/). Harness: [`qa/run-qa.mjs`](qa/run-qa.mjs), [`qa/a11y-extra.mjs`](qa/a11y-extra.mjs).

**Result: PASS — 18/18 functional & accessibility checks, 0 console/page errors, 0 AA-contrast failures.**
Three low-risk focus/contrast CSS fixes were made and deployed; four structural a11y issues are filed to Frontend (JS/HTML owners).

---

## 1. What was verified (pass/fail)

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | ONNX runtime loads; badge = "ONNX checkpoints live" | ✅ PASS | `results.json` `onnx.runtime-loads`; `desktop-ai.png` |
| 2 | Play mode renders; first click is mine-safe | ✅ PASS | 8 seeds (1,2,3,7,42,12345,99999,424242) never LOST on first reveal; `results.json` `play.first-click-safe` |
| 3 | Deterministic `?seed=` (reload reproduces board) | ✅ PASS | `seed=777` produces byte-identical cell signature across two fresh contexts (`play.deterministic-seed`) |
| 4 | AI mode autoplay: steps, picked cell, confidence | ✅ PASS | moves + `PICKED`/`CONFIDENCE` populated (`ai.autoplay-steps`, `desktop-ai.png`) |
| 5 | AI overlays: selection, heatmap, legal mask render | ✅ PASS | selected=1, heat=49, mask=49 (`ai.overlays-render`) |
| 6 | Checkpoint selector drives all three checkpoints | ✅ PASS | m0/m1/m2 each produce a move; badge stays live (`ai.checkpoint-selector`) |
| 7 | Race mode: both boards + HUDs + auto AI play | ✅ PASS | 64+64 cells, AI advances (`race.mode-renders`, `desktop-race.png`) |
| 8 | Mobile tap reveals (390×844, touch) | ✅ PASS | tap → PLAYING, 15 cells revealed (`mobile.tap-reveals`, `mobile-play.png`) |
| 9 | No horizontal overflow on mobile | ✅ PASS | scrollWidth 390 = clientWidth 390 (`mobile.no-horizontal-overflow`) |
| 10 | Reduced-motion collapses animation | ✅ PASS | selection + detonate `animation-name: none` (`a11y.reduced-motion`, `desktop-reduced-motion.png`) |
| 11 | `lang` present | ✅ PASS | `lang="en"` (`a11y.html-lang`) |
| 12 | Pinch-zoom allowed | ✅ PASS | no `user-scalable=no` / `maximum-scale=1` (`a11y.zoom-allowed`) |
| 13 | Board exposes grid semantics + roving tabindex | ✅ PASS | `role="grid"`, 1 tabbable cell (`a11y.board-grid-semantics`, `play.keyboard-navigate`) |
| 14 | Keyboard: arrows move cursor, Enter reveals, F flags | ✅ PASS | `A1→B1`, Enter revealed 31 cells, F set 1 flag (`a11y-extra.json`) |
| 15 | Visible focus indicator on controls | ✅ PASS (after fix) | tab ring now fully drawn inside the clipped container (`desktop-focus-tab.png`) |
| 16 | No new-tab ambiguity | ✅ PASS | 0 `target="_blank"`; the only link opens in the same tab (`a11y.no-new-tab-ambiguity`) |
| 17 | No uncaught console / page errors across all runs | ✅ PASS | 0 console, 0 page errors, 0 failed requests (`console.no-uncaught-errors`) |
| 18 | AA contrast on core UI + number ramp | ✅ PASS | see §3; 0 failing pairs (`results.json` `contrast`) |

Screenshots: `desktop-play.png`, `desktop-ai.png`, `desktop-race-ready.png`, `desktop-race.png`, `desktop-reduced-motion.png`, `desktop-focus-cell.png`, `desktop-focus-tab.png`, `mobile-play.png`, `mobile-ai.png`, `mobile-race.png`.

---

## 2. Deployed fixes (applied in `src/style.css`, commit `aa28047`)

| Fix | Why | Before → After |
| --- | --- | --- |
| `.tab:focus-visible { outline-offset: -2px }` | `.tabs` uses `overflow:hidden` for its rounded ends, which **clipped the outer focus ring** — only a 1px cyan sliver was visible on a focused mode tab (keyboard-focus visibility problem). | `desktop-focus-tab.png` (ring now complete) |
| `:root { color-scheme: dark }` | Native form widgets (number input, select popup, scrollbars, range) were rendering with light UA chrome on a dark cabinet. | verified live: `a11y-extra.json` `colorScheme: "dark"` |
| `a:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px }` | The footer "source" link relied on the UA focus ring; now matches the cabinet focus treatment. | verified: computed `solid 2px` |

All three are CSS-only, token-driven, and change no layout. Re-verified on the deployed build.

---

## 3. AA contrast (WCAG 1.4.3) — 17/17 pairs pass

Core UI (measured from live computed tokens):

| Pair | Ratio | Min | |
| --- | ---: | ---: | --- |
| `--ink` #e6e9ff on `--panel` #101024 | 15.57 | 4.5 | ✅ |
| `--muted` #8b8fc4 on `--panel` | 6.08 | 4.5 | ✅ |
| `--muted` on `--bg` #05050c | 6.60 | 4.5 | ✅ |
| `--cyan` on `--panel` | 11.75 | 4.5 | ✅ |
| `--green` on `--panel` | 14.24 | 4.5 | ✅ |
| `--yellow` on `--panel` | 12.97 | 4.5 | ✅ |
| `--red` on `--panel` | 5.77 | 4.5 | ✅ |
| active tab text on `#ff9f43` | 9.96 | 4.5 | ✅ |

Number ramp on the revealed background #0c0c1e: n1 7.34 · n2 14.70 · n3 6.96 · n4 7.83 · n5 13.38 · n6 12.01 · n7 9.47 · n8 16.02 — all ✅.
Tagline muted text on the marquee gradient: 5.59 (top) / 6.23 (bottom) — ✅.

> Note: heat/mask overlays are applied to **hidden** cells only (`src/ui.js` line 195), so they never sit behind a number and cannot reduce text contrast. Confirmed in `desktop-ai.png`.

---

## 4. Structural accessibility issues — filed to Frontend (they own `index.html` + `src/*.js`)

These are real conformance gaps that must be fixed in markup/JS, not CSS. None is a shipping blocker for the board POC, but all should be closed before this becomes a flagship surface.

1. **`aria-live` HUD announces the clock ~4×/second (P1).** Both `<aside class="hud">` regions are `aria-live="polite"` and *contain the TIME readout*, which mutates on a 250ms interval. Measured **5 mutations / 1.2s** (`a11y-extra.json` `clockMutatePerSec: 5`). Screen-reader users get non-stop time chatter. Fix: move `aria-live` off the whole HUD — put it on a status element that excludes TIME, or set the clock container `aria-hidden`/`role="presentation"`.
2. **Tablist is declared but not wired (P1).** `.tab`s are `role="tab"` with **no `aria-controls`**, panels have **no `role="tabpanel"` / `id` / `aria-labelledby`**, and there is **no Arrow-Left/Right navigation** (ArrowRight on the PLAY tab did nothing — `a11y-extra.json` `tabAfterArrowRight`). Finish the WAI-ARIA Tabs pattern or drop the roles and expose them as a plain button group with `aria-pressed`.
3. **`role="grid"` has no rows (P2).** 64 `gridcell`s are direct children of the grid with no `role="row"` and no `aria-rowcount`/`aria-colcount` (`a11y-extra.json` `grid`). Either add 8 `role="row"` wrappers, or drop `role="grid"`/`gridcell` and use a labelled button group.
4. **Non-interactive AI boards are still keyboard-focusable (P2).** `#ai-board` and `#race-ai` each expose 1 focusable cell (`a11y-extra.json`), so Tab lands in a board that ignores keys. Set `tabindex="-1"` on cells of non-interactive boards.

Secondary (P3): the `LINK` copy button's "Copied!"/`Copy blocked` flash is a CSS `::after` and is never announced; raise `.tagline` minimum size from 8px; add a decode caption for the heat/mask overlays (see `DIRECTION.md` §7).

---

## 5. Prioritized fix list

| P | Item | Owner | Status |
| --- | --- | --- | --- |
| P1 | Clipped focus ring on mode tabs | Design | ✅ Fixed + deployed (`aa28047`) |
| P1 | Dark `color-scheme` for native controls | Design | ✅ Fixed + deployed |
| P1 | Explicit link focus ring | Design | ✅ Fixed + deployed |
| P1 | `aria-live` HUD clock chatter | Frontend | Filed (issue below) |
| P1 | Finish/drop tablist ARIA + arrow keys | Frontend | Filed |
| P2 | `role="grid"` missing rows | Frontend | Filed |
| P2 | Non-interactive boards focusable | Frontend | Filed |
| P2 | Heat/mask legend + heat treatment (per `DIRECTION.md` §7) | Frontend | Filed |
| P3 | Copy-flash not announced; tagline 8px floor | Frontend | Filed |

Structural items are handed off as a self-contained follow-up task assigned to Frontend (courier), linked from the AIA-14 thread.

---

## 6. Reproduce

```bash
python3 -m http.server 8080     # in the repo root, then browse http://localhost:8080/?seed=12345
```

Automated suite (needs Playwright's Chromium and its system libs; the runner injects `LD_LIBRARY_PATH`/`FONTCONFIG_PATH`):

```bash
SITE=https://mines.livive.net SHOTS=design/qa/shots node design/qa/run-qa.mjs
SITE=https://mines.livive.net SHOTS=design/qa/shots node design/qa/a11y-extra.mjs
```

Console is clean on the reviewed build; there were no uncaught errors, no failed network requests, and the ONNX WASM backend initialised single-threaded without COOP/COEP.
