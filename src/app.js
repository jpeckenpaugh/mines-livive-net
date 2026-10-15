/**
 * app.js — mode orchestration for the mines.livive.net arcade cabinet.
 *
 * Modes:
 *   play — human clears a seeded board.
 *   ai   — the RL policy plays the same seed; chosen cell, confidence, per-cell
 *          distribution heatmap and legal-action mask are shown live.
 *   race — human vs AI on the identical seed, side by side, with an outcome
 *          comparison.
 *
 * Deterministic seeds come from the URL (`?seed=<int>`) and are written back
 * with history.replaceState so a reload reproduces the exact board.
 */

import { Game, MINES, SIZE } from './engine.js';
import { createBoardView, cellName } from './ui.js';
import { resolveContract, loadPolicySafe } from './contract.js';

const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

const state = {
  seed: 0,
  mode: 'play',
  contract: null,
  checkpointId: null,
  policy: null,
  flagMode: false,
  showHeat: true,
  showMask: true,
};

const policyCache = new Map();

/* ------------------------------------------------------------------ seeds -- */

function seedFromUrl() {
  const raw = new URLSearchParams(location.search).get('seed');
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n >>> 0 : (Math.floor(Math.random() * 0xffffffff) >>> 0);
}

function writeSeedToUrl(seed) {
  const url = new URL(location.href);
  url.searchParams.set('seed', String(seed));
  history.replaceState(null, '', url);
}

/* ---------------------------------------------------------------- timers -- */

class Clock {
  constructor() {
    this.started = 0;
    this.elapsed = 0;
    this.running = false;
  }
  start() {
    this.started = performance.now();
    this.elapsed = 0;
    this.running = true;
  }
  stop() {
    if (this.running) {
      this.elapsed = performance.now() - this.started;
      this.running = false;
    }
  }
  read() {
    return this.running ? performance.now() - this.started : this.elapsed;
  }
}

function fmtTime(ms) {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

/* -------------------------------------------------------------- policies -- */

async function getPolicy(id) {
  if (policyCache.has(id)) return policyCache.get(id);
  const { policy, fellBack } = await loadPolicySafe(state.contract, id);
  if (fellBack) {
    setBackendBadge(true, state.contract ? state.contract.real : false);
  }
  policyCache.set(id, policy);
  return policy;
}

function setBackendBadge(fellBack, wasReal) {
  const badge = $('backend-badge');
  badge.classList.remove('badge-real', 'badge-stub');
  if (wasReal && !fellBack) {
    badge.textContent = 'ONNX checkpoints live';
    badge.classList.add('badge-real');
  } else {
    badge.textContent = 'stub policy — trained checkpoints pending';
    badge.classList.add('badge-stub');
  }
}

/* ============================================================= PLAY MODE == */

const play = {
  game: null,
  board: null,
  clock: new Clock(),
  tick: null,
};

function initPlay() {
  play.board = createBoardView($('play-board'), {
    onReveal: (i) => {
      startClock(play);
      const r = play.game.reveal(i);
      if (r.detonated) play.clock.stop();
      renderPlay();
    },
    onFlag: (i) => {
      play.game.toggleFlag(i);
      renderPlay();
    },
    label: 'Play board',
  });
  $('play-reset').addEventListener('click', () => resetPlay());
}

function resetPlay() {
  play.game = new Game(state.seed);
  play.clock = new Clock();
  renderPlay();
}

function startClock(owner) {
  if (!owner.clock.running && !owner.game.finished && owner.game.moves === 0) {
    owner.clock.start();
  }
}

function renderPlay() {
  const g = play.game;
  if (g.finished) play.clock.stop();
  play.board.render(g, { revealMines: g.status === 'lost' });
  const el = $('play-status');
  el.textContent = g.status.toUpperCase();
  el.dataset.state = g.status;
  $('play-mines').textContent = String(g.minesRemaining);
  $('play-flags').textContent = String(g.flagCount);
  $('play-moves').textContent = String(g.moves);
  $('play-time').textContent = fmtTime(play.clock.read());
}

/* =============================================================== AI MODE == */

const ai = {
  game: null,
  board: null,
  clock: new Clock(),
  running: false,
  timer: null,
  decision: null,
  delay: 380,
};

function initAI() {
  ai.board = createBoardView($('ai-board'), { label: 'AI board', interactive: false });
  $('ai-play').addEventListener('click', () => toggleAI());
  $('ai-step').addEventListener('click', () => {
    ai.running = false;
    updateAiButtons();
    aiStep().then(() => scheduleAI(0));
  });
  $('ai-reset').addEventListener('click', () => resetAI());
  const speed = $('ai-speed');
  speed.addEventListener('input', () => {
    ai.delay = 1200 - Number(speed.value);
  });
  ai.delay = 1200 - Number($('ai-speed').value);
}

function resetAI() {
  stopAILoop();
  ai.game = new Game(state.seed);
  ai.clock = new Clock();
  ai.decision = null;
  renderAI();
}

function stopAILoop() {
  ai.running = false;
  if (ai.timer) clearTimeout(ai.timer);
  ai.timer = null;
  updateAiButtons();
}

function toggleAI() {
  if (ai.game.finished) {
    resetAI();
  }
  ai.running = !ai.running;
  updateAiButtons();
  if (ai.running) {
    if (!ai.clock.running) ai.clock.start();
    scheduleAI(0);
  }
}

function scheduleAI(delay) {
  if (!ai.running) return;
  if (ai.timer) clearTimeout(ai.timer);
  ai.timer = setTimeout(async () => {
    if (!ai.running) return;
    await aiStep();
    if (ai.game.finished) {
      stopAILoop();
      renderAI();
      return;
    }
    scheduleAI(ai.delay);
  }, delay);
}

async function aiStep() {
  if (!state.policy || ai.game.finished) return;
  const st = ai.game.state();
  const mask = ai.game.legalMask();
  let decision;
  try {
    decision = await state.policy.act(st, mask);
  } catch (err) {
    console.error('policy.act failed', err);
    stopAILoop();
    return;
  }
  ai.decision = { ...decision, mask };
  if (decision.action >= 0) ai.game.reveal(decision.action);
  renderAI();
}

function updateAiButtons() {
  const btn = $('ai-play');
  btn.textContent = ai.running ? 'PAUSE' : ai.game && ai.game.finished ? 'REPLAY' : 'PLAY';
  btn.dataset.state = ai.running ? 'running' : 'idle';
}

function renderAI() {
  const g = ai.game;
  if (g.finished) ai.clock.stop();
  const d = ai.decision;
  ai.board.render(g, {
    selected: d ? d.action : null,
    distribution: d ? d.distribution : null,
    showHeat: state.showHeat && !!d,
    showMask: state.showMask && !!d,
    legalMask: d ? d.mask : null,
    interactive: false,
    revealMines: g.status === 'lost',
  });

  const el = $('ai-status');
  el.textContent = g.status.toUpperCase();
  el.dataset.state = g.status;
  $('ai-moves').textContent = String(g.moves);
  $('ai-time').textContent = fmtTime(ai.clock.read());

  if (d && d.action >= 0) {
    $('ai-action').textContent = cellName(d.action);
    $('ai-confidence').textContent = `${(d.confidence * 100).toFixed(1)}%`;
  } else {
    $('ai-action').textContent = '—';
    $('ai-confidence').textContent = '—';
  }

  renderDistribution(d);
  updateAiButtons();
}

function renderDistribution(d) {
  const host = $('ai-dist');
  host.replaceChildren();
  if (!d || !d.distribution) return;
  const entries = [];
  for (let i = 0; i < SIZE; i++) {
    if (d.distribution[i] > 0) entries.push([i, d.distribution[i]]);
  }
  entries.sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, 5);
  const max = top.length ? top[0][1] : 1;
  for (const [i, p] of top) {
    const row = document.createElement('div');
    row.className = 'dist-row';
    const name = document.createElement('span');
    name.className = 'dist-name';
    name.textContent = cellName(i);
    const bar = document.createElement('span');
    bar.className = 'dist-bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.max(2, (p / max) * 100)}%`;
    bar.appendChild(fill);
    const pct = document.createElement('span');
    pct.className = 'dist-pct';
    pct.textContent = `${(p * 100).toFixed(1)}%`;
    row.append(name, bar, pct);
    host.appendChild(row);
  }
}

/* ============================================================= RACE MODE == */

const race = {
  human: null,
  ai: null,
  humanBoard: null,
  aiBoard: null,
  humanClock: new Clock(),
  aiClock: new Clock(),
  running: false,
  timer: null,
  decision: null,
  finished: false,
};

function initRace() {
  race.humanBoard = createBoardView(
    $('race-human'),
    {
      onReveal: (i) => {
        if (!race.running || race.human.finished) return;
        if (!race.humanClock.running) race.humanClock.start();
        const r = race.human.reveal(i);
        if (r.detonated) race.humanClock.stop();
        renderRace();
      },
      onFlag: (i) => {
        if (!race.running || race.human.finished) return;
        race.human.toggleFlag(i);
        renderRace();
      },
      label: 'Your board',
    },
  );
  race.aiBoard = createBoardView($('race-ai'), { label: 'AI board', interactive: false });
  $('race-start').addEventListener('click', () => startRace());
  $('race-reset').addEventListener('click', () => resetRace());
}

function resetRace() {
  stopRaceLoop();
  race.human = new Game(state.seed);
  race.ai = new Game(state.seed);
  race.humanClock = new Clock();
  race.aiClock = new Clock();
  race.decision = null;
  race.finished = false;
  race.running = false;
  $('race-result').textContent = '';
  $('race-result').className = 'race-result';
  $('race-start').textContent = 'START RACE';
  renderRace();
}

function startRace() {
  if (race.finished || race.human.finished) {
    resetRace();
  }
  race.running = true;
  $('race-start').textContent = 'RACING…';
  if (!race.humanClock.running) race.humanClock.start();
  if (!race.aiClock.running) race.aiClock.start();
  scheduleRaceStep(0);
}

function stopRaceLoop() {
  race.running = false;
  if (race.timer) clearTimeout(race.timer);
  race.timer = null;
}

function scheduleRaceStep(delay) {
  if (!race.running) return;
  if (race.timer) clearTimeout(race.timer);
  race.timer = setTimeout(async () => {
    if (!race.running) return;
    await raceStep();
    if (race.ai.finished) {
      race.aiClock.stop();
      maybeFinishRace();
      return;
    }
    scheduleRaceStep(ai.delay);
  }, delay);
}

async function raceStep() {
  if (!state.policy || race.ai.finished) return;
  const st = race.ai.state();
  const mask = race.ai.legalMask();
  try {
    const d = await state.policy.act(st, mask);
    race.decision = { ...d, mask };
    if (d.action >= 0) race.ai.reveal(d.action);
  } catch (err) {
    console.error('race policy.act failed', err);
    stopRaceLoop();
    return;
  }
  renderRace();
  maybeFinishRace();
}

function maybeFinishRace() {
  if (race.finished) return;
  if (race.human.finished && race.ai.finished) {
    race.finished = true;
    stopRaceLoop();
    race.humanClock.stop();
    race.aiClock.stop();
    $('race-start').textContent = 'RACE AGAIN';
    renderRaceResult();
  }
}

function humanWon() {
  return race.human.status === 'won';
}
function aiWon() {
  return race.ai.status === 'won';
}

function renderRaceResult() {
  const el = $('race-result');
  const hMoves = race.human.moves;
  const aMoves = race.ai.moves;
  const hTime = race.humanClock.read();
  const aTime = race.aiClock.read();
  const hWon = humanWon();
  const aWon = aiWon();

  let verdict;
  let cls;
  if (hWon && !aWon) {
    verdict = 'YOU WIN';
    cls = 'win';
  } else if (aWon && !hWon) {
    verdict = 'AI WINS';
    cls = 'loss';
  } else if (hWon && aWon) {
    if (hMoves !== aMoves) verdict = hMoves < aMoves ? 'YOU WIN (fewer moves)' : 'AI WINS (fewer moves)';
    else if (hTime !== aTime) verdict = hTime < aTime ? 'YOU WIN (faster)' : 'AI WINS (faster)';
    else verdict = 'DRAW';
    cls = verdict.startsWith('YOU') ? 'win' : verdict.startsWith('AI') ? 'loss' : 'draw';
  } else {
    verdict = 'BOTH LOST';
    cls = 'draw';
  }

  el.className = `race-result ${cls}`;
  el.textContent = `${verdict} · you: ${race.human.status} in ${hMoves} moves / ${fmtTime(hTime)} · ai: ${race.ai.status} in ${aMoves} moves / ${fmtTime(aTime)}`;
}

function raceHud(game, clock) {
  return `${game.status.toUpperCase()} · ${MINES - game.flagCount} mines · ${game.moves} moves · ${fmtTime(clock.read())}`;
}

function renderRace() {
  const d = race.decision;
  race.humanBoard.render(race.human, { revealMines: race.human.status === 'lost', interactive: true });
  race.aiBoard.render(race.ai, {
    selected: d ? d.action : null,
    distribution: d ? d.distribution : null,
    showHeat: state.showHeat && !!d,
    showMask: state.showMask && !!d,
    legalMask: d ? d.mask : null,
    interactive: false,
    revealMines: race.ai.status === 'lost',
  });
  $('race-human-hud').textContent = raceHud(race.human, race.humanClock);
  $('race-ai-hud').textContent = raceHud(race.ai, race.aiClock);
  maybeFinishRace();
}

/* =========================================================== SCORING ===== */

/**
 * Frozen scoring (POC v2 plan). `manifest.scoring` when present, else the
 * documented default. Detonation and stuck both end a run with points so far.
 */
function scoringConfig() {
  const s = (state.contract && state.contract.manifest && state.contract.manifest.scoring) || {};
  return {
    safe: Number.isFinite(s.safe_reveal_points) ? s.safe_reveal_points : 1,
    bonus: Number.isFinite(s.win_bonus) ? s.win_bonus : 50,
  };
}

/**
 * `Game.revealedCount` counts only safely revealed cells (the detonated mine is
 * marked revealed but never counted), so it is exactly `safe_cells_revealed`.
 */
function pointsFor(game) {
  const { safe, bonus } = scoringConfig();
  return game.revealedCount * safe + (game.status === 'won' ? bonus : 0);
}

function listCheckpoints() {
  const m = (state.contract && state.contract.manifest) || {};
  return Array.isArray(m.checkpoints) ? m.checkpoints : [];
}

/* ============================================================= MODELS ==== */

function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

function formatArchitecture(a) {
  if (!a || typeof a !== 'object') return '—';
  const parts = [];
  if (Number.isFinite(a.width)) parts.push(`width ${a.width}`);
  if (Array.isArray(a.layers)) parts.push(`${a.layers.length} layers`);
  else if (typeof a.layers === 'string') parts.push(a.layers);
  if (Number.isFinite(a.params)) parts.push(`${a.params.toLocaleString()} params`);
  return parts.length ? parts.join(' · ') : '—';
}

function formatTraining(t) {
  if (!t || typeof t !== 'object') return '—';
  const parts = [];
  if (Number.isFinite(t.games)) parts.push(`${t.games.toLocaleString()} games`);
  if (Number.isFinite(t.epochs)) parts.push(`${t.epochs} epochs`);
  if (Number.isFinite(t.lr)) parts.push(`lr ${t.lr}`);
  if (t.target) parts.push(`target ${t.target}`);
  return parts.length ? parts.join(' · ') : '—';
}

function formatEval(e) {
  if (!e || typeof e !== 'object') return '—';
  const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
  const num = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
  return `win ${pct(e.win_rate)} · mine-hit ${pct(e.mine_hit_rate)} · stuck ${pct(
    e.stuck_rate,
  )} · avg safe ${num(e.avg_safe_reveals)}`;
}

function modelCard(ckpt, active) {
  const card = document.createElement('article');
  card.className = 'model-card';
  card.setAttribute('role', 'listitem');
  if (active) card.setAttribute('aria-current', 'true');

  const head = document.createElement('header');
  head.className = 'model-head';
  const id = document.createElement('span');
  id.className = 'model-id';
  id.textContent = ckpt.id;
  const label = document.createElement('h3');
  label.className = 'model-label';
  label.textContent = ckpt.label || ckpt.id;
  head.append(id, label);
  if (ckpt.family) {
    const fam = document.createElement('span');
    fam.className = 'model-family';
    fam.textContent = ckpt.family;
    head.appendChild(fam);
  }

  const desc = document.createElement('p');
  desc.className = 'model-desc';
  desc.textContent = ckpt.description || '—';

  const dl = document.createElement('dl');
  dl.className = 'model-meta';
  const rows = [
    ['Family', ckpt.family || '—'],
    ['Method', ckpt.method || '—'],
    ['Architecture', formatArchitecture(ckpt.architecture)],
    ['Training', formatTraining(ckpt.training)],
    ['File size', formatBytes(ckpt.size_bytes)],
    ['Eval', formatEval(ckpt.eval)],
  ];
  for (const [k, v] of rows) {
    const row = document.createElement('div');
    row.className = 'model-row';
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    row.append(dt, dd);
    dl.appendChild(row);
  }

  card.append(head, desc, dl);
  return card;
}

function renderModels() {
  const host = $('models-list');
  const list = listCheckpoints();
  host.replaceChildren();
  for (const ckpt of list) host.appendChild(modelCard(ckpt, ckpt.id === state.checkpointId));

  const note = $('models-note');
  if (!list.length) {
    note.textContent = 'No checkpoints found in the manifest.';
    return;
  }
  const manifest = state.contract ? state.contract.manifest : {};
  note.textContent =
    state.contract && state.contract.real
      ? `Manifest v${manifest.version ?? '?'} · ${list.length} checkpoint${
          list.length === 1 ? '' : 's'
        }`
      : 'Trained manifest not loaded — showing stub policy information.';
}

/* ========================================================= CONCURRENT ==== */

const concurrent = {
  models: [],
  built: false,
  running: false,
  started: false,
  timer: null,
  tickMs: 250,
  generation: 0,
};

const SETTLED = new Set(['cleared', 'detonated', 'stuck', 'error']);

function concurrentStatusLabel(m) {
  switch (m.status) {
    case 'loading':
      return 'LOADING';
    case 'idle':
      return m.policy && m.policy.stub ? 'STUB' : 'READY';
    case 'running':
      return 'RUNNING';
    case 'cleared':
      return 'CLEARED';
    case 'detonated':
      return 'DETONATED';
    case 'stuck':
      return 'STUCK';
    case 'error':
      return 'ERROR';
    default:
      return '—';
  }
}

function initConcurrent() {
  $('concurrent-start').addEventListener('click', () => startConcurrent());
  $('concurrent-reset').addEventListener('click', () => resetConcurrent());
  const speed = $('concurrent-speed');
  speed.addEventListener('input', () => {
    concurrent.tickMs = 1200 - Number(speed.value);
  });
  concurrent.tickMs = 1200 - Number(speed.value);
}

async function loadConcurrentPolicy(model, gen) {
  try {
    const policy = await getPolicy(model.id);
    if (gen !== concurrent.generation) return;
    model.policy = policy;
    if (model.status === 'loading') {
      model.status = concurrent.running ? 'running' : 'idle';
    }
  } catch (err) {
    if (gen !== concurrent.generation) return;
    console.error('concurrent policy load failed', model.id, err);
    model.status = 'error';
    model.error = String((err && err.message) || err);
  }
  renderConcurrent();
}

function buildConcurrent() {
  const host = $('concurrent-grid');
  host.replaceChildren();
  concurrent.models = [];
  concurrent.generation++;
  const gen = concurrent.generation;

  for (const ckpt of listCheckpoints()) {
    const card = document.createElement('article');
    card.className = 'concurrent-card';
    card.dataset.status = 'loading';

    const head = document.createElement('header');
    head.className = 'cc-head';
    const id = document.createElement('span');
    id.className = 'cc-id';
    id.textContent = ckpt.id;
    const points = document.createElement('span');
    points.className = 'cc-points';
    points.textContent = '0';
    head.append(id, points);

    const name = document.createElement('p');
    name.className = 'cc-name';
    name.textContent = ckpt.label || ckpt.id;

    const boardHost = document.createElement('div');
    boardHost.className = 'cc-board';
    const view = createBoardView(boardHost, {
      label: `${ckpt.label || ckpt.id} board`,
      interactive: false,
    });

    const line = document.createElement('p');
    line.className = 'cc-line';
    const status = document.createElement('span');
    status.className = 'cc-status';
    status.textContent = 'LOADING';
    const stats = document.createElement('span');
    stats.className = 'cc-stats';
    stats.textContent = '0 moves · 0 pts';
    line.append(status, stats);

    card.append(head, name, boardHost, line);
    host.appendChild(card);

    const model = {
      id: ckpt.id,
      label: ckpt.label || ckpt.id,
      game: new Game(state.seed),
      policy: null,
      status: 'loading',
      moves: 0,
      points: 0,
      error: null,
      view,
      refs: { card, status, stats, points },
    };
    concurrent.models.push(model);
    loadConcurrentPolicy(model, gen);
  }

  concurrent.built = true;
  renderConcurrent();
}

function resetConcurrent() {
  pauseConcurrent();
  concurrent.running = false;
  concurrent.started = false;
  concurrent.generation++;
  const gen = concurrent.generation;

  if (!concurrent.built || concurrent.models.length !== listCheckpoints().length) {
    buildConcurrent();
    return;
  }

  for (const m of concurrent.models) {
    m.game = new Game(state.seed);
    m.moves = 0;
    m.points = 0;
    m.error = null;
    if (m.policy) {
      m.status = 'idle';
    } else {
      m.status = 'loading';
      loadConcurrentPolicy(m, gen);
    }
  }
  announceConcurrent('');
  renderConcurrent();
}

function startConcurrent() {
  if (!concurrent.built) buildConcurrent();
  if (concurrent.running) {
    pauseConcurrent();
    return;
  }
  if (concurrent.models.length && concurrent.models.every((m) => SETTLED.has(m.status))) {
    resetConcurrent();
  }
  concurrent.running = true;
  concurrent.started = true;
  for (const m of concurrent.models) if (m.status === 'idle') m.status = 'running';
  announceConcurrent('Concurrent run started');
  renderConcurrent();
  scheduleConcurrentTick(0);
}

function pauseConcurrent() {
  concurrent.running = false;
  if (concurrent.timer) clearTimeout(concurrent.timer);
  concurrent.timer = null;
  updateConcurrentButton();
}

function scheduleConcurrentTick(delay) {
  if (!concurrent.running) return;
  if (concurrent.timer) clearTimeout(concurrent.timer);
  concurrent.timer = setTimeout(concurrentTick, delay);
}

async function concurrentStep(model, gen) {
  const g = model.game;
  if (g.finished || !model.policy) return;

  const mask = g.legalMask();
  let anyLegal = false;
  for (let i = 0; i < SIZE; i++) {
    if (mask[i]) {
      anyLegal = true;
      break;
    }
  }
  if (!anyLegal) {
    // No legal reveal and not won -> tripped up.
    model.status = 'stuck';
    model.points = pointsFor(g);
    return;
  }

  let decision;
  try {
    decision = await model.policy.act(g.state(), mask);
  } catch (err) {
    if (gen !== concurrent.generation) return;
    console.error('concurrent policy.act failed', model.id, err);
    model.status = 'error';
    model.error = String((err && err.message) || err);
    model.points = pointsFor(g);
    return;
  }
  if (gen !== concurrent.generation) return;

  if (!decision || decision.action < 0 || !mask[decision.action]) {
    model.status = 'stuck';
    model.points = pointsFor(g);
    return;
  }

  g.reveal(decision.action);
  model.moves = g.moves;
  if (g.status === 'won') model.status = 'cleared';
  else if (g.status === 'lost') model.status = 'detonated';
  model.points = pointsFor(g);
}

async function concurrentTick() {
  if (!concurrent.running) return;
  const gen = concurrent.generation;

  // One action per running model, in rotation, awaited one at a time so the
  // whole field visibly advances together without nine concurrent loops.
  for (const model of concurrent.models) {
    if (!concurrent.running || gen !== concurrent.generation) return;
    if (model.status !== 'running') continue;
    await concurrentStep(model, gen);
  }
  if (!concurrent.running || gen !== concurrent.generation) return;

  renderConcurrent();
  const pending = concurrent.models.some(
    (m) => m.status === 'running' || m.status === 'loading',
  );
  if (pending) scheduleConcurrentTick(concurrent.tickMs);
  else finishConcurrent();
}

function finishConcurrent() {
  pauseConcurrent();
  const counts = tallyConcurrent();
  const total = concurrent.models.reduce((sum, m) => sum + m.points, 0);
  announceConcurrent(
    `All models finished: ${counts.cleared} cleared, ${counts.detonated} detonated, ` +
      `${counts.stuck} stuck. Total ${total} points.`,
  );
  renderConcurrent();
}

function tallyConcurrent() {
  const counts = { cleared: 0, detonated: 0, stuck: 0 };
  for (const m of concurrent.models) if (Object.hasOwn(counts, m.status)) counts[m.status]++;
  return counts;
}

function renderLeaderboard() {
  const host = $('concurrent-leaderboard');
  host.replaceChildren();
  const sorted = [...concurrent.models].sort(
    (a, b) => b.points - a.points || a.id.localeCompare(b.id),
  );
  sorted.forEach((m, i) => {
    const li = document.createElement('li');
    li.className = `leader-row ${m.status}`;
    const rank = document.createElement('span');
    rank.className = 'leader-rank';
    rank.textContent = `#${i + 1}`;
    const name = document.createElement('span');
    name.className = 'leader-name';
    name.textContent = m.label;
    const stat = document.createElement('span');
    stat.className = 'leader-stat';
    stat.textContent = `${concurrentStatusLabel(m)} · ${m.points} pts`;
    li.append(rank, name, stat);
    host.appendChild(li);
  });
}

function renderConcurrent() {
  if (!concurrent.models.length) {
    updateConcurrentButton();
    return;
  }
  for (const m of concurrent.models) {
    m.view.render(m.game, {
      interactive: false,
      revealMines: m.game.status === 'lost',
    });
    const label = concurrentStatusLabel(m);
    m.refs.card.dataset.status = m.status;
    m.refs.status.textContent = label;
    m.refs.stats.textContent = `${m.moves} moves · ${m.points} pts`;
    m.refs.points.textContent = String(m.points);
    m.refs.card.setAttribute(
      'aria-label',
      `${m.label}: ${label}, ${m.moves} moves, ${m.points} points`,
    );
  }

  const counts = tallyConcurrent();
  const total = concurrent.models.reduce((sum, m) => sum + m.points, 0);
  $('concurrent-cleared').textContent = String(counts.cleared);
  $('concurrent-detonated').textContent = String(counts.detonated);
  $('concurrent-stuck').textContent = String(counts.stuck);
  $('concurrent-total').textContent = String(total);
  renderLeaderboard();
  updateConcurrentButton();
}

function updateConcurrentButton() {
  const btn = $('concurrent-start');
  if (concurrent.running) {
    btn.textContent = 'PAUSE';
    btn.dataset.state = 'running';
  } else {
    delete btn.dataset.state;
    if (concurrent.models.length && concurrent.models.every((m) => SETTLED.has(m.status))) {
      btn.textContent = 'REPLAY';
    } else if (concurrent.started) {
      btn.textContent = 'RESUME';
    } else {
      btn.textContent = 'START';
    }
  }
}

function announceConcurrent(text) {
  const el = document.getElementById('concurrent-live');
  if (el) el.textContent = text;
}

/* ================================================================ MODES === */

function setMode(mode) {
  state.mode = mode;
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    // Roving tabindex: only the active tab is in the tab order.
    tab.tabIndex = active ? 0 : -1;
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.hidden = panel.dataset.panel !== mode;
  }
  if (mode !== 'ai') stopAILoop();
  if (mode !== 'race') stopRaceLoop();
  // Leaving CONCURRENT pauses the lockstep loop so it never runs off-screen.
  if (mode !== 'concurrent') pauseConcurrent();

  if (mode === 'play') {
    if (!play.game) resetPlay();
    renderPlay();
  } else if (mode === 'ai') {
    if (!ai.game) resetAI();
    renderAI();
  } else if (mode === 'race') {
    if (!race.human) resetRace();
    renderRace();
  } else if (mode === 'concurrent') {
    if (!concurrent.built) buildConcurrent();
    else renderConcurrent();
  } else if (mode === 'models') {
    renderModels();
  }
}

// WAI-ARIA Tabs: Left/Right move between tabs (wrapping) and Home/End jump to
// the ends. Selection follows focus (automatic activation), which keeps the
// tab and its panel in sync for the probe and for assistive tech.
function onTabKeydown(e, tabs) {
  const i = tabs.indexOf(e.currentTarget);
  let next = null;
  switch (e.key) {
    case 'ArrowRight':
      next = (i + 1) % tabs.length;
      break;
    case 'ArrowLeft':
      next = (i - 1 + tabs.length) % tabs.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = tabs.length - 1;
      break;
    default:
      return;
  }
  e.preventDefault();
  const target = tabs[next];
  setMode(target.dataset.mode);
  target.focus();
}

/* ------------------------------------------------------------- rebuild all */

function rebuildForSeed() {
  writeSeedToUrl(state.seed);
  $('seed-input').value = String(state.seed);
  stopAILoop();
  stopRaceLoop();
  play.game = new Game(state.seed);
  play.clock = new Clock();
  ai.game = new Game(state.seed);
  ai.clock = new Clock();
  ai.decision = null;
  race.human = new Game(state.seed);
  race.ai = new Game(state.seed);
  race.humanClock = new Clock();
  race.aiClock = new Clock();
  race.decision = null;
  race.finished = false;
  race.running = false;
  $('race-result').textContent = '';
  $('race-result').className = 'race-result';
  $('race-start').textContent = 'START RACE';
  if (concurrent.built) resetConcurrent();
  setMode(state.mode);
}

/* ------------------------------------------------------------------ boot -- */

function applyFlagMode() {
  state.flagMode = !state.flagMode;
  play.board.setFlagMode(state.flagMode);
  race.humanBoard.setFlagMode(state.flagMode);
  $('flag-state').textContent = state.flagMode ? 'ON' : 'OFF';
  $('flag-toggle').classList.toggle('on', state.flagMode);
}

function applyToggles() {
  $('heat-state').textContent = state.showHeat ? 'ON' : 'OFF';
  $('heat-toggle').classList.toggle('on', state.showHeat);
  $('mask-state').textContent = state.showMask ? 'ON' : 'OFF';
  $('mask-toggle').classList.toggle('on', state.showMask);
}

function populateCheckpoints() {
  const sel = $('checkpoint');
  const list = state.contract.manifest.checkpoints || [];
  sel.replaceChildren();
  for (const ckpt of list) {
    const opt = document.createElement('option');
    opt.value = ckpt.id;
    opt.textContent = ckpt.label || ckpt.id;
    sel.appendChild(opt);
  }
  state.checkpointId = list[0] ? list[0].id : null;
  if (state.checkpointId) sel.value = state.checkpointId;
  sel.disabled = list.length === 0;
}

async function selectCheckpoint(id) {
  state.checkpointId = id;
  state.policy = await getPolicy(id);
  // Give the freshly-selected policy a clean board so its play is comparable.
  if (state.mode === 'ai') resetAI();
  if (state.mode === 'race') resetRace();
  if (state.mode === 'models') renderModels();
}

async function boot() {
  state.seed = seedFromUrl();
  writeSeedToUrl(state.seed);
  $('seed-input').value = String(state.seed);

  initPlay();
  initAI();
  initRace();
  initConcurrent();

  const tabs = [...document.querySelectorAll('.tab')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => setMode(tab.dataset.mode));
    tab.addEventListener('keydown', (e) => onTabKeydown(e, tabs));
  }
  $('new-seed').addEventListener('click', () => {
    state.seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
    rebuildForSeed();
  });
  $('seed-input').addEventListener('change', (e) => {
    const n = Number.parseInt(e.target.value, 10);
    if (Number.isFinite(n)) {
      state.seed = n >>> 0;
      rebuildForSeed();
    }
  });
  $('copy-link').addEventListener('click', async () => {
    const status = $('copy-status');
    try {
      await navigator.clipboard.writeText(location.href);
      $('copy-link').dataset.flash = 'Copied!';
      status.textContent = 'Link copied to clipboard';
    } catch (err) {
      $('copy-link').dataset.flash = 'Copy blocked';
      status.textContent = 'Copy blocked — copy the URL from the address bar';
    }
    setTimeout(() => {
      delete $('copy-link').dataset.flash;
      status.textContent = '';
    }, 1200);
  });
  $('flag-toggle').addEventListener('click', applyFlagMode);
  $('heat-toggle').addEventListener('click', () => {
    state.showHeat = !state.showHeat;
    applyToggles();
    renderAI();
    renderRace();
  });
  $('mask-toggle').addEventListener('click', () => {
    state.showMask = !state.showMask;
    applyToggles();
    renderAI();
    renderRace();
  });
  $('checkpoint').addEventListener('change', (e) => selectCheckpoint(e.target.value));

  // Build the games synchronously before the first await. The board is created
  // in initPlay/initAI/initRace, so it is already interactive; without this a
  // fast interaction during the contract fetch hits a null game and throws.
  rebuildForSeed();

  state.contract = await resolveContract();
  setBackendBadge(false, state.contract.real);
  populateCheckpoints();

  await selectCheckpoint(state.checkpointId);
  applyToggles();

  // Live HUD clocks.
  setInterval(() => {
    if (state.mode === 'play' && !play.game.finished) {
      $('play-time').textContent = fmtTime(play.clock.read());
    } else if (state.mode === 'ai' && !ai.game.finished) {
      $('ai-time').textContent = fmtTime(ai.clock.read());
    } else if (state.mode === 'race') {
      $('race-human-hud').textContent = raceHud(race.human, race.humanClock);
      $('race-ai-hud').textContent = raceHud(race.ai, race.aiClock);
    }
  }, 250);
}

boot().catch((err) => {
  console.error('boot failed', err);
  const el = document.getElementById('boot-error');
  if (el) {
    el.hidden = false;
    el.textContent = `Startup error: ${err.message}`;
  }
});
