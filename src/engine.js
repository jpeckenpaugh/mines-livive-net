/**
 * engine.js — Deterministic 8x8 / 10-mine Minesweeper engine.
 *
 * Zero DOM dependencies. Pure state machine so it can run in the UI thread,
 * a Web Worker, or a headless Node test runner. This module is the reference
 * implementation for the board/seed spec; the RL trainer must reproduce the
 * exact same algorithm for a given seed.
 *
 * ---------------------------------------------------------------------------
 * FROZEN SEEDED-BOARD SPEC (Prototype's trainer MUST match this exactly)
 * ---------------------------------------------------------------------------
 * Cell index is row-major: index = r * 8 + c, so cells live in 0..63.
 *
 *   1. rand = mulberry32(seed >>> 0)   // 32-bit seed; canonical mulberry32.
 *   2. Mines are NOT placed at construction time. Placement is deferred until
 *      the first reveal action on the board (lazy placement).
 *   3. When the first reveal happens at cell `f`, build the forbidden set
 *            F = { f } ∪ neighbors(f)      // 4 (corner) to 9 (interior) cells
 *   4. Repeatedly draw `c = floor(rand() * 64)` and insert `c` into the mine
 *      set until it holds exactly 10 DISTINCT cells, skipping any `c` that is
 *      already a mine or that lies in F. Because |F| <= 9 there are always at
 *      least 55 eligible cells, so 10 mines are always placeable and placement
 *      never loops forever.
 *   5. Adjacency counts are then computed as the number of neighboring mines
 *      (0..8) for every cell.
 *
 * Consequence: the first-clicked cell always has 0 adjacent mines, so its
 * reveal cascades the contiguous zero region — "first-click safe".
 *
 * The same `rand` stream ordering (rejection sampling, one draw per attempt)
 * is what both implementations consume; do not re-order the draws.
 * ---------------------------------------------------------------------------
 */

export const H = 8;
export const W = 8;
export const SIZE = H * W; // 64
export const MINES = 10;

/** Canonical mulberry32 PRNG. Returns a function producing floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Orthogonal + diagonal neighbors of a row-major cell index. */
export function neighbors(cell) {
  const r = (cell / W) | 0;
  const c = cell % W;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < H && nc >= 0 && nc < W) out.push(nr * W + nc);
    }
  }
  return out;
}

/**
 * Place mines for a board. Exported so tests/tools can reproduce placement
 * without instantiating a full Game.
 *
 * @param {Function} rand - mulberry32 stream
 * @param {number} first - first-clicked cell (always excluded, with neighbors)
 * @param {number} [mines=MINES]
 * @returns {Set<number>} mine cell indices
 */
export function placeMines(rand, first, mines = MINES) {
  const forbidden = new Set([first, ...neighbors(first)]);
  const chosen = new Set();
  while (chosen.size < mines) {
    const c = Math.floor(rand() * SIZE);
    if (forbidden.has(c) || chosen.has(c)) continue;
    chosen.add(c);
  }
  return chosen;
}

export const STATUS = Object.freeze({
  READY: 'ready',
  PLAYING: 'playing',
  WON: 'won',
  LOST: 'lost',
});

export class Game {
  /** @param {number} seed integer seed */
  constructor(seed = 0) {
    this.reset(seed);
  }

  reset(seed = this.seed) {
    this.seed = (Number(seed) || 0) >>> 0;
    this.rand = mulberry32(this.seed);
    this.mines = new Set();
    this.minesPlaced = false;
    this.revealed = new Uint8Array(SIZE);
    this.flagged = new Uint8Array(SIZE);
    this.counts = new Int8Array(SIZE);
    this.status = STATUS.READY;
    this.revealedCount = 0;
    this.flagCount = 0;
    this.moves = 0;
    this.detonated = -1;
    return this;
  }

  get size() {
    return SIZE;
  }

  get finished() {
    return this.status === STATUS.WON || this.status === STATUS.LOST;
  }

  /** Remaining mines (never negative), from the human flag budget view. */
  get minesRemaining() {
    return Math.max(0, MINES - this.flagCount);
  }

  isMine(cell) {
    return this.mines.has(cell);
  }

  /** @private Place mines now for `first`, then compute adjacency counts. */
  _place(first) {
    this.mines = placeMines(this.rand, first, MINES);
    this.minesPlaced = true;
    for (let i = 0; i < SIZE; i++) {
      let n = 0;
      for (const j of neighbors(i)) if (this.mines.has(j)) n++;
      this.counts[i] = n;
    }
  }

  /** @private BFS flood-fill revealing zeros and their numbered perimeter. */
  _flood(start) {
    const stack = [start];
    while (stack.length) {
      const cell = stack.pop();
      if (this.revealed[cell] || this.flagged[cell]) continue;
      this.revealed[cell] = 1;
      this.revealedCount++;
      if (this.counts[cell] === 0) {
        for (const n of neighbors(cell)) {
          if (!this.revealed[n] && !this.flagged[n]) stack.push(n);
        }
      }
    }
  }

  /**
   * Reveal a cell. First reveal places mines safely around it.
   * @returns {{ changed:boolean, detonated:boolean, status:string }}
   */
  reveal(cell) {
    const noop = { changed: false, detonated: false, status: this.status };
    if (this.finished) return noop;
    if (!Number.isInteger(cell) || cell < 0 || cell >= SIZE) return noop;
    if (this.revealed[cell] || this.flagged[cell]) return noop;
    if (!this.minesPlaced) this._place(cell);
    this.moves++;

    if (this.mines.has(cell)) {
      this.revealed[cell] = 1;
      this.detonated = cell;
      this.status = STATUS.LOST;
      return { changed: true, detonated: true, status: this.status };
    }

    this._flood(cell);
    if (this.status === STATUS.READY) this.status = STATUS.PLAYING;
    if (this.revealedCount >= SIZE - MINES) this.status = STATUS.WON;
    return { changed: true, detonated: false, status: this.status };
  }

  /** Toggle a flag on a hidden cell. @returns {{changed:boolean}} */
  toggleFlag(cell) {
    if (this.finished) return { changed: false };
    if (!Number.isInteger(cell) || cell < 0 || cell >= SIZE) return { changed: false };
    if (this.revealed[cell]) return { changed: false };
    if (this.flagged[cell]) {
      this.flagged[cell] = 0;
      this.flagCount--;
    } else {
      this.flagged[cell] = 1;
      this.flagCount++;
    }
    this.moves++;
    if (this.status === STATUS.READY) this.status = STATUS.PLAYING;
    return { changed: true };
  }

  /**
   * Observation for the frozen policy/featurize contract.
   * @returns {{hidden:Uint8Array,revealed:Uint8Array,flagged:Uint8Array,counts:Int8Array}}
   */
  state() {
    const hidden = new Uint8Array(SIZE);
    const revealed = new Uint8Array(SIZE);
    const flagged = new Uint8Array(SIZE);
    const counts = new Int8Array(SIZE);
    for (let i = 0; i < SIZE; i++) {
      revealed[i] = this.revealed[i];
      flagged[i] = this.flagged[i];
      // hidden == unrevealed AND unflagged (matches src/featurize.js contract)
      hidden[i] = !this.revealed[i] && !this.flagged[i] ? 1 : 0;
      counts[i] = this.revealed[i] ? this.counts[i] : 0;
    }
    return { hidden, revealed, flagged, counts };
  }

  /** Legal reveal actions per contract: hidden AND not flagged. */
  legalMask() {
    const mask = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) {
      mask[i] = !this.revealed[i] && !this.flagged[i] ? 1 : 0;
    }
    return mask;
  }
}

export function createGame(seed) {
  return new Game(seed);
}
