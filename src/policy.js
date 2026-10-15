// src/policy.js
//
// On-device ONNX policy wrapper for the 8x8 / 10-mine Minesweeper POC.
// Consumed by Frontend (AIA-12) unchanged.
//
// Contract:
//   export async function loadPolicy(id) -> Policy
//   policy.act(state, legalMask) -> Promise<{action, confidence, distribution}>
//
// ---------------------------------------------------------------------------
// Runtime configuration (REQUIRED for GitHub Pages / static hosting)
// ---------------------------------------------------------------------------
// GitHub Pages cannot send the COOP/COEP headers that enable SharedArrayBuffer,
// so the ORT WASM backend MUST run single-threaded. This wrapper pins
// onnxruntime-web to a versioned CDN URL and forces:
//
//   ort.env.wasm.numThreads = 1;    // no SharedArrayBuffer / no cross-origin isolation
//   ort.env.wasm.proxy     = false; // run on the main thread (no nested worker)
//   ort.env.wasm.wasmPaths = <pinned CDN dist dir>;
//
// If you prefer to vendor the runtime, drop the onnxruntime-web dist/ files
// under vendor/onnxruntime-web/ and point ORT_BASE_URL at that folder instead.
//
// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------
// `act` applies a masked softmax over the legal cells and returns the argmax.
// Ties are broken by the LOWEST cell index (row-major), so for a given
// (seed, checkpoint) the chosen action sequence is fully deterministic.
//
// NOTE TO FRONTEND: `act` is `async` because ORT inference is asynchronous.
// Await it: `const { action, confidence, distribution } = await policy.act(state, mask);`

import { encode as encodeRef } from "./featurize.js";

export const ORT_VERSION = "1.19.2";
export const ORT_BASE_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const ORT_MODULE_URL = `${ORT_BASE_URL}ort.wasm.min.mjs`;

let _ortPromise = null;

async function getOrt() {
  if (!_ortPromise) {
    _ortPromise = import(/* @vite-ignore */ ORT_MODULE_URL).then((ort) => {
      // Single-threaded WASM: works without COOP/COEP on GitHub Pages.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = ORT_BASE_URL;
      return ort;
    });
  }
  return _ortPromise;
}

const _sessions = new Map();

function modelUrl(id) {
  // Manifest ids look like "m0"; files live at models/policy-m0.onnx.
  if (typeof id === "string" && /\.onnx$/i.test(id)) return id;
  return `models/policy-${id}.onnx`;
}

async function getSession(ort, id) {
  const url = modelUrl(id);
  if (_sessions.has(url)) return _sessions.get(url);
  const p = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch policy "${id}" from ${url}: ${res.status}`);
    const buf = await res.arrayBuffer();
    return ort.InferenceSession.create(buf, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    });
  })();
  _sessions.set(url, p);
  return p;
}

/** Softmax over legal cells only; returns probabilities (zero on illegal). */
export function maskedSoftmax(logits, legalMask) {
  const n = logits.length;
  const dist = new Float32Array(n);
  let maxLogit = -Infinity;
  let anyLegal = false;
  for (let i = 0; i < n; i++) {
    if (legalMask && !legalMask[i]) continue;
    anyLegal = true;
    if (logits[i] > maxLogit) maxLogit = logits[i];
  }
  if (!anyLegal) {
    // Defensive: no legal move. Fall back to raw logits over all cells.
    for (let i = 0; i < n; i++) if (logits[i] > maxLogit) maxLogit = logits[i];
    let sumAll = 0;
    for (let i = 0; i < n; i++) {
      const e = Math.exp(logits[i] - maxLogit);
      dist[i] = e;
      sumAll += e;
    }
    for (let i = 0; i < n; i++) dist[i] /= sumAll;
    return dist;
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (legalMask && !legalMask[i]) continue;
    const e = Math.exp(logits[i] - maxLogit);
    dist[i] = e;
    sum += e;
  }
  for (let i = 0; i < n; i++) dist[i] /= sum;
  return dist;
}

/** Deterministic argmax with lowest-index tie-break over allowed cells. */
export function argmax(dist, legalMask) {
  let best = -1;
  let bestP = -Infinity;
  for (let i = 0; i < dist.length; i++) {
    if (legalMask && !legalMask[i]) continue;
    if (dist[i] > bestP) {
      bestP = dist[i];
      best = i;
    }
  }
  if (best < 0) {
    for (let i = 0; i < dist.length; i++) {
      if (dist[i] > bestP) {
        bestP = dist[i];
        best = i;
      }
    }
  }
  return best < 0 ? 0 : best;
}

/**
 * Load a policy checkpoint by manifest id (e.g. "m0", "m1", "m2").
 * @returns {Promise<{id:string, act:Function}>}
 */
export async function loadPolicy(id) {
  const ort = await getOrt();
  const session = await getSession(ort, id);

  return {
    id,
    /**
     * @param {object} state  {hidden,revealed,flagged,counts}
     * @param {Uint8Array} legalMask  1 for clickable cells (hidden & !flagged)
     * @returns {Promise<{action:number,confidence:number,distribution:Float32Array}>}
     */
    async act(state, legalMask) {
      const features = encodeRef(state);
      const tensor = new ort.Tensor("float32", features, [1, 8, 8, 8]);
      const out = await session.run({ input: tensor });
      const firstKey = Object.keys(out)[0];
      const logits = out.logits ? out.logits.data : out[firstKey].data;
      const distribution = maskedSoftmax(logits, legalMask);
      const action = argmax(distribution, legalMask);
      return { action, confidence: distribution[action], distribution };
    },
  };
}
