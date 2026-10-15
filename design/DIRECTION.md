# mines.livive.net — Art Direction

**Retro arcade cabinet direction for the first POC.**
Owner: Design (AIA-14). Implemented entirely in plain CSS (`src/style.css`); no build step, no framework, no JS required to express the look.

Everything below is the *intended* system. Where the shipped POC differs, it is called out as **[gap]** so Frontend can close it incrementally.

---

## 1. Concept

A single standing **arcade cabinet** viewed head-on, not a web page with arcade *decoration*.
Three layers, front to back:

1. **Scanlines / CRT glass** — a fixed, non-interactive overlay across the whole viewport.
2. **Cabinet chassis** — the marquee, the control deck (console), the play field (stage), the footer.
3. **Play field** — the 8×8 board, where all color is *semantic* (cell state), never decorative.

Mood: dim room, glowing magenta/cyan tube, chunky pixel type, soft bloom. Dark-first (there is no light theme; the CRT is the theme).

---

## 2. Palette (shipped tokens)

Defined once on `:root` in `src/style.css`. Treat as the source of truth — do not hard-code hex values elsewhere.

| Token | Hex | Role |
| --- | --- | --- |
| `--bg` | `#05050c` | Page void behind the cabinet |
| `--panel` | `#101024` | Control deck / HUD chassis |
| `--panel-2` | `#171733` | Nested raised surfaces |
| `--edge` | `#2c2c56` | 2px cabinet bezels / rule lines |
| `--ink` | `#e6e9ff` | Primary text (15.6:1 on `--panel`) |
| `--muted` | `#8b8fc4` | Secondary text / labels (6.1:1 on `--panel`) |
| `--magenta` | `#ff2fb9` | Signature accent — marquee bloom, AI side |
| `--cyan` | `#22e0ff` | Primary accent — focus, YOU side, links |
| `--yellow` | `#ffd23f` | Attention — active tab, selected cell |
| `--green` | `#4dff88` | Affirmative — toggles ON, win, "live" badge |
| `--red` | `#ff4d5e` | Danger — loss, detonated mine, flags |

### Accent discipline
Magenta and cyan are **identity**, not state. Only one should dominate a given region at a time:
- **YOU** column / human affordances → cyan.
- **AI** column / policy affordances → magenta.
- Don't tint a whole board magenta; the AI column title, the distribution bar gradient, and the selected-mine bloom carry it.

`--yellow` is reserved for *selection* and *current tab*. Don't reuse it for "warning".

---

## 3. Typography

Two families, both already loaded/available:

- **Display / chrome:** `Press Start 2P` (`--font-pixel`) — marquee, tabs, buttons, HUD values, verdict text. Use it only where text is chrome, never for body copy.
- **Data / body:** `ui-monospace, SFMono-Regular, Menlo, Consolas` (`--font-mono`) — numeric cells, hints, distribution rows, footer.

Rules:
- Uppercase + letter-spacing (`.1–.14em`) for all pixel-font labels. Pixel fonts need air.
- Pixel type never goes below **9px** on screen, and body/mono never below **10px**. **[gap]** the `.tagline` can render at 8px on small phones (`clamp(8px, 2.2vw, 11px)`) — raise the floor to 10px in a follow-up.
- Numbers on the board are `--font-mono`, weight 700, centered.

### Bloom
The marquee headline carries a three-stop shadow (cyan core → magenta glow → hard offset) to read as a lit tube. Bloom is allowed **only** on the marquee and the selected state. Do not add glow to ordinary UI text — it destroys AA contrast.

---

## 4. Marquee & CRT treatment

- **Marquee:** centered, `--edge` bezel, vertical gradient `#17173a → #0d0d20`, inset cyan haze + outer magenta bloom. The domain (`.dot`) sits on its own line in cyan, ~0.62em, so the brand reads `MINES` / `.livive.net`.
- **Scanlines:** `.scanlines` is `position: fixed; inset: 0; pointer-events: none; z-index: 100; mix-blend-mode: overlay;`, a 3px repeating white gradient at ~3% alpha. It must never intercept pointer events or cover focus.
- **CRT corners:** bezels use 12–14px radius so it reads as a tube, not a browser card. Board cells stay at 4px (chip-like), the play field frame at 12px.

**[gap]** Optional CRT curvature/vignette is *not* implemented; if added, keep it to a `radial-gradient` vignette on the `.cabinet` — never a filter that blurs or moves content.

---

## 5. Board cell states (semantic color)

The board is the only place with many colors, and each color means exactly one thing.

| State | Class | Treatment |
| --- | --- | --- |
| Hidden (cover) | `.cell` | Dark indigo bevel: `linear-gradient(150deg,#454570,#2a2a4a 60%,#20203c)`, inset top-light + bottom-shadow (physical key look) |
| Hidden hover | `.board:not(.finished) …:hover` | Bevel lightens |
| Revealed (plain) | `.revealed` | Flat sunken `#0c0c1e` |
| Revealed (empty) | `.revealed.empty` | Flatter still `#0a0a18` |
| Number 1–8 | `.n1 … .n8` | Blue / green / red / purple / yellow / teal / orange / near-white (see §6) |
| Flag | `.flagged` | CSS-drawn red pennant + light flagpole (no emoji) |
| Mine (revealed at loss) | `.mine` + `.mine-shown` | CSS-drawn crossed-shaft mine on `#2a0f18` |
| Detonated | `.mine.detonated` | `--red` fill + one-shot `detonate` flash |
| AI cursor/selection | `.selected` | Yellow 3px inset + bloom + slow `pulse` |
| AI heatmap | `.heat` | Cyan fill, alpha = normalized policy probability (`--heat`) |
| AI legal mask | `.legal` / `.illegal` | 1px green ring / 55% opacity |

**Keyboard focus is the one overlay that is not a game state:** `.cell:focus-visible` draws a cyan inset ring. It must always be visible, even on a `.selected` cell.

---

## 6. Number ramp

Standard Minesweeper density ramp, tuned to the dark field (all ≥ 4.5:1 on the revealed background — verified in `design/qa/shots/results.json`):

| N | Hex | Contrast on revealed |
| --- | --- | --- |
| 1 | `#4aa3ff` | 7.3 |
| 2 | `#4dff88` | 14.7 |
| 3 | `#ff6b6b` | 7.0 |
| 4 | `#c58bff` | 7.8 |
| 5 | `#ffd23f` | 13.4 |
| 6 | `#4de0e0` | 12.0 |
| 7 | `#ff9f43` | 9.5 |
| 8 | `#e8e8ff` | 16.0 |

If the revealed background is ever lightened, **re-measure this ramp** before shipping.

---

## 7. Heatmap & mask treatment **[gap — Frontend]**

The AI modes are the weakest part of the current visual system, and the only place worth a structure change.

- **Heat** currently fills a hidden cell with `rgba(34,224,255, var(--heat))` up to full opacity. At `--heat:1` the entire cell goes solid cyan, which (a) reads as "revealed/known" instead of "uncertain", and (b) floods the board so the 3D tile language disappears.
  **Recommended:** keep heat on hidden cells only (already true in `src/ui.js`) but cap the fill and re-express certainty as a **bottom-up bar** with a floor, e.g. tint from `calc(var(--heat)*0.55)` and reserve a 2px `--magenta` top edge for the argmax cell. Data-viz hue stays cyan; the *magnitude* should be readable at a glance without a legend.
- **Legend:** add a one-line "cyan = P(reveal) · ring = legal · dim = masked" caption to the AI HUD. There is none today, so a first-time viewer cannot decode the overlay.
- **Selected cell** already carries the strongest signal (yellow + bloom); keep it the only pulsing element.

Do not reintroduce the unused `.cell.heat.revealed` fill — heat belongs on hidden cells.

---

## 8. Motion

- **Purposeful only:** (1) cell cover→reveal background transition, 90ms linear; (2) selection `pulse` 700ms alternate; (3) one-shot `detonate` 320ms; (4) button press `translateY(1px)`.
- **Global rule:** anything that moves must collapse under `@media (prefers-reduced-motion: reduce)`. The shipped stylesheet already zeroes the cell transition, the selection pulse, and the detonate flash — keep that list complete as new motion is added. Motion must never be the *only* carrier of state (contrast/shape carry it too).
- No parallax, no autoplaying background loops, no marquee-scrolling text.

---

## 9. Layout & responsiveness

- One column, centered, `max-width: 1080px` cabinet.
- Breakpoint at **560px**: console stacks, tabs go full-width, race boards become a vertical stack, inputs stretch.
- Compact viewport target **390×844**; no horizontal scroll at any width (verified).
- Board sizing: `min(92vw, 440px)` on stage boards; `min(44vw, 330px)` per race side (`min(92vw,360px)` stacked).
- Touch: `touch-action: manipulation` on the board; long-press (420ms) = flag; tap = reveal; first tap is always mine-safe.

---

## 10. Voice

- Chrome labels are **UPPERCASE, terse, no punctuation**: `PLAY`, `AI`, `RACE`, `NEW`, `LINK`, `FLAG MODE`, `HEATMAP`, `MASK`, `RESET BOARD`.
- Body copy is sentence case, plain, instructive (the `.hint`).
- Verdicts are arcade callouts: `YOU WIN`, `AI WINS`, `BOTH LOST`, `DRAW`.
- Keep the pun set: "This cell is empty" (404), "deterministic seeds".

---

## 11. Definition of done for a visual change

1. Uses `:root` tokens; no new raw hex without adding a token.
2. All text ≥ 4.5:1 on its actual background (consider heat/mask overlays).
3. Keyboard focus remains visible on every newly styled control.
4. Collapses under `prefers-reduced-motion: reduce`.
5. Re-checked on Chromium desktop **and** a 390px mobile viewport.
