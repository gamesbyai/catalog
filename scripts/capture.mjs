#!/usr/bin/env node
// Captures a cover and two screenshots per game: node scripts/capture.mjs <slug…>
// Game pages are untrusted code. This runs only in CI's capture job, which has no secrets and a read-only token.
// Every game gets a fresh browser context, a hard deadline kept by Node (not by Playwright), and nothing
// from the page is ever read back except the pixels of the screenshots.
// Games whose creator sent screenshots with the submission (provenance.uploads) are never captured; the upload job
// fetches those instead. node scripts/capture.mjs --split <slug-list file> prints { capture, uploads } for the workflow.
import { mkdirSync, rmSync, rmdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { uploadsOf } from './upload.mjs';

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const NAMES = ['cover', 'shot-1', 'shot-2'];
const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const DEFAULTS = {
  // ms after load. More frames than we keep: pickFrames drops loading and black screens and keeps the best three.
  times: [2500, 5000, 8000, 11500, 15000],
  navTimeout: 20_000,
  deadline: 70_000, // per game, from start to files on disk
  shotTimeout: 15_000, // WebGL games render in software on CI runners (no GPU), so frames can be slow
  clickTimeout: 2000,
  closeTimeout: 5000,
  viewport: { width: 1280, height: 720 },
  allowLocalHttp: false, // tests only: http://127.0.0.1
  sandbox: process.env.CAPTURE_SANDBOX !== '0',
};

class CaptureError extends Error {
  constructor(reason, detail) {
    super(detail || reason);
    this.reason = reason;
  }
}

// Timers are always cleared, so a finished capture never keeps the process alive.
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}

/** Resolves with p's value, or with `fallback` after ms. Never rejects. */
function within(p, ms, fallback) {
  let t;
  const timeout = new Promise((resolve) => (t = setTimeout(resolve, ms, fallback)));
  return Promise.race([Promise.resolve(p).catch(() => fallback), timeout]).finally(() => clearTimeout(t));
}

export function checkUrl(url, { allowLocalHttp = false } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  return allowLocalHttp && u.protocol === 'http:' && u.hostname === '127.0.0.1';
}

// One browser per process, launched through launchServer so a hung browser can be killed outright.
let server = null;
let browser = null;
let launchedSandbox = null;

async function getBrowser(sandbox) {
  if (browser?.isConnected() && launchedSandbox === sandbox) return browser;
  await killBrowser();
  // Runners have no GPU: let WebGL fall back to SwiftShader instead of failing, so 3D games still draw a frame.
  server = await chromium.launchServer({ headless: true, chromiumSandbox: sandbox, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  browser = await chromium.connect(server.wsEndpoint());
  launchedSandbox = sandbox;
  return browser;
}

export async function killBrowser() {
  const s = server;
  server = null;
  browser = null;
  if (s) await within(s.kill(), 10_000);
}

export async function closeBrowser() {
  const b = browser;
  if (!b) return killBrowser();
  const closed = await within(b.close().then(() => true), 5000, false);
  if (closed && server) await within(server.close(), 5000);
  await killBrowser();
}

async function closeContext(context, closeTimeout) {
  if (!context) return;
  const closed = await within(context.close().then(() => true, () => true), closeTimeout, false);
  if (!closed) await killBrowser();
}

const thumbDiff = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
};

/**
 * Picks the frames worth showing: drops near-black, near-white and flat frames (loading screens, blank canvases),
 * orders the rest by detail (entropy), and skips near-duplicates. Returns up to `max` PNG buffers, best first.
 */
export async function pickFrames(frames, { max = 3 } = {}) {
  const info = await Promise.all(
    frames.map(async (buf) => {
      const stats = await sharp(buf).stats();
      const rgb = stats.channels.slice(0, 3);
      const mean = rgb.reduce((s, c) => s + c.mean, 0) / rgb.length;
      const sd = rgb.reduce((s, c) => s + c.stdev, 0) / rgb.length;
      const thumb = await sharp(buf).resize(32, 18, { fit: 'fill' }).greyscale().raw().toBuffer();
      return { buf, mean, sd, entropy: stats.entropy, thumb };
    }),
  );
  let usable = info.filter((f) => f.mean >= 18 && f.mean <= 245 && f.sd >= 12 && f.entropy >= 3).sort((a, b) => b.entropy - a.entropy);
  // Dark games: when no frame passes, one dark title screen with real content (a logo or a menu, not a spinner on
  // black) still beats no cover.
  if (!usable.length) usable = info.filter((f) => f.mean <= 250 && f.sd >= 8 && f.entropy >= 1.5).sort((a, b) => b.entropy - a.entropy).slice(0, 1);
  const kept = [];
  for (const f of usable) {
    if (kept.some((k) => thumbDiff(k.thumb, f.thumb) < 6)) continue;
    kept.push(f);
    if (kept.length === max) break;
  }
  return kept.map((f) => f.buf);
}

/**
 * Runs in the page on the throttled pass: each animation frame waits `gap` ms first, so a game whose frames hog the
 * main thread (heavy WebGL on software rendering) leaves idle time for the screenshot. Self-contained: it is
 * serialized into an init script.
 */
export function throttleFrames(win, gap) {
  const raf = win.requestAnimationFrame.bind(win);
  const caf = win.cancelAnimationFrame.bind(win);
  const pending = new Map();
  let next = 0;
  win.requestAnimationFrame = (cb) => {
    const id = ++next;
    const timer = win.setTimeout(() => {
      pending.set(id, { frame: raf((t) => { pending.delete(id); cb(t); }) });
    }, gap);
    pending.set(id, { timer });
    return id;
  };
  win.cancelAnimationFrame = (id) => {
    const p = pending.get(id);
    if (!p) return;
    if (p.timer !== undefined) win.clearTimeout(p.timer);
    if (p.frame !== undefined) caf(p.frame);
    pending.delete(id);
  };
}

/**
 * Captures cover.png, shot-1.png and shot-2.png of one game into outDir.
 * @returns {Promise<{ ok: true, files: string[] } | { ok: false, reason: string, detail?: string }>}
 */
export async function captureOne(url, outDir, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const files = NAMES.map((n) => join(outDir, `${n}.png`));
  const cleanup = () => {
    for (const f of files) rmSync(f, { force: true });
    try {
      rmdirSync(outDir); // only if empty
    } catch {}
  };
  cleanup();
  if (!checkUrl(url, o)) return { ok: false, reason: 'bad-url' };

  // Everything below races against `failed`, which the deadline, a download or a crash can reject at any time.
  let fail;
  const failed = new Promise((_, reject) => (fail = (reason, detail) => reject(new CaptureError(reason, detail))));
  failed.catch(() => {});
  let over = false;
  const guard = (p) => {
    if (over) return Promise.reject(new CaptureError('deadline'));
    return Promise.race([p, failed]);
  };
  const deadline = setTimeout(() => fail('deadline', `no result after ${o.deadline} ms`), o.deadline);
  const stop = new AbortController();

  // Frames taken so far live outside `work`, so a deadline or a frozen page after the cover still keeps the cover.
  const state = { context: null, finished: false, shots: [], timedOut: false };
  const work = async () => {
    const b = await guard(
      getBrowser(o.sandbox).catch((e) => {
        throw new CaptureError('browser', firstLine(e));
      }),
    );
    const context = await b.newContext({
      acceptDownloads: false,
      viewport: o.viewport,
      deviceScaleFactor: 1,
      permissions: [],
      serviceWorkers: 'block',
      locale: 'en-US',
      timezoneId: 'UTC',
      // Some game hosts refuse "HeadlessChrome"; present the same browser without that marker.
      userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${b.version().split('.')[0]}.0.0.0 Safari/537.36`,
    });
    if (state.finished) {
      closeContext(context, o.closeTimeout).catch(() => {});
      throw new CaptureError('deadline');
    }
    state.context = context;
    if (o.throttle) await guard(context.addInitScript(`(${throttleFrames})(window, ${Number(o.throttleGap) || 250});`));
    const page = await guard(context.newPage());
    context.on('page', (p) => p !== page && p.close().catch(() => {})); // popups
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('download', (d) => {
      d.cancel().catch(() => {});
      fail('download');
    });
    page.on('crash', () => fail('crash'));

    const navStart = Date.now();
    let res;
    try {
      res = await guard(page.goto(url, { waitUntil: 'domcontentloaded', timeout: o.navTimeout }));
    } catch (e) {
      if (e instanceof CaptureError) throw e;
      throw new CaptureError(/download is starting/i.test(e.message) ? 'download' : 'navigation', firstLine(e));
    }
    if (res && res.status() >= 400) throw new CaptureError('http-status', String(res.status()));
    // Wait for `load` within what is left of the navigation budget; slow subresources don't fail the game.
    await guard(page.waitForLoadState('load', { timeout: Math.max(1, o.navTimeout - (Date.now() - navStart)) }).catch(() => {}));

    const t0 = Date.now();
    const shots = state.shots;
    for (let i = 0; i < o.times.length; i++) {
      await guard(sleep(t0 + o.times[i] - Date.now(), stop.signal));
      // A busy renderer can miss one frame deadline; one retry before giving up on the game.
      let shot;
      for (let attempt = 0; attempt < 2 && !shot; attempt++) {
        try {
          shot = await guard(page.screenshot({ type: 'png', timeout: o.shotTimeout }));
        } catch (e) {
          if (e instanceof CaptureError || attempt === 1) {
            if (i > 0) { state.timedOut = true; return shots; } // earlier frames may be enough; later ones are a bonus
            throw e instanceof CaptureError ? e : new CaptureError('screenshot', firstLine(e));
          }
        }
      }
      shots.push(shot);
      if (i === 0) {
        // One click in the centre starts games that wait for input…
        await guard(within(page.mouse.click(o.viewport.width / 2, o.viewport.height / 2), o.clickTimeout));
      } else if (i === 1) {
        // …and Enter gets past "press any key" menus.
        await guard(within(page.keyboard.press('Enter'), o.clickTimeout));
      }
    }
    return shots;
  };

  let result;
  try {
    const running = work();
    running.catch(() => {});
    const shots = await guard(running);
    // The best frames only: a loading screen or a black canvas never becomes a cover.
    const picked = await pickFrames(shots);
    // Only black frames before a screenshot timeout: the game is slow, not blank, so the throttled pass gets a turn.
    if (!picked.length) throw state.timedOut ? new CaptureError('screenshot', 'frames timed out after a blank start') : new CaptureError('blank', 'every frame was black, blank or a loading screen');
    mkdirSync(outDir, { recursive: true });
    picked.forEach((buf, i) => writeFileSync(files[i], buf));
    result = { ok: true, files: files.slice(0, picked.length), ...(picked.length < files.length ? { partial: true } : {}) };
  } catch (e) {
    cleanup();
    const froze = e instanceof CaptureError && (e.reason === 'deadline' || e.reason === 'screenshot');
    const keep = froze && state.shots.length ? await pickFrames(state.shots.slice()) : [];
    if (keep.length) {
      // The game froze or ran out of time after some good frames: keep those.
      mkdirSync(outDir, { recursive: true });
      keep.forEach((buf, i) => writeFileSync(files[i], buf));
      result = { ok: true, files: files.slice(0, keep.length), partial: true };
    } else {
      result = e instanceof CaptureError ? { ok: false, reason: e.reason, detail: e.message } : { ok: false, reason: 'error', detail: firstLine(e) };
    }
  } finally {
    over = true;
    state.finished = true;
    clearTimeout(deadline);
    stop.abort();
    await closeContext(state.context, o.closeTimeout);
  }
  return result;
}

function firstLine(e) {
  return String(e?.message ?? e).split('\n')[0].slice(0, 300);
}

function readEntry(root, slug) {
  const file = join(root, 'games', `${slug}.yaml`);
  if (!existsSync(file)) return null;
  try {
    return parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function appendFailure(outRoot, failure) {
  const file = join(outRoot, 'failed.json');
  let list = [];
  try {
    const prev = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(prev)) list = prev;
  } catch {}
  list.push(failure);
  writeFileSync(file, JSON.stringify(list, null, 2) + '\n');
}

/** Splits slugs into games to capture and games whose creator sent screenshots (each entry read as data). */
export function splitUploads(slugs, { root = ROOT } = {}) {
  const res = { capture: [], uploads: [] };
  for (const slug of slugs) (SLUG.test(slug) && uploadsOf(readEntry(root, slug)) ? res.uploads : res.capture).push(slug);
  return res;
}

/**
 * Captures each slug's play.url into <out>/<slug>/, logging failures to <out>/failed.json. Never stops early.
 * A game whose creator sent screenshots is skipped: no browser, no files, no failure.
 */
export async function captureSlugs(slugs, { root = ROOT, out = join(root, 'out'), log = console.log, budgetMs = 75 * 60_000, ...opts } = {}) {
  mkdirSync(out, { recursive: true });
  const results = [];
  // Throttled retries stop once the batch has used its budget, so the job always ends in time to upload.
  const batchStart = Date.now();
  for (const slug of slugs) {
    const started = Date.now();
    let res;
    if (!SLUG.test(slug)) res = { ok: false, reason: 'invalid-slug' };
    else {
      const entry = readEntry(root, slug);
      const url = entry?.play?.url;
      if (!entry) res = { ok: false, reason: 'no-entry' };
      else if (uploadsOf(entry)) res = { ok: true, skipped: 'uploads' };
      else if (typeof url !== 'string') res = { ok: false, reason: 'bad-url' };
      else {
        const run = (o) => captureOne(url, join(out, slug), o).catch((e) => ({ ok: false, reason: 'error', detail: firstLine(e) }));
        res = await run(opts);
        // Screenshots that time out usually mean frames hog the main thread; one more pass with throttled frames.
        if (!res.ok && (res.reason === 'screenshot' || res.reason === 'deadline') && !opts.throttle && Date.now() - batchStart < budgetMs) {
          log(`     ${slug}: ${res.reason}, retry throttled`);
          const again = await run({ ...opts, throttle: true });
          if (again.ok) res = { ...again, throttled: true };
        }
      }
    }
    const name = SLUG.test(slug) ? slug : '(invalid)';
    if (!res.ok) appendFailure(out, { slug: name, reason: res.reason, ...(res.detail ? { detail: res.detail } : {}) });
    if (res.skipped) log(`skip ${name}: the creator sent screenshots`);
    else log(`${res.ok ? 'ok  ' : 'FAIL'} ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)${res.ok ? '' : `: ${res.reason}`}`);
    results.push({ slug: name, ...res });
  }
  return results;
}

/**
 * Extra seconds before the first frame, for games that load for longer than the default schedule on CI's software
 * renderer (a title screen with a progress bar is not a cover). 0 to 90; anything else is no change.
 */
export function waitOptions(seconds) {
  const s = Math.min(90, Math.max(0, Math.floor(Number(seconds))));
  if (!s) return {};
  return { times: DEFAULTS.times.map((t) => t + s * 1000), deadline: DEFAULTS.deadline + s * 1000 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--split') {
    if (process.argv.length !== 4) {
      console.error('usage: node scripts/capture.mjs --split <file with one slug per line>');
      process.exit(2);
    }
    console.log(JSON.stringify(splitUploads(readFileSync(process.argv[3], 'utf8').split(/\s+/).filter(Boolean))));
    process.exit(0);
  }
  const slugs = process.argv.slice(2);
  if (!slugs.length) {
    console.error('usage: node scripts/capture.mjs <slug…>');
    process.exit(2);
  }
  const results = await captureSlugs(slugs, waitOptions(process.env.CAPTURE_WAIT));
  await closeBrowser();
  console.log(`captured ${results.filter((r) => r.ok && !r.skipped).length} of ${results.length}`);
  // Failed games are expected and logged; a browser that never starts is a broken runner.
  process.exit(results.some((r) => r.reason === 'browser') && !results.some((r) => r.ok && !r.skipped) ? 1 : 0);
}
