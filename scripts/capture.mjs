#!/usr/bin/env node
// Captures a cover and two screenshots per game: node scripts/capture.mjs <slug…>
// Game pages are untrusted code. This runs only in CI's capture job, which has no secrets and a read-only token.
// Every game gets a fresh browser context, a hard deadline kept by Node (not by Playwright), and nothing
// from the page is ever read back except the pixels of the screenshots, and on itch.io the address of the game's
// own frame, which must match itch's CDN pattern (itchFrame). The opt-in start step (CAPTURE_START, startGame) also
// asks the page whether a Start or Play button or a name field is visible; those answers only decide a click and
// are never saved or logged.
// Games whose creator sent screenshots with the submission (provenance.uploads) are never captured; the upload job
// fetches those instead. node scripts/capture.mjs --split <slug-list file> prints { capture, uploads } for the workflow.
import { mkdirSync, mkdtempSync, rmSync, rmdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
  // The start step (opt-in, `start: true`): one frame at times[0], then startGame, then these frames (ms after the
  // start step) with a little play input between them. The deadline grows by startExtra.
  start: false,
  startTimes: [1500, 4000, 7000, 10500, 14000],
  startExtra: 25_000,
  holdMs: 700, // how long a movement key is held between frames
  startRounds: 3, // menus behind menus: Play, then a mode, then a character
  startPause: 1200, // after each start click, for the next screen to appear
  startBudget: 15_000, // the whole start step
  navTimeout: 20_000,
  deadline: 70_000, // per game, from start to files on disk
  shotTimeout: 15_000, // WebGL games render in software on CI runners (no GPU), so frames can be slow
  clickTimeout: 2000,
  closeTimeout: 5000,
  viewport: { width: 1280, height: 720 },
  allowLocalHttp: false, // tests only: http://127.0.0.1
  itchHost: /\.itch\.io$/, // pages captured the itch.io way (tests point it at 127.0.0.1)
  itchPage: false, // on itch.io: capture the page itself, toolbar hidden, instead of the game's own frame
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

// itch.io wraps an HTML5 game in its own page: a toolbar ("Follow", "Add To Collection"), jam banners and often a
// "Run game" button would end up in the cover. The game itself is an iframe served from itch's CDN.
const ITCH_FRAME = /^https:\/\/html(?:-classic)?\.itch\.zone(\/html\/\d+(?:-\d+)?\/)(?:[\w%-]+\/)*[\w%.-]+\.html(?:\?v=\d+)?$/;

/** The game's own frame on an itch.io page (pageUrl on *.itch.io), or null. candidate is its src, read as data. */
export function itchFrame(pageUrl, candidate) {
  let host;
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    return null;
  }
  if (!host.endsWith('.itch.io') || typeof candidate !== 'string') return null;
  const src = candidate.replace(/ /g, '%20');
  const match = ITCH_FRAME.exec(src);
  if (!match || src.includes('..')) return null;
  try {
    const u = new URL(src);
    if (u.protocol === 'https:' && ['html.itch.zone', 'html-classic.itch.zone'].includes(u.host) && !u.username && !u.password && u.pathname.startsWith(match[1])) return u.href;
  } catch {}
  return null;
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
 * The first `preferred` frames (the start step's frames after the menu) rank before the rest, whatever their detail:
 * a busy menu full of text would otherwise win the cover over the game behind it.
 */
export async function pickFrames(frames, { max = 3, preferred = frames.length } = {}) {
  const info = await Promise.all(
    frames.map(async (buf, i) => {
      const stats = await sharp(buf).stats();
      const rgb = stats.channels.slice(0, 3);
      const mean = rgb.reduce((s, c) => s + c.mean, 0) / rgb.length;
      const sd = rgb.reduce((s, c) => s + c.stdev, 0) / rgb.length;
      const thumb = await sharp(buf).resize(32, 18, { fit: 'fill' }).greyscale().raw().toBuffer();
      return { buf, mean, sd, entropy: stats.entropy, thumb, tier: i < preferred ? 0 : 1 };
    }),
  );
  const order = (a, b) => a.tier - b.tier || b.entropy - a.entropy;
  let usable = info.filter((f) => f.mean >= 18 && f.mean <= 245 && f.sd >= 12 && f.entropy >= 3).sort(order);
  // Dark games: when no frame passes, one dark title screen with real content (a logo or a menu, not a spinner on
  // black) still beats no cover.
  if (!usable.length) usable = info.filter((f) => f.mean <= 250 && f.sd >= 8 && f.entropy >= 1.5).sort(order).slice(0, 1);
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

// The start step. Most games that kept a single frame sat on a title, menu or name-entry screen: the centre click and
// Enter of the plain schedule don't press a Play button off-centre, so every frame was the same menu and the
// near-duplicate check kept one. With `start: true` the capture presses the game's own Start or Play button, found by
// its accessible name or its whole visible text, types a placeholder name into a name field, and plays a little
// (movement keys, a click) between frames. Nothing the page says is saved or logged: the page is only asked whether
// such an element is visible, and links are never followed (they can lead off the game).
const phrase = (words) => new RegExp(`^[\\W_]*(?:${words.join('|')})[\\W_]*$`, 'i');
/** Buttons that start a game, matched against the whole name or text (arrows and punctuation around it ignored). */
export const START_NAMES = phrase([
  'play', 'start', 'play now', 'play game', 'play the game', 'start game', 'start the game', 'new game', 'start run', 'new run',
  'begin', 'begin game', 'begin run', 'begin adventure', 'begin journey', 'launch', 'launch game', 'launch mission', 'quick ?play',
  'single ?player', 'solo', 'play solo', 'play offline', 'play as guest', 'play (?:vs|against) (?:cpu|ai|computer|bots?)', 'vs (?:cpu|ai)',
  "let[\\u2019']?s (?:go|play)", '(?:click|tap|press) (?:here |anywhere )?to (?:start|play|begin)', 'press start', 'start (?:adventure|mission|playing|now|demo)',
  'enter (?:the )?game', 'run game', 'dive in', 'drop in', 'jump in', 'insert coin',
]);
/** Second-screen buttons (after a name or a mode): pressed only when no start button is visible. */
export const NEXT_NAMES = phrase(['continue', 'join', 'join game', 'enter', 'go', 'fight', 'ok', 'okay', 'got it', 'skip', 'skip intro', 'next', 'ready', "i[\\u2019']?m ready", 'deploy', 'embark']);
/** A name field: its label or placeholder asks for a name. */
export const NAME_FIELD = /\bnick(?:name)?\b|\b(?:user ?)?name\b|\bcall ?sign\b|who are you/i;
export const PLAYER_NAME = 'Player';

/** Between post-start frames: hold movement keys (arrows and WASD), jump or shoot, and move the mouse. */
const PLAY_STEPS = [
  { keys: ['ArrowRight', 'KeyD'] },
  { keys: ['ArrowUp', 'KeyW'], press: 'Space' },
  { keys: ['ArrowLeft', 'KeyA'], click: [0.62, 0.42] },
  { keys: ['ArrowDown', 'KeyS'], press: 'Space' },
];

/**
 * Clicks the first visible element whose accessible name (buttons) or whole text (anything that isn't a link) matches
 * `names`. Returns true after a click. Every call is bounded by `o.clickTimeout`, the whole search by `until` (a time);
 * `guard` keeps the capture deadline.
 */
async function clickByName(page, names, o, guard, until) {
  const tries = [page.getByRole('button', { name: names }), page.getByText(names)];
  for (const [i, all] of tries.entries()) {
    if (Date.now() > until) return false;
    const loc = all.filter({ visible: true });
    const n = Math.min(await guard(within(loc.count(), o.clickTimeout, 0)), 3);
    for (let k = 0; k < n && Date.now() <= until; k++) {
      const el = loc.nth(k);
      // Text matches can sit inside a link; a link to another page is never clicked (a "#" or script link is a button).
      if (i === 1 && !(await guard(within(el.evaluate((e) => !e.closest('a[href]:not([href^="#"]):not([href^="javascript:"])')), o.clickTimeout, false)))) continue;
      if (await guard(within(el.click({ timeout: o.clickTimeout }).then(() => true), o.clickTimeout + 500, false))) return true;
    }
  }
  return false;
}

/**
 * Gets past a title, menu or name-entry screen: fills a visible name field once, then presses a start button (or, when
 * none is visible, a continue/join button), up to `o.startRounds` times within `o.startBudget` ms. A canvas title
 * screen gets the centre click and Enter of the plain schedule instead, after which a DOM menu may appear. Never throws
 * except for the deadline.
 */
export async function startGame(page, o, guard, signal) {
  const until = Date.now() + o.startBudget;
  const pause = (ms) => guard(sleep(ms, signal));
  const centre = async () => {
    await guard(within(page.mouse.click(o.viewport.width / 2, o.viewport.height / 2), o.clickTimeout));
    await guard(within(page.keyboard.press('Enter'), o.clickTimeout));
  };
  let named = false;
  let canvasTried = false;
  for (let round = 0; round < o.startRounds && Date.now() <= until; round++) {
    if (!named) {
      const field = page.getByRole('textbox', { name: NAME_FIELD }).or(page.getByPlaceholder(NAME_FIELD)).and(page.locator('input:not([type="email"]):not([type="search"])')).filter({ visible: true }).first();
      if (await guard(within(field.count(), o.clickTimeout, 0))) {
        named = await guard(within(field.fill(PLAYER_NAME, { timeout: o.clickTimeout }).then(() => true), o.clickTimeout + 500, false));
      }
    }
    if ((await clickByName(page, START_NAMES, o, guard, until)) || (await clickByName(page, NEXT_NAMES, o, guard, until))) {
      await pause(o.startPause);
      continue;
    }
    if (named && round === 0) {
      // A name field whose form submits on Enter.
      await guard(within(page.keyboard.press('Enter'), o.clickTimeout));
      await pause(o.startPause);
      continue;
    }
    if (canvasTried) break;
    canvasTried = true;
    await centre();
    await pause(o.startPause);
  }
  // Focus the game for the play input that follows.
  if (!canvasTried) await guard(within(page.mouse.click(o.viewport.width / 2, o.viewport.height / 2), o.clickTimeout));
}

/** Play input between post-start frames: step i of PLAY_STEPS. */
async function playInput(page, i, o, guard, signal) {
  const step = PLAY_STEPS[i % PLAY_STEPS.length];
  const { width, height } = o.viewport;
  if (step.click) {
    await guard(within(page.mouse.move(width * step.click[0], height * step.click[1], { steps: 4 }), o.clickTimeout));
    await guard(within(page.mouse.click(width * step.click[0], height * step.click[1]), o.clickTimeout));
  }
  for (const k of step.keys) await guard(within(page.keyboard.down(k), o.clickTimeout));
  await guard(sleep(o.holdMs, signal));
  for (const k of step.keys) await guard(within(page.keyboard.up(k), o.clickTimeout));
  if (step.press) await guard(within(page.keyboard.press(step.press), o.clickTimeout));
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
  const start = o.start === true;
  const limit = o.deadline + (start ? o.startExtra : 0);
  const deadline = setTimeout(() => fail('deadline', `no result after ${limit} ms`), limit);
  const stop = new AbortController();

  // Frames taken so far live outside `work`, so a deadline or a frozen page after the cover still keeps the cover.
  // With the start step, `before` holds the frame taken before it (the menu), used only when nothing after it is.
  const state = { context: null, finished: false, shots: [], before: [], timedOut: false };
  const pick = () => pickFrames([...state.shots, ...state.before], { preferred: state.shots.length });
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

    const open = async (target) => {
      const navStart = Date.now();
      let res;
      try {
        res = await guard(page.goto(target, { waitUntil: 'domcontentloaded', timeout: o.navTimeout }));
      } catch (e) {
        if (e instanceof CaptureError) throw e;
        throw new CaptureError(/download is starting/i.test(e.message) ? 'download' : 'navigation', firstLine(e));
      }
      if (res && res.status() >= 400) throw new CaptureError('http-status', String(res.status()));
      // Wait for `load` within what is left of the navigation budget; slow subresources don't fail the game.
      await guard(page.waitForLoadState('load', { timeout: Math.max(1, o.navTimeout - (Date.now() - navStart)) }).catch(() => {}));
    };
    await open(url);
    // On itch.io the cover shows the game's own frame, not the page around it. Only its src is read back.
    // A game that fails in its frame gets a second pass on the page itself (itchPage), with itch's toolbar hidden.
    if (o.itchHost.test(new URL(url).hostname)) {
      if (o.itchPage) {
        await guard(page.evaluate(() => document.getElementById('user_tools')?.style.setProperty('display', 'none', 'important'))).catch((e) => {
          if (e instanceof CaptureError) throw e;
        });
      } else {
        // A frame address is short; anything longer than 2 kB is not one and is never transferred whole.
        const candidate = await guard(page.evaluate(() => {
          const short = (s) => (typeof s === 'string' ? s.slice(0, 2048) : null);
          const frame = document.querySelector('iframe#game_drop');
          if (frame) return short(frame.getAttribute('src'));
          const markup = document.querySelector('.iframe_placeholder')?.getAttribute('data-iframe');
          if (!markup) return null;
          const template = document.createElement('template');
          template.innerHTML = markup.slice(0, 8192);
          return short(template.content.querySelector('iframe')?.getAttribute('src') ?? null);
        })).catch((e) => {
          if (e instanceof CaptureError) throw e;
          return null;
        });
        const frame = itchFrame(url, candidate);
        if (frame) await open(frame);
      }
    }

    // One frame. A busy renderer can miss one frame deadline; one retry before giving up on the game. Null when the
    // game stopped answering after earlier frames (those may be enough; later ones are a bonus).
    const snap = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await guard(page.screenshot({ type: 'png', timeout: o.shotTimeout }));
        } catch (e) {
          if (e instanceof CaptureError || attempt === 1) {
            if (state.shots.length || state.before.length) {
              state.timedOut = true;
              return null;
            }
            throw e instanceof CaptureError ? e : new CaptureError('screenshot', firstLine(e));
          }
        }
      }
    };

    const t0 = Date.now();
    if (start) {
      await guard(sleep(t0 + o.times[0] - Date.now(), stop.signal));
      state.before.push(await snap());
      await startGame(page, o, guard, stop.signal);
      const t1 = Date.now();
      for (let i = 0; i < o.startTimes.length; i++) {
        await guard(sleep(t1 + o.startTimes[i] - Date.now(), stop.signal));
        const shot = await snap();
        if (!shot) return;
        state.shots.push(shot);
        if (i < o.startTimes.length - 1) await playInput(page, i, o, guard, stop.signal);
      }
      return;
    }
    for (let i = 0; i < o.times.length; i++) {
      await guard(sleep(t0 + o.times[i] - Date.now(), stop.signal));
      const shot = await snap();
      if (!shot) return;
      state.shots.push(shot);
      if (i === 0) {
        // One click in the centre starts games that wait for input…
        await guard(within(page.mouse.click(o.viewport.width / 2, o.viewport.height / 2), o.clickTimeout));
      } else if (i === 1) {
        // …and Enter gets past "press any key" menus.
        await guard(within(page.keyboard.press('Enter'), o.clickTimeout));
      }
    }
  };

  let result;
  try {
    const running = work();
    running.catch(() => {});
    await guard(running);
    // The best frames only: a loading screen or a black canvas never becomes a cover.
    const picked = await pick();
    // Only black frames before a screenshot timeout: the game is slow, not blank, so the throttled pass gets a turn.
    if (!picked.length) throw state.timedOut ? new CaptureError('screenshot', 'frames timed out after a blank start') : new CaptureError('blank', 'every frame was black, blank or a loading screen');
    mkdirSync(outDir, { recursive: true });
    picked.forEach((buf, i) => writeFileSync(files[i], buf));
    result = { ok: true, files: files.slice(0, picked.length), ...(picked.length < files.length ? { partial: true } : {}) };
  } catch (e) {
    cleanup();
    const froze = e instanceof CaptureError && (e.reason === 'deadline' || e.reason === 'screenshot');
    const keep = froze && (state.shots.length || state.before.length) ? await pick() : [];
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

function onItch(url, opts) {
  try {
    return (opts.itchHost ?? DEFAULTS.itchHost).test(new URL(url).hostname);
  } catch {
    return false;
  }
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
        // Heavy WebGL games on itch.io can stay blank outside itch's page: one more pass on the page, toolbar hidden.
        if (!res.ok && res.reason !== 'bad-url' && onItch(url, opts) && !opts.itchPage && Date.now() - batchStart < budgetMs) {
          log(`     ${slug}: ${res.reason}, retry on the itch page`);
          const again = await run({ ...opts, itchPage: true });
          if (again.ok) res = { ...again, itchPage: true };
        }
        // start: 'retry'. A game that kept fewer than three frames (usually a menu that never changed) or only blank
        // ones gets one more pass with the start step, in a scratch folder; the pass that kept more frames wins.
        const kept = res.ok ? res.files.length : 0;
        if (opts.start === 'retry' && (res.ok ? kept < NAMES.length : res.reason === 'blank') && Date.now() - batchStart < budgetMs) {
          log(`     ${slug}: ${res.ok ? `${kept} of ${NAMES.length} frames` : res.reason}, retry with the start step`);
          const scratch = mkdtempSync(join(tmpdir(), 'capture-start-'));
          const again = await captureOne(url, join(scratch, slug), { ...opts, start: true, ...(res.throttled ? { throttle: true } : {}), ...(res.itchPage ? { itchPage: true } : {}) }).catch((e) => ({ ok: false, reason: 'error', detail: firstLine(e) }));
          if (again.ok && again.files.length > kept) {
            for (const n of NAMES) rmSync(join(out, slug, `${n}.png`), { force: true });
            mkdirSync(join(out, slug), { recursive: true });
            const files = again.files.map((f) => {
              const to = join(out, slug, basename(f));
              copyFileSync(f, to);
              return to;
            });
            res = { ...again, files, started: true };
          }
          rmSync(scratch, { recursive: true, force: true });
        }
      }
    }
    const name = SLUG.test(slug) ? slug : '(invalid)';
    if (!res.ok) appendFailure(out, { slug: name, reason: res.reason, ...(res.detail ? { detail: res.detail } : {}) });
    if (res.skipped) log(`skip ${name}: the creator sent screenshots`);
    else log(`${res.ok ? 'ok  ' : 'FAIL'} ${name} (${((Date.now() - started) / 1000).toFixed(1)} s${res.ok ? `, ${res.files.length} of ${NAMES.length} frames` : ''})${res.ok ? '' : `: ${res.reason}`}`);
    results.push({ slug: name, ...res });
  }
  return results;
}

/**
 * CAPTURE_START: 'true' runs the start step for every game; 'retry' only for games whose plain capture kept fewer than
 * three frames or only blank ones. Anything else: off.
 */
export function startOptions(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes'].includes(v)) return { start: true };
  if (v === 'retry') return { start: 'retry' };
  return {};
}

/** The run's closing lines: counts, and a GitHub warning naming every game captured with fewer than three frames. */
export function summary(results) {
  const captured = results.filter((r) => r.ok && !r.skipped);
  const short = captured.filter((r) => r.files.length < NAMES.length);
  const lines = [`captured ${captured.length} of ${results.length}, ${captured.length - short.length} with all ${NAMES.length} frames`];
  // Partial captures go live without screenshots; the run page must say so (a short capture is not a failure).
  if (short.length) lines.push(`::warning title=Fewer than ${NAMES.length} frames::${short.length} games: ${short.map((r) => `${r.slug} (${r.files.length})`).join(', ')}`);
  return lines;
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
  const results = await captureSlugs(slugs, { ...waitOptions(process.env.CAPTURE_WAIT), ...startOptions(process.env.CAPTURE_START) });
  await closeBrowser();
  for (const line of summary(results)) console.log(line);
  // Failed games are expected and logged; a browser that never starts is a broken runner.
  process.exit(results.some((r) => r.reason === 'browser') && !results.some((r) => r.ok && !r.skipped) ? 1 : 0);
}
