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
  rec('a11y.board-grid-semantics', dom.gridRole === 'grid' && dom.tabCount === 3, `role=${dom.gridRole}`);
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
  let ckptOk = ckpts.length >= 3;
  const ckptDetail = [];
  for (const id of ckpts) {
    await page.selectOption('#checkpoint', id);
    await page.waitForTimeout(400);
    await page.click('#ai-reset');
    await page.click('#ai-step');
    await page.waitForTimeout(1200);
    const st = await page.evaluate(() => ({
      action: document.getElementById('ai-action').textContent.trim(),
      confidence: document.getElementById('ai-confidence').textContent.trim(),
      badge: document.getElementById('backend-badge').textContent.trim(),
    }));
    ckptDetail.push({ id, ...st });
    if (st.action === '—') ckptOk = false;
  }
  rec('ai.checkpoint-selector', ckptOk, JSON.stringify(ckptDetail));

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
