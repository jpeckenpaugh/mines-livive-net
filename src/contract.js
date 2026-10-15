/**
 * contract.js — resolves the frozen integration surface at runtime.
 *
 * Preference order:
 *   1. Prototype's canonical `src/featurize.js` + `src/policy.js` together
 *      with a real `models/manifest.json` that lists checkpoints.
 *   2. Local stubs under `src/stub/` (uniform-random policy).
 *
 * We dynamically import the canonical paths and fall back on failure so the
 * cabinet works before the trained artifacts land and picks them up
 * automatically afterwards — no code change required to swap them in.
 */

async function tryImport(path) {
  try {
    return await import(path);
  } catch (err) {
    return null;
  }
}

async function fetchManifest() {
  try {
    const res = await fetch('models/manifest.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || !Array.isArray(json.checkpoints) || json.checkpoints.length === 0) {
      return null;
    }
    return json;
  } catch (err) {
    return null;
  }
}

/**
 * @returns {Promise<{featurize:object, loadPolicy:Function, manifest:object, real:boolean}>}
 */
export async function resolveContract() {
  const realFeaturize = await tryImport('./featurize.js');
  const realPolicy = await tryImport('./policy.js');
  const manifest = await fetchManifest();

  if (realPolicy && typeof realPolicy.loadPolicy === 'function' && manifest) {
    return {
      featurize: realFeaturize,
      loadPolicy: realPolicy.loadPolicy,
      manifest,
      real: true,
    };
  }

  const stubFeaturize = realFeaturize || (await import('./stub/featurize.js'));
  const stubPolicy = await import('./stub/policy.js');
  return {
    featurize: stubFeaturize,
    loadPolicy: stubPolicy.loadPolicy,
    manifest: manifest || stubPolicy.STUB_MANIFEST,
    real: false,
  };
}

/**
 * Load a policy by checkpoint id, converting any canonical-backend failure
 * into a stub so the demo never hard-breaks.
 */
export async function loadPolicySafe(contract, id) {
  try {
    const policy = await contract.loadPolicy(id);
    if (policy && typeof policy.act === 'function') return { policy, fellBack: false };
    throw new Error('policy missing act()');
  } catch (err) {
    const stub = await import('./stub/policy.js');
    const policy = await stub.loadPolicy(id);
    return { policy, fellBack: true, error: err };
  }
}
