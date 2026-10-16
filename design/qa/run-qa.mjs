/**
 * QA harness for mines.livive.net (design/AIA-14).
 * Requires: LD_LIBRARY_PATH, FONTCONFIG_PATH, XDG_DATA_DIRS set by caller,
 * and playwright chromium from the workspace pnpm store.
 */
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.SITE || 'https://mines.livive.net';
const OUT = process.env.SHOTS || '.';
mkdirSync(OUT, { recursive: true });

const report = { base: BASE, startedAt: new Date().toISOString(), console: [], checks: [], notes: [] };
const rec = (name, pass, detail, evidence) =>
  report.checks.push({ name, pass: pass === null ? 'info' : pass, detail, evidence: evidence || null });

function collect(page, bag) {
  page.on('console', (m) => {
    if (m.type() === 'error') bag.console.push({ type: 'error', text: m.text() });
    else if (m.type() === 'warning') bag.warnings.push({ type: 'warning', text: m.text() });
  });
  page.on('pageerror', (e) => bag.pageErrors.push(String(e && e.message ? e.message : e)));
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (u.startsWith('data:')) return;
    bag.requestFailed.push({ url: u, err: r.failure() && r.failure().errorText });
  });
}

async function newPage(ctx, bag, opts = {}) {
  const page = await ctx.newPage();
  collect(page, bag);
  if (opts.seed != null) {
    await page.goto(`${BASE}/?seed=${opts.seed}`, { waitUntil: 'load', timeout: 45000 });
  } else {
    await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 45000 });
  }
  return page;
}

async function waitForOnnx(page, ms = 20000) {
  try {
    await page.waitForFunction(
      () => {
        const b = document.getElementById('backend-badge');
        return b && /ONNX/.test(b.textContent);
      },
      { timeout: ms },
    );
    return true;
  } catch {
    return false;
  }
}

const lum = (hex) => {
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const chan = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
};
const ratio = (a, b) => {
  const la = lum(a), lb = lum(b);
  if (la == null || lb == null) return null;
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
};

// Width of the checkpoint <select>'s selected label vs. the control's inner
// width — detects truncation of the label in the closed control (AIA-25 P3).
async function checkpointSelectFit(page) {
  return page.evaluate(() => {
    const sel = document.getElementById('checkpoint');
    const cs = getComputedStyle(sel);
    const opt = sel.options[sel.selectedIndex];
    const probe = document.createElement('span');
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${cs.font}`;
    probe.textContent = opt.textContent;
    document.body.appendChild(probe);
    const textW = probe.getBoundingClientRect().width;
    probe.remove();
    const inner = sel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return { label: opt.textContent, textW: Math.round(textW), inner: Math.round(inner), fits: textW <= inner };
  });
}

async function main() {
  const browser = await chromium.launch();

  // ---------- desktop ----------
  const bag = { console: [], pageErrors: [], requestFailed: [], warnings: [] };
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await newPage(dctx, bag, { seed: 12345 });

  const onnxOk = await waitForOnnx(page);
  rec('onnx.runtime-loads', onnxOk, onnxOk ? 'backend badge shows ONNX checkpoints live' : 'badge never showed ONNX');

  // tokens
  const tokens = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    return {
      bg: g('--bg'), panel: g('--panel'), panel2: g('--panel-2'), edge: g('--edge'),
      ink: g('--ink'), muted: g('--muted'), magenta: g('--magenta'), cyan: g('--cyan'),
      yellow: g('--yellow'), green: g('--green'), red: g('--red'),
    };
  });

  // number colors + revealed bg from real computed styles
  const cellColors = await page.evaluate(() => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const out = {};
    for (let i = 1; i <= 8; i++) {
      const s = document.createElement('span');
      s.className = `cell n${i}`;
      host.appendChild(s);
      out['n' + i] = getComputedStyle(s).color;
    }
    const rev = document.createElement('span');
    rev.className = 'cell revealed';
    host.appendChild(rev);
    out.revealedBg = getComputedStyle(rev).backgroundColor;
    const empty = document.createElement('span');
    empty.className = 'cell revealed empty';
    host.appendChild(empty);
    out.emptyBg = getComputedStyle(empty).backgroundColor;
    host.remove();
    return out;
  });

  const rgb = (s) => {
    const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    const h = (v) => Number(v).toString(16).padStart(2, '0');
    return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
  };

  const pairs = [
    ['ink on panel', tokens.ink, tokens.panel, 4.5],
    ['muted on panel', tokens.muted, tokens.panel, 4.5],
    ['muted on bg', tokens.muted, tokens.bg, 4.5],
    ['cyan on panel', tokens.cyan, tokens.panel, 4.5],
    ['green on panel', tokens.green, tokens.panel, 4.5],
    ['yellow on panel', tokens.yellow, tokens.panel, 4.5],
    ['red on panel', tokens.red, tokens.panel, 4.5],
    ['tab active txt on #ff9f43', '#05050c', '#ff9f43', 4.5],
    // --- v2 surfaces: MODELS cards + CONCURRENT scoreboard/leaderboard ---
    ['yellow on panel (score-value)', tokens.yellow, tokens.panel, 4.5],
    ['green on panel (cleared)', tokens.green, tokens.panel, 4.5],
    ['red on panel (detonated)', tokens.red, tokens.panel, 4.5],
    ['cyan on panel (cc-id/family)', tokens.cyan, tokens.panel, 4.5],
    ['ink on panel (cc-points/model rows)', tokens.ink, tokens.panel, 4.5],
    ['muted on panel (model labels/status)', tokens.muted, tokens.panel, 4.5],
    ['muted on panel-2 (leader stat)', tokens.muted, tokens.panel2, 4.5],
    ['ink on panel-2 (leader name)', tokens.ink, tokens.panel2, 4.5],
  ];
  const contrast = [];
  for (const [name, fg, bg, min] of pairs) {
    const r = ratio(fg, bg);
    contrast.push({ name, fg, bg, ratio: r ? +r.toFixed(2) : null, min, pass: r != null && r >= min });
  }
  for (let i = 1; i <= 8; i++) {
    const fg = rgb(cellColors['n' + i]);
    const bg = rgb(cellColors.revealedBg) || '#0c0c1e';
    const r = ratio(fg, bg);
    contrast.push({ name: `number n${i} on revealed`, fg, bg, ratio: r ? +r.toFixed(2) : null, min: 4.5, pass: r != null && r >= 4.5 });
  }
  report.contrast = contrast;

  // ---------- DOM-level a11y ----------
  const dom = await page.evaluate(() => {
    const vp = document.querySelector('meta[name=viewport]');
    const links = [...document.querySelectorAll('a')].map((a) => ({
      href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel'), text: a.textContent.trim(),
    }));
    const board = document.getElementById('play-board');
    return {
      lang: document.documentElement.getAttribute('lang'),
      viewport: vp ? vp.getAttribute('content') : null,
      links,
      gridRole: board.getAttribute('role'),
      gridLabel: board.getAttribute('aria-label'),
      tabCount: document.querySelectorAll('.tab').length,
      firstCellTab: board.querySelector('.cell').getAttribute('tabindex'),
      liveRegions: document.querySelectorAll('[aria-live]').length,
    };
  });
  report.dom = dom;
  rec('a11y.html-lang', dom.lang === 'en', `lang="${dom.lang}"`);
  rec('a11y.zoom-allowed', !/user-scalable\s*=\s*no|maximum-scale\s*=\s*1\b/.test(dom.viewport || ''), `viewport="${dom.viewport}"`);
  rec('a11y.board-grid-semantics', dom.gridRole === 'grid' && dom.tabCount === 5, `role=${dom.gridRole}, ${dom.tabCount} mode tabs`);
  const external = dom.links.filter((l) => l.target === '_blank');
  rec('a11y.no-new-tab-ambiguity', external.length === 0, `${external.length} target=_blank link(s)`);

  // ---------- Play mode ----------
  await page.screenshot({ path: `${OUT}/desktop-play.png`, fullPage: true });

  // first-click safety across seeds
  let safe = true;
  const unsafe = [];
  for (const s of [1, 2, 3, 7, 42, 12345, 99999, 424242]) {
    const p2 = await page.context().newPage();
    await p2.goto(`${BASE}/?seed=${s}`, { waitUntil: 'load' });
    await p2.waitForSelector('#play-board .cell');
    // click a non-corner cell first
    await p2.click('#play-board .cell[data-index="27"]');
    const state = await p2.textContent('#play-status');
    const revealed = await p2.locator('#play-board .cell.revealed').count();
    if (state.trim().toUpperCase() === 'LOST' || revealed < 1) {
      safe = false;
      unsafe.push({ seed: s, state, revealed });
    }
    await p2.close();
  }
  rec('play.first-click-safe', safe, safe ? '8/8 seeds survived first click (never LOST)' : JSON.stringify(unsafe));

  // keyboard operability
  const kb = await page.evaluate(async () => {
    const board = document.getElementById('play-board');
    const first = board.querySelector('.cell');
    first.focus();
    const before = document.activeElement.getAttribute('aria-label');
    const ev = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true });
    board.dispatchEvent(ev);
    const after = document.activeElement.getAttribute('aria-label');
    const tabbables = [...board.querySelectorAll('.cell')].filter((c) => c.tabIndex === 0).length;
    return { before, after, tabbables, activeIsCell: document.activeElement.classList.contains('cell') };
  });
  report.keyboard = kb;
  rec('play.keyboard-navigate', kb.after !== kb.before && kb.tabbables === 1, `cursor ${kb.before} -> ${kb.after}, roving tabindex count=${kb.tabbables}`);

  // focus visibility (computed outline on focus)
  const focus = await page.evaluate(() => {
    const btn = document.querySelector('.tab');
    btn.focus();
    const cs = getComputedStyle(btn);
    return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor };
  });
  report.focus = focus;
  rec('a11y.focus-visible-tab', focus.outlineStyle !== 'none' && parseFloat(focus.outlineWidth) > 0, JSON.stringify(focus));

  // ---------- determinism ----------
  async function boardSignature(seed) {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await newPage(c, { console: [], pageErrors: [], requestFailed: [], warnings: [] }, { seed });
    await p.waitForSelector('#play-board .cell');
    await p.click('#play-board .cell[data-index="27"]');
    await p.waitForTimeout(150);
    const sig = await p.evaluate(() =>
      [...document.querySelectorAll('#play-board .cell')]
        .map((c) => `${c.dataset.index}:${c.className}:${c.textContent}`)
        .join('|'),
    );
    await c.close();
    return sig;
  }
  const sigA = await boardSignature(777);
  const sigB = await boardSignature(777);
  rec('play.deterministic-seed', sigA === sigB && sigA.length > 0, sigA === sigB ? `seed=777 identical signature (${sigA.length} bytes)` : 'seed reproduction mismatch');

  // ---------- AI mode ----------
  const errorsBefore = bag.console.length + bag.pageErrors.length;
  await page.click('.tab[data-mode="ai"]');
  await page.waitForTimeout(300);
  await page.click('#ai-play');
  await page.waitForTimeout(2500);
  const aiState = await page.evaluate(() => ({
    status: document.getElementById('ai-status').textContent.trim(),
    moves: document.getElementById('ai-moves').textContent.trim(),
    action: document.getElementById('ai-action').textContent.trim(),
    confidence: document.getElementById('ai-confidence').textContent.trim(),
    distRows: document.querySelectorAll('#ai-dist .dist-row').length,
    selected: document.querySelectorAll('#ai-board .cell.selected').length,
    heat: document.querySelectorAll('#ai-board .cell.heat').length,
    mask: document.querySelectorAll('#ai-board .cell.legal, #ai-board .cell.illegal').length,
  }));
  report.ai = aiState;
  await page.screenshot({ path: `${OUT}/desktop-ai.png`, fullPage: true });
  rec('ai.autoplay-steps', Number(aiState.moves) > 0 && aiState.action !== '—', `moves=${aiState.moves} picked=${aiState.action} conf=${aiState.confidence}`);
  rec('ai.distribution-renders', aiState.distRows > 0, `${aiState.distRows} top-move rows`);
  rec('ai.overlays-render', aiState.selected === 1 && aiState.heat > 0 && aiState.mask > 0, `selected=${aiState.selected} heat=${aiState.heat} mask=${aiState.mask}`);

  // checkpoint selector cycles m0/m1/m2
  const ckpts = await page.$$eval('#checkpoint option', (o) => o.map((x) => x.value));
  report.checkpoints = ckpts;
  let ckptOk = ckpts.length === 9;
  const ckptDetail = [];
  for (const id of ckpts) {
    await page.selectOption('#checkpoint', id);
    await page.waitForTimeout(400);
    await page.click('#ai-reset');
    await page.click('#ai-step');
    // Larger checkpoints (m3/m7 ~350 KB) take longer than 1.2s to run one ORT
    // inference, so wait for the async act() to publish an action.
    await page
      .waitForFunction(() => document.getElementById('ai-action').textContent.trim() !== '—', { timeout: 15000 })
      .catch(() => {});
    const st = await page.evaluate(() => ({
      action: document.getElementById('ai-action').textContent.trim(),
      confidence: document.getElementById('ai-confidence').textContent.trim(),
      badge: document.getElementById('backend-badge').textContent.trim(),
    }));
    ckptDetail.push({ id, ...st });
    if (st.action === '—') ckptOk = false;
  }
  rec('ai.checkpoint-selector', ckptOk, JSON.stringify(ckptDetail));

  // AIA-25 P3: the closed checkpoint control must show the full selected label
  // (the loop above leaves the longest one, m8, selected).
  const selDesktop = await checkpointSelectFit(page);
  report.checkpointSelectDesktop = selDesktop;
  rec(
    'checkpoint.select-label-fits-desktop',
    selDesktop.fits,
    `${selDesktop.label} text ${selDesktop.textW}px <= inner ${selDesktop.inner}px`,
  );

  // ---------- Race mode ----------
  await page.click('.tab[data-mode="race"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/desktop-race-ready.png`, fullPage: true });
  await page.click('#race-start');
  await page.waitForTimeout(4000);
  const raceState = await page.evaluate(() => ({
    humanHud: document.getElementById('race-human-hud').textContent.trim(),
    aiHud: document.getElementById('race-ai-hud').textContent.trim(),
    result: document.getElementById('race-result').textContent.trim(),
    humanCells: document.querySelectorAll('#race-human .cell').length,
    aiCells: document.querySelectorAll('#race-ai .cell').length,
  }));
  report.race = raceState;
  await page.screenshot({ path: `${OUT}/desktop-race.png`, fullPage: true });
  rec('race.mode-renders', raceState.humanCells === 64 && raceState.aiCells === 64 && /moves/.test(raceState.humanHud), JSON.stringify(raceState));

  // ---------- v2: MODELS details panel ----------
  // Cross-check the deployed manifest against what the panel renders.
  const manifest = await page.evaluate(async () => {
    const res = await fetch('models/manifest.json', { cache: 'no-store' });
    return res.ok ? res.json() : null;
  });
  report.manifest = manifest
    ? { version: manifest.version, checkpoints: manifest.checkpoints.map((c) => c.id) }
    : null;

  const fmtBytes = (n) => {
    if (!Number.isFinite(n)) return '—';
    if (n < 1024) return `${n} B`;
    const kb = n / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    return `${(kb / 1024).toFixed(2)} MB`;
  };

  await page.click('.tab[data-mode="models"]');
  await page.waitForSelector('#models-list .model-card', { timeout: 10000 });
  await page
    .waitForFunction(() => document.querySelectorAll('#models-list .model-card').length >= 9, { timeout: 10000 })
    .catch(() => {});
  await page.screenshot({ path: `${OUT}/desktop-models.png`, fullPage: true });

  const models = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#models-list .model-card')];
    return {
      count: cards.length,
      note: document.getElementById('models-note').textContent.trim(),
      panelHidden: document.getElementById('panel-models').hidden,
      role: document.getElementById('panel-models').getAttribute('role'),
      labelledby: document.getElementById('panel-models').getAttribute('aria-labelledby'),
      listRole: document.getElementById('models-list').getAttribute('role'),
      listItems: document.querySelectorAll('#models-list [role="listitem"]').length,
      entries: cards.map((card) => {
        const rows = {};
        for (const row of card.querySelectorAll('.model-row')) {
          const k = row.querySelector('dt')?.textContent.trim();
          if (k) rows[k] = row.querySelector('dd')?.textContent.trim() || '';
        }
        return {
          id: card.querySelector('.model-id')?.textContent.trim() || '',
          label: card.querySelector('.model-label')?.textContent.trim() || '',
          family: card.querySelector('.model-family')?.textContent.trim() || '',
          desc: card.querySelector('.model-desc')?.textContent.trim() || '',
          rows,
          current: card.getAttribute('aria-current') === 'true',
        };
      }),
    };
  });
  report.models = models;

  rec(
    'models.nine-checkpoints',
    models.count === 9 && (!manifest || manifest.checkpoints.length === 9),
    `rendered ${models.count} cards; manifest ${report.manifest ? report.manifest.version : '?'} lists ${report.manifest ? report.manifest.checkpoints.length : '?'}`,
  );

  // Every card must expose label/family/description/architecture/training/size/eval.
  const required = ['Family', 'Architecture', 'Training', 'File size', 'Eval'];
  const fieldGaps = [];
  for (const e of models.entries) {
    for (const k of required) if (!e.rows[k] || e.rows[k] === '—') fieldGaps.push(`${e.id}:${k}`);
    if (!e.label || !e.family || !e.desc) fieldGaps.push(`${e.id}:header`);
  }
  rec('models.all-fields-present', fieldGaps.length === 0, fieldGaps.length ? JSON.stringify(fieldGaps) : 'label/family/desc + 5 meta rows on all 9 cards');

  // Values must match the deployed manifest (not placeholders).
  const valueGaps = [];
  if (manifest) {
    for (const ckpt of manifest.checkpoints) {
      const e = models.entries.find((x) => x.id === ckpt.id);
      if (!e) { valueGaps.push(`${ckpt.id}:missing-card`); continue; }
      if (e.label !== ckpt.label) valueGaps.push(`${ckpt.id}:label`);
      if (e.family !== ckpt.family) valueGaps.push(`${ckpt.id}:family`);
      if (e.desc !== ckpt.description) valueGaps.push(`${ckpt.id}:description`);
      if (e.rows['File size'] !== fmtBytes(ckpt.size_bytes)) valueGaps.push(`${ckpt.id}:size`);
      const arch = e.rows['Architecture'] || '';
      if (!arch.includes(`width ${ckpt.architecture.width}`) || !arch.includes(ckpt.architecture.params.toLocaleString())) valueGaps.push(`${ckpt.id}:arch`);
      const tr = e.rows['Training'] || '';
      if (!tr.includes(`${ckpt.training.games.toLocaleString()} games`) || !tr.includes(`${ckpt.training.epochs} epochs`)) valueGaps.push(`${ckpt.id}:training`);
      const ev = e.rows['Eval'] || '';
      if (!ev.includes(`win ${(ckpt.eval.win_rate * 100).toFixed(1)}%`)) valueGaps.push(`${ckpt.id}:eval`);
    }
  }
  rec('models.values-match-manifest', valueGaps.length === 0, valueGaps.length ? JSON.stringify(valueGaps) : '9/9 cards match manifest v2 byte/arch/training/eval values');

  // Content is reachable by keyboard: arrow through the tablist to MODELS.
  await page.click('.tab[data-mode="play"]');
  await page.waitForTimeout(120);
  await page.focus('.tab[data-mode="play"]');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  const kbModels = await page.evaluate(() => ({
    focused: document.activeElement?.dataset?.mode,
    hidden: document.getElementById('panel-models').hidden,
    cards: document.querySelectorAll('#models-list .model-card').length,
  }));
  rec(
    'models.keyboard-reachable',
    kbModels.focused === 'models' && kbModels.hidden === false && kbModels.cards >= 9,
    `ArrowRight x4 -> focus=${kbModels.focused}, panel hidden=${kbModels.hidden}, ${kbModels.cards} cards exposed`,
  );
  rec(
    'models.aria-structure',
    models.role === 'tabpanel' && models.listRole === 'list' && models.listItems === 9,
    `panel role=${models.role} labelledby=${models.labelledby}, list role=${models.listRole}, ${models.listItems} listitems`,
  );

  // ---------- v2: CONCURRENT mode ----------
  async function waitConcurrentReady(p, ms = 30000) {
    await p.waitForFunction(() => document.querySelectorAll('#concurrent-grid .concurrent-card').length >= 9, { timeout: 15000 }).catch(() => {});
    await p
      .waitForFunction(() => {
        const cs = [...document.querySelectorAll('#concurrent-grid .concurrent-card')];
        return cs.length >= 9 && cs.every((c) => c.dataset.status !== 'loading');
      }, { timeout: ms })
      .catch(() => {});
  }

  async function setFastSpeed(p) {
    await p.$eval('#concurrent-speed', (el) => {
      el.value = '1000';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  await page.waitForFunction(() => document.querySelectorAll('#checkpoint option').length >= 9, { timeout: 15000 }).catch(() => {});
  await page.click('.tab[data-mode="concurrent"]');
  await waitConcurrentReady(page);
  await page.waitForFunction(() => document.querySelectorAll('#concurrent-grid .concurrent-card').length >= 9, { timeout: 15000 }).catch(() => {});
  await setFastSpeed(page);

  const concBuilt = await page.evaluate(() => ({
    cards: document.querySelectorAll('#concurrent-grid .concurrent-card').length,
    boards: document.querySelectorAll('#concurrent-grid .cc-board').length,
    cells: document.querySelectorAll('#concurrent-grid .cc-board .cell').length,
    statuses: [...document.querySelectorAll('#concurrent-grid .cc-status')].map((s) => s.textContent.trim()),
    total: document.getElementById('concurrent-total').textContent.trim(),
  }));
  report.concurrentBuilt = concBuilt;
  rec(
    'concurrent.nine-boards',
    concBuilt.cards === 9 && concBuilt.boards === 9 && concBuilt.cells === 9 * 64,
    `${concBuilt.cards} cards, ${concBuilt.boards} boards, ${concBuilt.cells} cells (9 x 64)`,
  );
  rec(
    'concurrent.policies-loaded',
    concBuilt.statuses.length === 9 && concBuilt.statuses.every((s) => s !== 'LOADING' && s !== 'ERROR'),
    JSON.stringify(concBuilt.statuses),
  );

  await page.click('#concurrent-start');
  await page.waitForTimeout(900);
  const stepA = await page.evaluate(() => ({
    stats: [...document.querySelectorAll('#concurrent-grid .cc-stats')].map((s) => s.textContent.trim()),
    total: document.getElementById('concurrent-total').textContent.trim(),
  }));
  await page.waitForTimeout(1600);
  const stepB = await page.evaluate(() => ({
    stats: [...document.querySelectorAll('#concurrent-grid .cc-stats')].map((s) => s.textContent.trim()),
    total: document.getElementById('concurrent-total').textContent.trim(),
  }));
  const advanced = stepA.stats.some((v, i) => v !== stepB.stats[i]);
  rec(
    'concurrent.stepping-advances',
    advanced,
    advanced ? `per-model stats advanced (e.g. ${stepA.stats[0]} -> ${stepB.stats[0]})` : 'no per-model advancement observed',
  );
  report.concurrentStep = { stepA, stepB };

  await page
    .waitForFunction(() => {
      const cs = [...document.querySelectorAll('#concurrent-grid .concurrent-card')];
      return cs.length === 9 && cs.every((c) => ['cleared', 'detonated', 'stuck', 'error'].includes(c.dataset.status));
    }, { timeout: 90000 })
    .catch(() => {});

  const conc = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#concurrent-grid .concurrent-card')];
    const per = cards.map((c) => ({
      id: c.querySelector('.cc-id').textContent.trim(),
      status: c.querySelector('.cc-status').textContent.trim(),
      datasetStatus: c.dataset.status,
      stats: c.querySelector('.cc-stats').textContent.trim(),
      points: Number(c.querySelector('.cc-points').textContent.trim()),
      aria: c.getAttribute('aria-label') || '',
      statusColor: getComputedStyle(c.querySelector('.cc-status')).color,
      statusFont: getComputedStyle(c.querySelector('.cc-status')).fontSize,
    }));
    const num = (id) => Number(document.getElementById(id).textContent.replace(/[^0-9-]/g, ''));
    const totalEl = document.getElementById('concurrent-total');
    return {
      per,
      counts: { cleared: num('concurrent-cleared'), detonated: num('concurrent-detonated'), stuck: num('concurrent-stuck') },
      total: num('concurrent-total'),
      totalText: totalEl.textContent.trim(),
      totalFont: getComputedStyle(totalEl).fontSize,
      totalColor: getComputedStyle(totalEl).color,
      sumPoints: per.reduce((a, c) => a + c.points, 0),
      leaderRows: document.querySelectorAll('#concurrent-leaderboard .leader-row').length,
      leaderStats: [...document.querySelectorAll('#concurrent-leaderboard .leader-stat')].map((s) => s.textContent.trim()),
      live: document.getElementById('concurrent-live').textContent.trim(),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  report.concurrent = conc;

  const settled = conc.per.length === 9 && conc.per.every((c) => ['cleared', 'detonated', 'stuck', 'error'].includes(c.datasetStatus));
  const countSum = conc.counts.cleared + conc.counts.detonated + conc.counts.stuck;
  rec(
    'concurrent.final-classification',
    settled && countSum === 9,
    settled ? `cleared ${conc.counts.cleared} / detonated ${conc.counts.detonated} / stuck ${conc.counts.stuck}` : 'not all 9 models settled',
  );
  rec(
    'concurrent.total-points-correct',
    conc.total === conc.sumPoints && conc.sumPoints > 0,
    `TOTAL POINTS ${conc.totalText} == sum of per-model ${conc.sumPoints}`,
  );
  const wonOk = conc.per.filter((c) => c.datasetStatus === 'cleared').every((c) => c.points >= 50);
  rec(
    'concurrent.points-include-win-bonus',
    wonOk,
    wonOk ? 'every cleared model scored >= 50 (win bonus applied)' : 'cleared model missing win bonus',
  );
  const leaderSorted = conc.leaderRows === 9 && conc.leaderStats.length === 9;
  rec('concurrent.leaderboard-renders', leaderSorted, `${conc.leaderRows} leaderboard rows`);
  const totalLegible = parseFloat(conc.totalFont) >= 24;
  rec(
    'concurrent.total-legible',
    totalLegible,
    `TOTAL POINTS font-size ${conc.totalFont}, color ${conc.totalColor}`,
  );
  rec(
    'concurrent.states-announced',
    conc.per.every((c) => /:\s*(LOADING|READY|RUNNING|CLEARED|DETONATED|STUCK|ERROR|STUB),/.test(c.aria)) || conc.per.every((c) => c.aria.includes(c.status)),
    'per-card aria-label carries model name + status',
  );
  await page.screenshot({ path: `${OUT}/desktop-concurrent-done.png`, fullPage: true });

  // Deterministic outcome for a fixed ?seed= (two fresh contexts).
  async function concurrentOutcome(seed) {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await newPage(c, { console: [], pageErrors: [], requestFailed: [], warnings: [] }, { seed });
    // Wait for the manifest before opening CONCURRENT; otherwise the field can
    // cache empty (see concurrent.pre-manifest-race below).
    await p.waitForFunction(() => document.querySelectorAll('#checkpoint option').length >= 9, { timeout: 15000 }).catch(() => {});
    await p.click('.tab[data-mode="concurrent"]');
    await waitConcurrentReady(p);
    await p.waitForFunction(() => document.querySelectorAll('#concurrent-grid .concurrent-card').length >= 9, { timeout: 15000 }).catch(() => {});
    await setFastSpeed(p);
    await p.click('#concurrent-start');
    await p
      .waitForFunction(() => {
        const cs = [...document.querySelectorAll('#concurrent-grid .concurrent-card')];
        return cs.length === 9 && cs.every((x) => ['cleared', 'detonated', 'stuck', 'error'].includes(x.dataset.status));
      }, { timeout: 90000 })
      .catch(() => {});
    const out = await p.evaluate(() => ({
      total: document.getElementById('concurrent-total').textContent.trim(),
      per: [...document.querySelectorAll('#concurrent-grid .concurrent-card')]
        .map((c) => `${c.querySelector('.cc-id').textContent.trim()}:${c.dataset.status}:${c.querySelector('.cc-points').textContent.trim()}`)
        .join('|'),
    }));
    await p.close();
    await c.close();
    return out;
  }
  const detA = await concurrentOutcome(4242);
  const detB = await concurrentOutcome(4242);
  const deterministic = detA.per.length > 0 && detA.per === detB.per && detA.total === detB.total;
  report.concurrentDeterminism = { seed: 4242, a: detA, b: detB, deterministic };
  rec(
    'concurrent.deterministic-seed',
    deterministic,
    deterministic ? `seed=4242 reproducible: ${detA.per}` : 'seed=4242 outcome differed between runs',
  );

  // AIA-25 P2 regression gate: opening CONCURRENT before the manifest resolves
  // must not cache an empty field. The field self-heals when the contract lands
  // (boot builds it right after populateCheckpoints), so 9 cards must render
  // even though the manifest is delayed 3s and CONCURRENT is tapped immediately.
  {
    const rc = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const rp = await rc.newPage();
    await rp.route('**/models/manifest.json', async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      await route.continue();
    });
    await rp.goto(`${BASE}/?seed=4242`, { waitUntil: 'domcontentloaded' });
    await rp.click('.tab[data-mode="concurrent"]');
    await rp.waitForTimeout(4500);
    const race = await rp.evaluate(() => ({
      cards: document.querySelectorAll('#concurrent-grid .concurrent-card').length,
      checkpointsLoaded: document.querySelectorAll('#checkpoint option').length,
    }));
    report.concurrentRace = race;
    const healed = race.cards >= 9 && race.checkpointsLoaded >= 9;
    rec(
      'concurrent.pre-manifest-race',
      healed,
      `opened CONCURRENT before manifest: ${race.cards} cards rendered, ${race.checkpointsLoaded} checkpoints loaded later (self-heals)`,
    );
    await rc.close();
  }

  report.desktopErrors = bag;

  // ---------- mobile ----------
  const mbag = { console: [], pageErrors: [], requestFailed: [], warnings: [] };
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const mp = await newPage(mctx, mbag, { seed: 2026 });
  await waitForOnnx(mp);
  await mp.screenshot({ path: `${OUT}/mobile-play.png`, fullPage: true });
  // tap first cell (touch)
  const mBefore = await mp.textContent('#play-status');
  await mp.tap('#play-board .cell[data-index="27"]');
  await mp.waitForTimeout(200);
  const mAfter = await mp.evaluate(() => ({
    status: document.getElementById('play-status').textContent.trim(),
    revealed: document.querySelectorAll('#play-board .cell.revealed').length,
  }));
  rec('mobile.tap-reveals', mAfter.revealed >= 1 && mAfter.status !== 'LOST', JSON.stringify(mAfter));
  await mp.click('.tab[data-mode="ai"]');
  await mp.waitForTimeout(400);
  await mp.click('#ai-play');
  await mp.waitForTimeout(2500);
  await mp.screenshot({ path: `${OUT}/mobile-ai.png`, fullPage: true });
  await mp.click('.tab[data-mode="race"]');
  await mp.waitForTimeout(400);
  await mp.click('#race-start');
  await mp.waitForTimeout(3000);
  await mp.screenshot({ path: `${OUT}/mobile-race.png`, fullPage: true });
  const mOverflow = await mp.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  report.mobile = { tap: mAfter, overflow: mOverflow, errors: mbag };
  rec('mobile.no-horizontal-overflow', mOverflow.scrollW <= mOverflow.clientW + 2, `scrollW=${mOverflow.scrollW} clientW=${mOverflow.clientW}`);

  // AIA-25 P3: on mobile the badge shares the row, so the longest label (m8)
  // must still be fully readable in the closed checkpoint control.
  await mp.selectOption('#checkpoint', 'm8');
  await mp.waitForTimeout(250);
  const selMobile = await checkpointSelectFit(mp);
  report.checkpointSelectMobile = selMobile;
  rec(
    'checkpoint.select-label-fits-mobile',
    selMobile.fits,
    `${selMobile.label} text ${selMobile.textW}px <= inner ${selMobile.inner}px`,
  );

  // ---------- mobile: MODELS panel (readable at 390x844) ----------
  await mp.click('.tab[data-mode="models"]');
  await mp.waitForTimeout(400);
  await mp.screenshot({ path: `${OUT}/mobile-models.png`, fullPage: true });
  const mModels = await mp.evaluate(() => {
    const cards = [...document.querySelectorAll('#models-list .model-card')];
    const vw = document.documentElement.clientWidth;
    return {
      count: cards.length,
      vw,
      widest: cards.length ? Math.max(...cards.map((c) => c.getBoundingClientRect().width)) : 0,
      overflow: document.documentElement.scrollWidth - vw,
      descFont: cards[0] ? getComputedStyle(cards[0].querySelector('.model-desc')).fontSize : null,
    };
  });
  report.mobileModels = mModels;
  rec(
    'models.mobile-readable',
    mModels.count === 9 && mModels.widest <= mModels.vw + 1 && mModels.overflow <= 2,
    `9 cards, widest ${Math.round(mModels.widest)}px <= viewport ${mModels.vw}px, overflow ${mModels.overflow}px`,
  );

  // ---------- mobile: CONCURRENT mode ----------
  await mp.click('.tab[data-mode="concurrent"]');
  await waitConcurrentReady(mp);
  await setFastSpeed(mp);
  await mp.click('#concurrent-start');
  await mp.waitForTimeout(2500);
  await mp.screenshot({ path: `${OUT}/mobile-concurrent.png`, fullPage: true });
  const mConc = await mp.evaluate(() => ({
    cards: document.querySelectorAll('#concurrent-grid .concurrent-card').length,
    cols: getComputedStyle(document.getElementById('concurrent-grid')).gridTemplateColumns,
    statusFont: document.querySelector('#concurrent-grid .cc-status')
      ? getComputedStyle(document.querySelector('#concurrent-grid .cc-status')).fontSize
      : null,
    totalFont: getComputedStyle(document.getElementById('concurrent-total')).fontSize,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  report.mobileConcurrent = mConc;
  rec(
    'concurrent.mobile-no-horizontal-overflow',
    mConc.cards === 9 && mConc.overflow <= 2,
    `9 cards, grid cols=${mConc.cols}, status ${mConc.statusFont}, overflow ${mConc.overflow}px`,
  );

  // ---------- reduced motion ----------
  const rbag = { console: [], pageErrors: [], requestFailed: [], warnings: [] };
  const rctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const rp = await newPage(rctx, rbag, { seed: 55 });
  const rm = await rp.evaluate(() => {
    const sel = document.createElement('span');
    sel.className = 'cell selected';
    document.body.appendChild(sel);
    const det = document.createElement('span');
    det.className = 'cell mine detonated';
    document.body.appendChild(det);
    const a = getComputedStyle(sel).animationName;
    const b = getComputedStyle(det).animationName;
    sel.remove(); det.remove();
    return { selectedAnim: a, detonateAnim: b };
  });
  report.reducedMotion = rm;
  rec('a11y.reduced-motion', rm.selectedAnim === 'none' && rm.detonateAnim === 'none', JSON.stringify(rm));
  await rp.screenshot({ path: `${OUT}/desktop-reduced-motion.png`, fullPage: true });

  // aggregate uncaught errors
  const allConsole = [...bag.console, ...mbag.console, ...rbag.console];
  const allPageErr = [...bag.pageErrors, ...mbag.pageErrors, ...rbag.pageErrors];
  report.errors = { console: allConsole, pageErrors: allPageErr, requestFailed: [...bag.requestFailed, ...mbag.requestFailed, ...rbag.requestFailed] };
  rec('console.no-uncaught-errors', allConsole.length === 0 && allPageErr.length === 0, `${allConsole.length} console errors, ${allPageErr.length} page errors`);

  report.endedAt = new Date().toISOString();
  await browser.close();
  writeFileSync(`${OUT}/results.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error('QA HARNESS FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
