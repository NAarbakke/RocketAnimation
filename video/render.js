// Renders a page to video: Playwright steps it frame by frame on a virtual clock, ffmpeg encodes the screenshots.
//   npm run render -- "srm.html?film" --duration 18
//   npm run render -- engine.html --duration 20 --fps 60 --size 1280x720 --out video/out/engine-720.mp4
// Frames are stepped, not captured in real time, so a slow GPU only makes the render take longer.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Runs in the page before its scripts: time only moves when __step is called, one rAF tick per call.
function virtualClock() {
  let now = 0, queue = [], id = 0;
  performance.now = () => now;
  window.requestAnimationFrame = cb => (queue.push([++id, cb]), id);
  window.cancelAnimationFrame = h => { queue = queue.filter(([i]) => i !== h); };
  window.__step = ms => { now += ms; const q = queue; queue = []; for (const [, cb] of q) cb(now); };
}

/**
 * @param {object} o
 * @param {string} o.page       page under the project root ("srm.html?film") or a full http(s) URL
 * @param {string} [o.out]      output file; the extension picks the container (default video/out/<page>.mp4)
 * @param {number} [o.duration] seconds of animation
 * @param {number} [o.fps]
 * @param {number} [o.width]
 * @param {number} [o.height]
 * @param {string[]} [o.click]  selectors to click once the page has loaded, before the first frame
 * @param {string} [o.channel]  browser Playwright launches ("chrome", "msedge", or "chromium" for its own build)
 * @returns {Promise<string>} the output path
 */
export async function renderVideo({ page: target, out, duration = 10, fps = 30, width = 1920, height = 1080, click = [], channel = 'chrome' }) {
  const name = basename(new URL(target, 'http://x/').pathname, '.html') || 'index';
  out = resolve(root, out ?? `video/out/${name}.mp4`);
  mkdirSync(dirname(out), { recursive: true });

  const remote = /^https?:/.test(target);
  const server = remote ? null : await (await createServer({ root, logLevel: 'warn' })).listen();
  const url = remote ? target : new URL(target, server.resolvedUrls.local[0]).href;

  const browser = await chromium.launch({ channel: channel === 'chromium' ? undefined : channel, args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'] });
  const ffmpeg = spawn(process.env.FFMPEG_PATH || ffmpegStatic, [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const encoded = once(ffmpeg, 'close');
  ffmpeg.stdin.on('error', () => {}); // a dead ffmpeg is reported through its exit code below

  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on('pageerror', e => console.error(`[page] ${e.message}`));
    await page.addInitScript(virtualClock);
    await page.goto(url, { waitUntil: 'load' });
    for (const sel of click) await page.click(sel);

    // Pages with a film mode (window.__film, see src/srm/main.ts) are told the time directly; the rest get rAF ticks.
    const film = await page.evaluate(() => !!window.__film);
    if (film) await page.evaluate(() => window.__film.ready);
    const sub = Math.ceil(60 / fps), stepMs = 1000 / (fps * sub); // tick at ≥60 Hz so the pages' frame-time heuristics see a fast machine
    const frames = Math.round(duration * fps);
    const cdp = await page.context().newCDPSession(page);
    for (let i = 0; i < frames; i++) {
      if (film) await page.evaluate(t => window.__film.seek(t), i / fps);
      else await page.evaluate(([n, ms]) => { for (let k = 0; k < n; k++) window.__step(ms); }, [sub, stepMs]);
      // straight CDP: lossless, and ~3× quicker than page.screenshot's fully compressed PNG
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
      if (ffmpeg.exitCode !== null) break;
      if (!ffmpeg.stdin.write(Buffer.from(data, 'base64'))) await once(ffmpeg.stdin, 'drain');
      if (process.stdout.isTTY) process.stdout.write(`\rframe ${i + 1}/${frames}`);
    }
    if (process.stdout.isTTY) process.stdout.write('\n');
  } finally {
    ffmpeg.stdin.end();
    await browser.close();
    await server?.close();
  }
  const [code] = await encoded;
  if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' }, duration: { type: 'string', short: 'd' }, fps: { type: 'string' },
      size: { type: 'string' }, click: { type: 'string', multiple: true }, channel: { type: 'string' },
    },
  });
  const [width, height] = (v.size ?? '1920x1080').split('x').map(Number);
  const num = s => (s === undefined ? undefined : Number(s));
  const t0 = Date.now();
  const out = await renderVideo({ page: positionals[0] ?? 'index.html', out: v.out, duration: num(v.duration), fps: num(v.fps), width, height, click: v.click, channel: v.channel });
  console.log(`${out} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
