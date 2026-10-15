"""8x8 / 10-mine Minesweeper engine, deterministic solver, and feature encoder.

This module is the Python reference implementation of the browser contract.
It is shared by the training and evaluation pipeline and MUST stay byte-for-byte
consistent with ``src/featurize.js`` (channel order, normalization, masking).

State contract (matches ``src/featurize.js``):
  * ``hidden``   Uint8(64)  1 == cell is unrevealed AND unflagged (clickable)
  * ``revealed`` Uint8(64)  1 == cell has been revealed
  * ``flagged``  Uint8(64)  1 == cell is flagged
  * ``counts``   Int8(64)   adjacent-mine count, meaningful only for revealed cells
  * index i = r * 8 + c (row-major)

The engine never leaks adjacency counts for unrevealed cells (they are 0 in the
state vector), so the policy cannot cheat.

Board generation matches ``src/engine.js`` byte-for-byte (frozen seeded-board
spec): a canonical ``mulberry32`` stream, lazy mine placement on the first
reveal, forbidden set ``F = {f} ∪ neighbors(f)``, and rejection sampling with
one draw per attempt. This makes a given (seed, checkpoint) reproducible in the
browser and here.
"""

from __future__ import annotations

from typing import List, Optional, Sequence, Tuple

import numpy as np

H = 8
W = 8
MINES = 10
N = H * W
C = 8
FEATURE_LEN = N * C
MASK32 = 0xFFFFFFFF


def mulberry32(seed: int):
    """Canonical mulberry32 PRNG, bit-identical to ``src/engine.js``."""
    a = seed & MASK32

    def nxt() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & MASK32
        t = a
        t = ((t ^ (t >> 15)) * (1 | t)) & MASK32
        u = ((t ^ (t >> 7)) * (61 | t)) & MASK32
        t = ((t + u) & MASK32) ^ t
        return ((t ^ (t >> 14)) & MASK32) / 4294967296.0

    return nxt

# Precompute neighbour index lists (8-connected).
NEIGH: List[List[int]] = [[] for _ in range(N)]
for _r in range(H):
    for _c in range(W):
        _i = _r * W + _c
        for _dr in (-1, 0, 1):
            for _dc in (-1, 0, 1):
                if _dr == 0 and _dc == 0:
                    continue
                _nr, _nc = _r + _dr, _c + _dc
                if 0 <= _nr < H and 0 <= _nc < W:
                    NEIGH[_i].append(_nr * W + _nc)


def encode_state(
    hidden: Sequence[int],
    revealed: Sequence[int],
    flagged: Sequence[int],
    counts: Sequence[int],
) -> np.ndarray:
    """Encode a board state to the frozen NCHW float32 feature tensor (512,).

    Mirrors ``src/featurize.js`` exactly. ``hidden`` is re-masked defensively so
    the channel is always "unrevealed and unflagged" regardless of whether the
    caller pre-excludes flagged cells.
    """
    out = np.zeros(FEATURE_LEN, dtype=np.float32)
    revealed_count = 0
    flagged_count = 0
    hidden_count = 0
    hid = [0] * N
    for i in range(N):
        if revealed[i]:
            revealed_count += 1
        if flagged[i]:
            flagged_count += 1
        if hidden[i] and not revealed[i] and not flagged[i]:
            hid[i] = 1
            hidden_count += 1
    mines_remaining = MINES - flagged_count
    hid_denom = float(hidden_count if hidden_count > 0 else 1)
    ch5 = mines_remaining / hid_denom
    ch6 = revealed_count / float(N)
    for i in range(N):
        out[0 * N + i] = float(hid[i])
        out[1 * N + i] = 1.0 if revealed[i] else 0.0
        out[2 * N + i] = 1.0 if flagged[i] else 0.0
        out[3 * N + i] = counts[i] / 8.0
        out[4 * N + i] = 1.0 if (revealed[i] and counts[i] == 0) else 0.0
        out[5 * N + i] = ch5
        out[6 * N + i] = ch6
        out[7 * N + i] = 1.0
    return out


class Game:
    """Deterministic single-player Minesweeper game."""

    def __init__(self, seed: int):
        self.seed = int(seed) & MASK32
        self.rng = mulberry32(self.seed)
        self.mines = [False] * N
        self.revealed = [False] * N
        self.flagged = [False] * N
        self.counts = [0] * N
        self.started = False
        self.over = False
        self.won = False
        self.hit_mine = False
        self.moves = 0

    # -- board construction -------------------------------------------------
    def _start(self, safe_index: int) -> None:
        # Frozen spec: forbid the first cell AND its neighbors, then rejection
        # sample exactly like src/engine.js:placeMines.
        forbidden = {safe_index, *NEIGH[safe_index]}
        chosen = set()
        while len(chosen) < MINES:
            c = int(self.rng() * N)
            if c in forbidden or c in chosen:
                continue
            chosen.add(c)
        for i in chosen:
            self.mines[i] = True
        for i in range(N):
            self.counts[i] = sum(1 for n in NEIGH[i] if self.mines[n])
        self.started = True

    # -- queries ------------------------------------------------------------
    def _revealed_count(self) -> int:
        return sum(self.revealed)

    def _flagged_count(self) -> int:
        return sum(self.flagged)

    def legal_mask(self) -> List[int]:
        return [1 if (not self.revealed[i] and not self.flagged[i]) else 0 for i in range(N)]

    def hidden(self) -> List[int]:
        return [1 if (not self.revealed[i] and not self.flagged[i]) else 0 for i in range(N)]

    def state(self) -> dict:
        """Return the browser-contract state dict (counts zeroed for hidden cells)."""
        counts = [self.counts[i] if self.revealed[i] else 0 for i in range(N)]
        return {
            "hidden": self.hidden(),
            "revealed": [1 if x else 0 for x in self.revealed],
            "flagged": [1 if x else 0 for x in self.flagged],
            "counts": counts,
        }

    def features(self) -> np.ndarray:
        s = self.state()
        return encode_state(s["hidden"], s["revealed"], s["flagged"], s["counts"])

    # -- actions ------------------------------------------------------------
    def reveal(self, idx: int) -> str:
        """Reveal a cell. Returns 'mine', 'safe', or 'invalid'."""
        if self.over or idx < 0 or idx >= N or self.revealed[idx] or self.flagged[idx]:
            return "invalid"
        if not self.started:
            self._start(idx)
        self.moves += 1
        if self.mines[idx]:
            self.hit_mine = True
            self.over = True
            self.won = False
            return "mine"
        stack = [idx]
        while stack:
            i = stack.pop()
            if self.revealed[i] or self.flagged[i]:
                continue
            self.revealed[i] = True
            if self.counts[i] == 0:
                for n in NEIGH[i]:
                    if not self.revealed[n] and not self.flagged[n]:
                        stack.append(n)
        if self._revealed_count() == N - MINES:
            self.over = True
            self.won = True
        return "safe"

    def toggle_flag(self, idx: int) -> str:
        if self.over or idx < 0 or idx >= N or self.revealed[idx]:
            return "invalid"
        self.flagged[idx] = not self.flagged[idx]
        return "flagged" if self.flagged[idx] else "unflagged"

    def clone(self) -> "Game":
        g = Game(self.seed)
        g.mines = list(self.mines)
        g.revealed = list(self.revealed)
        g.flagged = list(self.flagged)
        g.counts = list(self.counts)
        g.started = self.started
        g.over = self.over
        g.won = self.won
        g.hit_mine = self.hit_mine
        g.moves = self.moves
        return g


# ---------------------------------------------------------------------------
# Solver
# ---------------------------------------------------------------------------

def _constraints(revealed, flagged, counts):
    """Build frontier constraints: (frozenset(unknown cells), remaining mines)."""
    cons = []
    for i in range(N):
        if not revealed[i]:
            continue
        unk = [n for n in NEIGH[i] if not revealed[n] and not flagged[n]]
        if not unk:
            continue
        rem = counts[i] - sum(1 for n in NEIGH[i] if flagged[n])
        rem = max(0, rem)
        cons.append((frozenset(unk), rem))
    return cons


def infer(revealed, flagged, counts, use_subset: bool = True) -> Tuple[set, set]:
    """Constraint propagation + optional 1-subset reasoning.

    Returns (safe_cells, mine_cells): cells provably free of mines / provably
    mines given the current information. Pure function; does not mutate input.
    """
    rev = list(revealed)
    fl = list(flagged)
    safe: set = set()
    mines: set = set()
    changed = True
    while changed:
        changed = False
        cons = _constraints(rev, fl, counts)
        # Basic rules.
        for cells, rem in cons:
            if rem == 0:
                for c in cells:
                    if c not in safe:
                        safe.add(c)
                        changed = True
            elif rem == len(cells):
                for c in cells:
                    if c not in mines:
                        mines.add(c)
                        fl[c] = True  # treat as flagged for further inference
                        changed = True
            elif rem < 0 or rem > len(cells):
                # Inconsistent constraint (should not happen in a valid board).
                pass
        if mines:
            for c in list(safe):
                if c in mines:
                    safe.discard(c)
        if not use_subset:
            continue
        # Subset rules (1-level).
        cons2 = _constraints(rev, fl, counts)
        for i in range(len(cons2)):
            cells1, rem1 = cons2[i]
            for j in range(len(cons2)):
                if i == j:
                    continue
                cells2, rem2 = cons2[j]
                if cells1 and cells1 < cells2:  # strict subset
                    diff = cells2 - cells1
                    drem = rem2 - rem1
                    if not diff:
                        continue
                    if drem == 0:
                        for c in diff:
                            if c not in safe:
                                safe.add(c)
                                changed = True
                    elif drem == len(diff):
                        for c in diff:
                            if c not in mines:
                                mines.add(c)
                                changed = True
        safe -= mines
    return safe, mines


def guess_probabilities(revealed, flagged, counts) -> List[float]:
    """Very small heuristic mine-probability estimate for forced guesses.

    Frontier cells get the max lower bound implied by their constraints; the
    remaining (deep) cells get the residual global density. Lower is safer.
    """
    probs = [0.0] * N
    remaining_mines = MINES - sum(1 for i in range(N) if flagged[i])
    total_unknown = sum(1 for i in range(N) if not revealed[i] and not flagged[i])
    frontier_cells = set()
    for i in range(N):
        if not revealed[i]:
            continue
        unk = [n for n in NEIGH[i] if not revealed[n] and not flagged[n]]
        if not unk:
            continue
        rem = counts[i] - sum(1 for n in NEIGH[i] if flagged[n])
        if rem <= 0:
            continue
        p = rem / len(unk)
        for n in unk:
            frontier_cells.add(n)
            if p > probs[n]:
                probs[n] = p
    # Cells adjacent to a satisfied number are certainly safe.
    for i in range(N):
        if not revealed[i]:
            continue
        unk = [n for n in NEIGH[i] if not revealed[n] and not flagged[n]]
        if not unk:
            continue
        rem = counts[i] - sum(1 for n in NEIGH[i] if flagged[n])
        if rem == 0:
            for n in unk:
                probs[n] = 0.0
    deep = [i for i in range(N) if not revealed[i] and not flagged[i] and i not in frontier_cells]
    if deep:
        # Allocate remaining mines equally across the unknown pool.
        denom = max(1, total_unknown)
        density = max(0.0, remaining_mines / denom)
        for i in deep:
            probs[i] = density
    return probs


def solver_move(revealed, flagged, counts, use_subset: bool = True):
    """Return (kind, cells) where kind in {'safe','mine','guess'}.

    'safe'  -> reveal any cell in cells (all provably safe)
    'mine'  -> flag all cells in cells (all provably mines)
    'guess' -> reveal the single cell with lowest estimated mine probability
    """
    safe, mines = infer(revealed, flagged, counts, use_subset=use_subset)
    if safe:
        return "safe", sorted(safe)
    if mines:
        return "mine", sorted(mines)
    probs = guess_probabilities(revealed, flagged, counts)
    best = None
    best_p = None
    for i in range(N):
        if revealed[i] or flagged[i]:
            continue
        p = probs[i]
        if best is None or p < best_p - 1e-12 or (abs(p - best_p) <= 1e-12 and i < best):
            best = i
            best_p = p
    return "guess", ([best] if best is not None else [])
