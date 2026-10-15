/**
 * ui.js — board rendering / interaction for the arcade cabinet.
 *
 * `createBoardView(root, handlers)` owns one 8x8 grid and knows how to paint a
 * Game plus an optional AI overlay (selected cell, policy distribution heatmap,
 * legal-action mask). It is reused for the Play board, the AI board, and both
 * boards in Race mode.
 */

import { Game, SIZE, H, W } from './engine.js';

const LONG_PRESS_MS = 420;

export function cellName(index) {
  const r = (index / W) | 0;
  const c = index % W;
  return `${String.fromCharCode(65 + c)}${r + 1}`;
}

export class BoardView {
  /**
   * @param {HTMLElement} root
   * @param {{onReveal?:Function,onFlag?:Function,label?:string}} handlers
   */
  constructor(root, handlers = {}) {
    this.root = root;
    this.onReveal = handlers.onReveal || (() => {});
    this.onFlag = handlers.onFlag || (() => {});
    this.cursor = 0;
    this.flagMode = false;
    this.interactive = true;
    // `focusable` is a property of the board itself (human-driven vs. AI-driven);
    // it is independent of whether the current game has finished.
    this.focusable = handlers.interactive !== false;
    this.cells = [];
    this._suppressClick = false;
    this._pressTimer = null;

    this.root.classList.add('board');
    this.root.setAttribute('role', 'grid');
    this.root.setAttribute('aria-label', handlers.label || 'Minesweeper board');
    this.root.setAttribute('aria-rowcount', String(H));
    this.root.setAttribute('aria-colcount', String(W));
    this.root.style.setProperty('--w', String(W));

    for (let r = 0; r < H; r++) {
      const row = document.createElement('div');
      row.className = 'board-row';
      row.setAttribute('role', 'row');
      this.root.appendChild(row);
      for (let c = 0; c < W; c++) {
        const i = r * W + c;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cell';
        btn.dataset.index = String(i);
        btn.setAttribute('role', 'gridcell');
        btn.setAttribute('aria-label', `cell ${cellName(i)}, hidden`);
        btn.tabIndex = this.focusable && i === 0 ? 0 : -1;
        this._wire(btn, i);
        row.appendChild(btn);
        this.cells.push(btn);
      }
    }

    this.root.addEventListener('keydown', (e) => this._onKey(e));
  }

  _wire(btn, index) {
    btn.addEventListener('click', () => {
      if (!this.interactive) return;
      if (this._suppressClick) {
        this._suppressClick = false;
        return;
      }
      if (this.flagMode) this.onFlag(index);
      else this.onReveal(index);
    });

    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.interactive) return;
      this.onFlag(index);
    });

    btn.addEventListener('pointerdown', (e) => {
      if (!this.interactive || e.pointerType === 'mouse') return;
      this._pressTimer = setTimeout(() => {
        this._suppressClick = true;
        this.onFlag(index);
      }, LONG_PRESS_MS);
    });

    const cancel = () => {
      if (this._pressTimer) clearTimeout(this._pressTimer);
      this._pressTimer = null;
    };
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('pointerleave', cancel);
    btn.addEventListener('pointercancel', cancel);

    btn.addEventListener('focus', () => this.setCursor(index, false));
  }

  setCursor(index, focus = true) {
    if (!this.focusable || index < 0 || index >= SIZE) return;
    this.cursor = index;
    for (const c of this.cells) c.tabIndex = -1;
    const btn = this.cells[index];
    btn.tabIndex = 0;
    if (focus) btn.focus();
    for (const c of this.cells) c.classList.remove('cursor');
    btn.classList.add('cursor');
  }

  _onKey(e) {
    if (!this.interactive) return;
    const idx = this.cursor;
    const r = (idx / W) | 0;
    const c = idx % W;
    let next = null;
    switch (e.key) {
      case 'ArrowUp':
        next = ((r - 1 + H) % H) * W + c;
        break;
      case 'ArrowDown':
        next = ((r + 1) % H) * W + c;
        break;
      case 'ArrowLeft':
        next = r * W + ((c - 1 + W) % W);
        break;
      case 'ArrowRight':
        next = r * W + ((c + 1) % W);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        this.onReveal(idx);
        return;
      case 'f':
      case 'F':
        e.preventDefault();
        this.onFlag(idx);
        return;
      default:
        return;
    }
    e.preventDefault();
    this.setCursor(next, true);
  }

  setFlagMode(on) {
    this.flagMode = !!on;
    this.root.classList.toggle('flag-mode', this.flagMode);
  }

  /**
   * Paint the board.
   * @param {Game} game
   * @param {{selected?:number,distribution?:Float32Array,showHeat?:boolean,
   *          showMask?:boolean,legalMask?:Uint8Array,interactive?:boolean,
   *          revealMines?:boolean}} [view]
   */
  render(game, view = {}) {
    this.interactive = view.interactive !== false && !game.finished;
    this.root.classList.toggle('finished', game.finished);

    const dist = view.distribution;
    let maxProb = 0;
    if (dist) for (let i = 0; i < SIZE; i++) maxProb = Math.max(maxProb, dist[i] || 0);

    const showLoss = game.status === 'lost' || view.revealMines;

    for (let i = 0; i < SIZE; i++) {
      const btn = this.cells[i];
      const revealed = !!game.revealed[i];
      const flagged = !!game.flagged[i];

      btn.className = 'cell';
      btn.style.removeProperty('--heat');
      btn.textContent = '';

      if (revealed) {
        btn.classList.add('revealed');
        if (game.isMine(i)) {
          btn.classList.add('mine');
          if (game.detonated === i) btn.classList.add('detonated');
        } else if (game.counts[i] > 0) {
          btn.classList.add(`n${game.counts[i]}`);
          btn.textContent = String(game.counts[i]);
        } else {
          btn.classList.add('empty');
        }
      } else {
        if (showLoss && game.isMine(i) && game.minesPlaced) {
          btn.classList.add('revealed', 'mine', 'mine-shown');
        } else if (flagged) {
          btn.classList.add('flagged');
        }
      }

      if (view.showMask && view.legalMask) {
        if (!revealed && !flagged && view.legalMask[i]) btn.classList.add('legal');
        else if (!revealed && !flagged) btn.classList.add('illegal');
      }

      if (view.showHeat && dist && !revealed && !flagged && maxProb > 0) {
        const intensity = Math.min(1, (dist[i] || 0) / maxProb);
        if (intensity > 0.001) {
          btn.style.setProperty('--heat', intensity.toFixed(3));
          btn.classList.add('heat');
        }
      }

      if (view.selected === i) btn.classList.add('selected');

      const state = revealed ? 'revealed' : flagged ? 'flagged' : 'hidden';
      btn.setAttribute('aria-label', `cell ${cellName(i)}, ${state}`);
    }

    // Roving tabindex for human boards; non-interactive boards stay entirely
    // out of the tab order so Tab never lands in a dead board.
    for (const c of this.cells) c.tabIndex = -1;
    if (this.focusable) this.cells[this.cursor].tabIndex = 0;
  }
}

export function createBoardView(root, handlers) {
  return new BoardView(root, handlers);
}

export function createGame(seed) {
  return new Game(seed);
}
