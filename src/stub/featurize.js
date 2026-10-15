/**
 * stub/featurize.js — local stand-in for Prototype's frozen `src/featurize.js`.
 *
 * Used only until the real module lands. It implements the frozen contract
 * (same channels, same NCHW layout) so the cabinet renders and the AI loop
 * runs end-to-end without the canonical file.
 *
 * Channel layout (length H*W*C = 512, NCHW):
 *   0 hidden · 1 revealed · 2 flagged · 3 adj-count / 8 · 4 revealed-empty
 *   5 mines-remaining / hidden-count · 6 revealed-count / 64 · 7 constant 1
 */

export const FEATURES = { H: 8, W: 8, C: 8 };

export function encode(state) {
  const { H, W, C } = FEATURES;
  const N = H * W;
  const { hidden, revealed, flagged, counts } = state;
  const out = new Float32Array(C * N);

  let revealedTotal = 0;
  let flaggedTotal = 0;
  for (let i = 0; i < N; i++) {
    if (revealed[i]) revealedTotal++;
    if (flagged[i]) flaggedTotal++;
  }

  const hiddenTotal = N - revealedTotal - flaggedTotal;
  const minesRemaining = Math.max(0, 10 - flaggedTotal);

  for (let i = 0; i < N; i++) {
    out[0 * N + i] = hidden[i] ? 1 : 0;
    out[1 * N + i] = revealed[i] ? 1 : 0;
    out[2 * N + i] = flagged[i] ? 1 : 0;
    out[3 * N + i] = revealed[i] ? (counts[i] || 0) / 8 : 0;
    out[4 * N + i] = revealed[i] && (counts[i] || 0) === 0 ? 1 : 0;
    out[5 * N + i] = hiddenTotal > 0 ? minesRemaining / hiddenTotal : 0;
    out[6 * N + i] = revealedTotal / N;
    out[7 * N + i] = 1;
  }
  return out;
}
