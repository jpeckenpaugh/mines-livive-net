/**
 * stub/policy.js — local stand-in for Prototype's frozen `src/policy.js`.
 *
 * Presents the same interface (`loadPolicy(id) -> Policy`, `policy.act(...)`)
 * but makes decisions uniformly at random over the legal reveal actions.
 * The randomness is a *seeded* stream so the same board seed replays
 * identically across reloads (the real ONNX policy is deterministic too).
 * Used until real checkpoints + `models/manifest.json` land; the loader
 * switches to the canonical module automatically once they exist.
 */

const SIZE = 64;
const STUB_SEED = 0x9e3779b9;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const STUB_MANIFEST = {
  version: 1,
  stub: true,
  board: { h: 8, w: 8, mines: 10 },
  input: { shape: [1, 8, 8, 8], layout: 'nchw' },
  output: { shape: [1, 64], type: 'logits' },
  checkpoints: [
    {
      id: 'stub-random',
      label: 'Stub — uniform random (trained checkpoints pending)',
      file: null,
      eval: { win_rate: null, mine_hit_rate: null },
    },
  ],
};

export async function loadPolicy(_id) {
  const rand = mulberry32(STUB_SEED);
  return {
    id: _id || 'stub-random',
    stub: true,
    async act(_state, legalMask) {
      const legal = [];
      for (let i = 0; i < SIZE; i++) if (legalMask[i]) legal.push(i);

      const distribution = new Float32Array(SIZE);
      if (legal.length === 0) {
        return { action: -1, confidence: 0, distribution };
      }
      const p = 1 / legal.length;
      for (const i of legal) distribution[i] = p;

      const action = legal[Math.floor(rand() * legal.length) % legal.length];
      return { action, confidence: p, distribution };
    },
  };
}
