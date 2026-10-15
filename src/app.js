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
  ai.board = createBoardView($('ai-board'), { label: 'AI board' });
  ai.board.interactive = false;
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
  race.aiBoard = createBoardView($('race-ai'), { label: 'AI board' });
  race.aiBoard.interactive = false;
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

/* ================================================================ MODES === */

function setMode(mode) {
  state.mode = mode;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.mode === mode);
    tab.setAttribute('aria-selected', tab.dataset.mode === mode ? 'true' : 'false');
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.hidden = panel.dataset.panel !== mode;
  }
  if (mode !== 'ai') stopAILoop();
  if (mode !== 'race') stopRaceLoop();

  if (mode === 'play') {
    if (!play.game) resetPlay();
    renderPlay();
  } else if (mode === 'ai') {
    if (!ai.game) resetAI();
    renderAI();
  } else {
    if (!race.human) resetRace();
    renderRace();
  }
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
}

async function boot() {
  state.seed = seedFromUrl();
  writeSeedToUrl(state.seed);
  $('seed-input').value = String(state.seed);

  initPlay();
  initAI();
  initRace();

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => setMode(tab.dataset.mode));
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
    try {
      await navigator.clipboard.writeText(location.href);
      $('copy-link').dataset.flash = 'Copied!';
    } catch (err) {
      $('copy-link').dataset.flash = 'Copy blocked';
    }
    setTimeout(() => delete $('copy-link').dataset.flash, 1200);
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

  state.contract = await resolveContract();
  setBackendBadge(false, state.contract.real);
  populateCheckpoints();

  rebuildForSeed();
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
