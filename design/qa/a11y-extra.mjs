const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { writeFileSync } from 'node:fs';
const BASE = process.env.SITE, OUT = process.env.SHOTS;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(String(e.message)));
p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await p.goto(`${BASE}/?seed=4242`, { waitUntil: 'load' });
await p.waitForSelector('#play-board .cell');

const out = {};

// real keyboard: arrow + enter reveals, F flags
await p.focus('#play-board .cell[data-index="27"]');
await p.keyboard.press('ArrowRight');
out.afterArrow = await p.evaluate(() => document.activeElement.getAttribute('aria-label'));
await p.keyboard.press('Enter');
await p.waitForTimeout(150);
out.afterEnter = await p.evaluate(() => ({
  status: document.getElementById('play-status').textContent.trim(),
  revealed: document.querySelectorAll('#play-board .cell.revealed').length,
}));
const idx = await p.evaluate(() => [...document.querySelectorAll('#play-board .cell')].findIndex((c) => c.tabIndex === 0));
await p.focus(`#play-board .cell[data-index="${idx}"]`);
await p.keyboard.press('f');
await p.waitForTimeout(120);
out.afterFlag = await p.evaluate(() => ({
  flags: document.getElementById('play-flags').textContent.trim(),
  flagged: document.querySelectorAll('#play-board .cell.flagged').length,
}));

// focus ring screenshots
await p.focus('#play-board .cell[data-index="27"]');
await p.screenshot({ path: `${OUT}/desktop-focus-cell.png`, clip: { x: 248, y: 308, width: 470, height: 450 } });

// tablist keyboard behavior (WAI-ARIA tab pattern expectation)
await p.focus('.tab[data-mode="play"]');
await p.keyboard.press('ArrowRight');
out.tabAfterArrowRight = await p.evaluate(() => ({
  activeMode: document.querySelector('.tab.active')?.dataset.mode,
  focused: document.activeElement?.dataset?.mode || document.activeElement?.id,
}));
// ARIA wiring for tabs/panels
out.tabAria = await p.evaluate(() =>
  [...document.querySelectorAll('.tab')].map((t) => ({
    mode: t.dataset.mode, role: t.getAttribute('role'), controls: t.getAttribute('aria-controls'),
    selected: t.getAttribute('aria-selected'), tabindex: t.getAttribute('tabindex'),
  })),
);
out.panels = await p.evaluate(() =>
  [...document.querySelectorAll('.panel')].map((x) => ({
    panel: x.dataset.panel, role: x.getAttribute('role'), id: x.id, labelledby: x.getAttribute('aria-labelledby'),
  })),
);
// grid structure
out.grid = await p.evaluate(() => {
  const g = document.getElementById('play-board');
  return {
    role: g.getAttribute('role'),
    rowChildren: g.querySelectorAll('[role="row"]').length,
    ariaRowCount: g.getAttribute('aria-rowcount'),
    ariaColCount: g.getAttribute('aria-colcount'),
    cells: g.querySelectorAll('[role="gridcell"]').length,
  };
});
// non-interactive boards focusability
out.aiBoardFocusable = await p.evaluate(() =>
  [...document.querySelectorAll('#ai-board .cell')].filter((c) => c.tabIndex >= 0).length,
);
out.raceAiFocusable = await p.evaluate(() =>
  [...document.querySelectorAll('#race-ai .cell')].filter((c) => c.tabIndex >= 0).length,
);
// aria-live regions and timer chatter
out.liveRegions = await p.evaluate(() =>
  [...document.querySelectorAll('[aria-live]')].map((e) => ({
    tag: e.tagName, cls: e.className, live: e.getAttribute('aria-live'),
    containsClock: !!e.querySelector('#play-time,#ai-time'),
  })),
);
// measure clock mutation frequency of aria-live subtree over ~1.2s
out.clockMutatePerSec = await p.evaluate(
  () =>
    new Promise((res) => {
      const hud = document.querySelector('aside.hud[aria-live]');
      let n = 0;
      const mo = new MutationObserver((ms) => (n += ms.length));
      mo.observe(hud, { subtree: true, characterData: true, childList: true });
      setTimeout(() => {
        mo.disconnect();
        res(n);
      }, 1200);
    }),
);
// color-scheme / native control rendering hint
out.colorScheme = await p.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
out.themeColor = await p.evaluate(() => document.querySelector('meta[name=theme-color]')?.content);
// check user-scalable & touch
out.viewport = await p.evaluate(() => document.querySelector('meta[name=viewport]')?.content);
out.errors = errors;
out.finalStatus = await p.textContent('#play-status');

writeFileSync(`${OUT}/a11y-extra.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await b.close();
