import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const rootDir = process.env.WORKSPACE_DIR || "/game";
const artifactsDir = process.env.ARTIFACTS_DIR || "/artifacts";
const galleryDir = path.join(artifactsDir, "gallery");

fs.mkdirSync(galleryDir, { recursive: true });

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const server = http.createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0];
  const relPath = urlPath === "/" ? "/index.html" : decodeURIComponent(urlPath);
  const filePath = path.join(rootDir, relPath);
  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

server.listen(4173, "127.0.0.1", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: artifactsDir, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  const startTime = Date.now();

  try {
    await page.goto("http://127.0.0.1:4173/?seed=42", { waitUntil: "domcontentloaded" });
    await sleep(2200);

    // 1. PLAY tab (#tab-play)
    const playButtons = page.locator("#play-board button");
    if ((await playButtons.count()) > 0) {
      await playButtons.nth(27).click().catch(() => {});
      await sleep(500);
      await playButtons.nth(18).click().catch(() => {});
      await sleep(500);
      await playButtons.nth(36).click().catch(() => {});
    }
    await sleep(1400);
    await page.screenshot({ path: path.join(galleryDir, "01-play-cabinet.png") });

    // 2. AI tab (#tab-ai)
    await page.click("#tab-ai");
    await sleep(1200);
    for (let i = 0; i < 3; i++) {
      await page.click("#ai-step").catch(() => {});
      await sleep(800);
    }
    await page.screenshot({ path: path.join(galleryDir, "02-ai-heatmap-step.png") });

    await page.click("#ai-play").catch(() => {});
    await sleep(3600);
    await page.screenshot({ path: path.join(galleryDir, "03-ai-autoplay.png") });

    // 3. RACE tab (#tab-race)
    await page.click("#tab-race");
    await sleep(1000);
    await page.click("#race-start").catch(() => {});
    const humanButtons = page.locator("#race-human button");
    if ((await humanButtons.count()) > 0) {
      await humanButtons.nth(27).click().catch(() => {});
      await sleep(500);
      await humanButtons.nth(19).click().catch(() => {});
    }
    await sleep(3200);
    await page.screenshot({ path: path.join(galleryDir, "04-human-vs-ai-race.png") });

    // 4. CONCURRENT tab (#tab-concurrent)
    await page.click("#tab-concurrent");
    await sleep(1000);
    await page.click("#concurrent-start").catch(() => {});
    await sleep(4500);
    await page.screenshot({ path: path.join(galleryDir, "05-concurrent-9-models.png") });

    // 5. MODELS tab (#tab-models)
    await page.click("#tab-models");
    await sleep(2200);
    await page.screenshot({ path: path.join(galleryDir, "06-model-checkpoints.png") });

    const elapsed = Date.now() - startTime;
    if (elapsed < 30500) {
      await sleep(30500 - elapsed);
    }
  } finally {
    const video = page.video();
    await page.close();
    await context.close();
    await browser.close();
    server.close();
    if (video) {
      const vPath = await video.path();
      const dest = path.join(artifactsDir, "demo.webm");
      fs.copyFileSync(vPath, dest);
      if (vPath !== dest) fs.unlinkSync(vPath);
    }
  }
});
