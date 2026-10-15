// src/featurize.js
//
// Frozen feature encoder for the 8x8 / 10-mine Minesweeper policy.
// Consumed by Frontend (AIA-12) unchanged. Mirrors tools/mines.py:encode_state.
//
// State contract (row-major index i = r*8 + c):
//   hidden   Uint8Array(64)  1 == cell is unrevealed AND unflagged (clickable)
//   revealed Uint8Array(64)  1 == cell has been revealed
//   flagged  Uint8Array(64)  1 == cell is flagged
//   counts   Int8Array(64)   adjacent-mine count (meaningful for revealed cells;
//                            MUST be 0 for hidden cells so the policy cannot cheat)
//
// NOTE TO FRONTEND: `hidden[i]` should be 1 only for cells that are BOTH
// unrevealed and unflagged. This encoder re-masks defensively
// (hidden && !revealed && !flagged), so the channel is well defined either way.

export const FEATURES = { H: 8, W: 8, C: 8 };

const H = FEATURES.H;
const W = FEATURES.W;
const C = FEATURES.C;
const N = H * W; // 64
const MINES = 10; // board mines, fixed by the manifest contract

/**
 * Encode a board state into a Float32Array of length H*W*C in NCHW layout,
 * i.e. index = c*H*W + r*W + col.
 *
 * Channels:
 *   0 hidden            (unrevealed && unflagged)
 *   1 revealed
 *   2 flagged
 *   3 adj-count / 8
 *   4 revealed-empty    (revealed && count === 0)
 *   5 mines-remaining / hidden-count   (broadcast scalar)
 *   6 revealed-count / 64              (broadcast scalar)
 *   7 constant 1
 *
 * @param {{hidden:Uint8Array,revealed:Uint8Array,flagged:Uint8Array,counts:Int8Array}} state
 * @returns {Float32Array} length H*W*C = 512
 */
export function encode(state) {
  const { hidden, revealed, flagged, counts } = state;
  const out = new Float32Array(N * C);

  let revealedCount = 0;
  let flaggedCount = 0;
  let hiddenCount = 0;
  const hid = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const isRevealed = revealed[i] ? 1 : 0;
    const isFlagged = flagged[i] ? 1 : 0;
    if (isRevealed) revealedCount++;
    if (isFlagged) flaggedCount++;
    if (hidden[i] && !isRevealed && !isFlagged) {
      hid[i] = 1;
      hiddenCount++;
    }
  }

  const minesRemaining = MINES - flaggedCount;
  const hidDenom = hiddenCount > 0 ? hiddenCount : 1;
  const ch5 = minesRemaining / hidDenom;
  const ch6 = revealedCount / N;

  for (let i = 0; i < N; i++) {
    const cnt = counts[i];
    out[0 * N + i] = hid[i];
    out[1 * N + i] = revealed[i] ? 1 : 0;
    out[2 * N + i] = flagged[i] ? 1 : 0;
    out[3 * N + i] = cnt / 8;
    out[4 * N + i] = revealed[i] && cnt === 0 ? 1 : 0;
    out[5 * N + i] = ch5;
    out[6 * N + i] = ch6;
    out[7 * N + i] = 1;
  }
  return out;
}
