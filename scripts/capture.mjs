#!/usr/bin/env node
// Captures a cover and two screenshots per game: node scripts/capture.mjs <slug…>
// Game pages are untrusted code. This runs in CI's capture job, which has no secrets and a read-only token, and, for
// games CI's software renderer can't draw, on a maintainer's machine with a GPU (`--gpu` or `--chrome`: a fresh
// temporary profile, Chrome's GPU blocklist kept, downloads refused, no file pickers, no clipboard writes, nothing
// uploaded from here).
// Every game gets a fresh browser context, a hard deadline kept by Node (not by Playwright), a page that can never lock
// the pointer, go fullscreen or lock the keyboard (noLocks, in every mode), and nothing
// from the page is read back except screenshot pixels, bounded engine hints, and on itch.io the address of the game's
// own frame, which must match itch's CDN pattern (itchFrame). The opt-in start step (CAPTURE_START, startGame) also
// asks the page whether a Start or Play button or a name field is visible, and before every click or key whether its
// target is a link or a control that isn't the game's (pressCheck); those answers only decide a press and are never
// saved or logged. After every screenshot the capture asks whether an ad frame was in view (adInView: frame addresses
// and names matched against fixed lists, a box and a visible yes or no); the answer only drops that frame.
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
import { ENGINE_GLOBALS, ENGINE_PRIORITY, RENDERERS, installEngineProbe, detectPageEngine } from './engine.mjs';

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
  startRounds: 4, // presses: menus behind menus (Solo, then Play, then a mode, then a character)
  startIdle: 2, // after a press, rounds that look for the next screen's button before the frames begin
  startPause: 1200, // after each start click, for the next screen to appear
  startBudget: 15_000, // the whole start step
  navTimeout: 20_000,
  deadline: 70_000, // per game, from start to files on disk
  shotTimeout: 15_000, // WebGL games render in software on CI runners (no GPU), so frames can be slow
  clickTimeout: 2000,
  // The yes or no asked before every press (pressCheck) gets its own, longer budget: a busy page answers late, and a
  // late yes still ends in the press. No answer in time is no press.
  checkTimeout: 5000,
  closeTimeout: 5000,
  viewport: { width: 1280, height: 720 },
  allowLocalHttp: false, // tests only: http://127.0.0.1
  itchHost: /\.itch\.io$/, // pages captured the itch.io way (tests point it at 127.0.0.1)
  itchPage: false, // on itch.io: capture the page itself, toolbar hidden, instead of the game's own frame
  sandbox: process.env.CAPTURE_SANDBOX !== '0',
  // Local captures on a machine with a GPU (`--gpu`): full Chromium in its new headless mode draws WebGL and WebGPU on
  // the real GPU, for games CI's software renderer leaves blank. `headed: true` shows the window instead.
  gpu: false,
  headed: false,
  // Local only (`--webgl`): the page sees no WebGPU, so a game whose WebGPU path draws nothing on this machine falls
  // back to its WebGL renderer, as it does on CI.
  webgl: false,
  chrome: false, // local only (`--chrome`): the installed Google Chrome instead of Playwright's Chromium
  // Local only (`--rooms`): the start step may join a room from a list with player counts. A public room can hold
  // strangers whose names and chat would end up in the cover, so CI never does this.
  rooms: false,
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
let launchedAs = null;

/**
 * Launch options: CI's software renderer, or (gpu/headed/chrome, local only) a full browser on the machine's GPU:
 * Playwright's Chromium, or the installed Google Chrome (`chrome`), whose WebGPU draws some games that Chromium leaves
 * half blank. Both start from a fresh temporary profile. A local browser keeps Chrome's GPU blocklist: untrusted WebGL
 * and WebGPU never run on a driver Chrome has blocked.
 */
export function launchOptions({ sandbox = DEFAULTS.sandbox, gpu = false, headed = false, chrome = false } = {}) {
  if (gpu || headed || chrome) return { headless: !headed, channel: chrome ? 'chrome' : 'chromium', chromiumSandbox: sandbox, args: [] };
  // Runners have no GPU: let WebGL fall back to SwiftShader instead of failing, so 3D games still draw a frame.
  return { headless: true, chromiumSandbox: sandbox, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };
}

async function getBrowser(o) {
  const opts = launchOptions(o);
  const key = JSON.stringify(opts);
  if (browser?.isConnected() && launchedAs === key) return browser;
  await killBrowser();
  server = await chromium.launchServer(opts);
  browser = await chromium.connect(server.wsEndpoint());
  launchedAs = key;
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

// Frame detail, measured the same way on every picture at one size (320×180), so a 1280 px capture and a live 320 px
// cover compare. A block of 20×20 px has detail when its grey levels spread by 6 or more (one standard deviation).
const SCORE_W = 320;
const SCORE_H = 180;
const BLOCK = 20;
const BLOCK_SD = 6;
const unit = (v) => Math.max(0, Math.min(1, v));

/**
 * How much a frame shows, 0 to 100. Mostly `coverage`, the share of the frame with detail in it: a level full of things
 * has detail everywhere, while a title card, a menu box or a lone sprite on a flat background has it in a part. Then
 * the spread of grey levels (`entropy`, bits), how much structure there is (`edges`, the mean grey step between
 * neighbouring pixels) and colour (`colour`, Hasler and Süsstrunk's colourfulness). Pixels only; nothing else is read.
 */
export async function frameScore(buf) {
  const { data, info } = await sharp(buf).resize(SCORE_W, SCORE_H, { fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  const n = w * h;
  const grey = new Uint8Array(n);
  const hist = new Uint32Array(256);
  let mrg = 0;
  let myb = 0;
  let qrg = 0;
  let qyb = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i * ch];
    const g = data[i * ch + 1];
    const b = data[i * ch + 2];
    const v = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    grey[i] = v;
    hist[v]++;
    const rg = r - g;
    const yb = (r + g) / 2 - b;
    mrg += rg;
    myb += yb;
    qrg += rg * rg;
    qyb += yb * yb;
  }
  mrg /= n;
  myb /= n;
  const colour = Math.sqrt(Math.max(0, qrg / n - mrg * mrg) + Math.max(0, qyb / n - myb * myb)) + 0.3 * Math.hypot(mrg, myb);
  let entropy = 0;
  for (const c of hist) if (c) entropy -= (c / n) * Math.log2(c / n);
  let steps = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x + 1 < w) steps += Math.abs(grey[i + 1] - grey[i]);
      if (y + 1 < h) steps += Math.abs(grey[i + w] - grey[i]);
    }
  }
  const edges = steps / n;
  let blocks = 0;
  let detailed = 0;
  for (let by = 0; by + BLOCK <= h; by += BLOCK) {
    for (let bx = 0; bx + BLOCK <= w; bx += BLOCK) {
      let s = 0;
      let q = 0;
      for (let y = by; y < by + BLOCK; y++) {
        for (let x = bx; x < bx + BLOCK; x++) {
          const v = grey[y * w + x];
          s += v;
          q += v * v;
        }
      }
      const m = s / (BLOCK * BLOCK);
      blocks++;
      if (q / (BLOCK * BLOCK) - m * m >= BLOCK_SD * BLOCK_SD) detailed++;
    }
  }
  const coverage = detailed / blocks;
  const score = 100 * (0.45 * coverage + 0.2 * unit(entropy / 7.5) + 0.2 * unit(edges / 20) + 0.15 * unit(colour / 80));
  return { score: Math.round(score * 10) / 10, coverage: Math.round(coverage * 1000) / 1000, entropy: Math.round(entropy * 100) / 100, edges: Math.round(edges * 10) / 10, colour: Math.round(colour * 10) / 10 };
}

/** A frame with this much detail (frameScore) is never a loading screen or a blank canvas, whatever its grey levels. */
export const MIN_SCORE = 25;

/**
 * Picks the frames worth showing: drops near-black, near-white and flat frames (loading screens, blank canvases),
 * orders the rest by detail (frameScore), and skips near-duplicates. Returns up to `max` PNG buffers, best first.
 * A frame passes with enough brightness, spread and grey levels, or with a detail score of MIN_SCORE: a flat-shaded game
 * (a board, low-poly 3D, a dark map) has few grey levels but detail across the whole frame.
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
      const { score } = await frameScore(buf);
      return { buf, mean, sd, entropy: stats.entropy, score, thumb, tier: i < preferred ? 0 : 1 };
    }),
  );
  const order = (a, b) => a.tier - b.tier || b.score - a.score;
  const passes = (f) => f.mean <= 245 && f.sd >= 12 && ((f.mean >= 18 && f.entropy >= 3) || (f.mean >= 8 && f.score >= MIN_SCORE));
  let usable = info.filter(passes).sort(order);
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

/** Runs in the page (local captures): removes the File System Access pickers. Self-contained, like throttleFrames. */
export function noFilePickers(win) {
  for (const k of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
    try {
      delete win[k];
      if (k in win) Object.defineProperty(win, k, { value: undefined, configurable: false });
    } catch {}
  }
}

/**
 * Runs in the page (local captures): the page can't write to the clipboard. A real click is a user activation, and with
 * `--headed` the clipboard is the machine's own: a page could leave a command there for someone to paste later.
 * Self-contained, like throttleFrames; Playwright runs it in every frame and popup too.
 */
export function noClipboardWrites(win) {
  const refuse = () => Promise.reject(new win.DOMException('clipboard writes are off in captures', 'NotAllowedError'));
  for (const k of ['writeText', 'write']) {
    try {
      Object.defineProperty(win.Clipboard.prototype, k, { value: refuse, writable: false, configurable: false });
    } catch {}
  }
  try {
    const exec = win.Document.prototype.execCommand;
    Object.defineProperty(win.Document.prototype, 'execCommand', {
      value: function execCommand(command, ...rest) {
        return /^\s*(?:copy|cut)\s*$/i.test(String(command)) ? false : exec.call(this, command, ...rest);
      },
      writable: false,
      configurable: false,
    });
  } catch {}
}

/** Runs in the page (`webgl`): hides WebGPU, so the game picks its WebGL renderer. Self-contained. */
export function noWebGPU(win) {
  try {
    delete win.Navigator.prototype.gpu;
  } catch {}
}

/**
 * Runs in the page, in every capture (CI and local, every launch): the game can never lock or hide the pointer, go
 * fullscreen or lock the keyboard, before any of its own code runs. A local browser shares the machine's mouse and
 * keyboard, and nothing a capture opens may hold them; a screenshot never needs them. Pointer lock and keyboard lock
 * answer as if granted (a game waits on, never retries), fullscreen is refused. Fixed in place, so the page can't put
 * the browser's own functions back. Self-contained, like throttleFrames; Playwright runs it in every frame and popup.
 */
export function noLocks(win) {
  const fix = (proto, key, value) => {
    if (!proto) return;
    try {
      Object.defineProperty(proto, key, { value, writable: false, configurable: false });
    } catch {}
  };
  const refuse = function requestFullscreen() {
    return Promise.reject(new win.DOMException('fullscreen is off in captures', 'NotAllowedError'));
  };
  const element = win.Element?.prototype;
  fix(element, 'requestPointerLock', function requestPointerLock() {
    return Promise.resolve();
  });
  for (const key of ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen']) fix(element, key, refuse);
  fix(win.Document?.prototype, 'exitPointerLock', function exitPointerLock() {});
  for (const key of ['webkitEnterFullscreen', 'webkitEnterFullScreen']) fix(win.HTMLVideoElement?.prototype, key, function webkitEnterFullscreen() {});
  fix(win.Keyboard?.prototype, 'lock', function lock() {
    return Promise.resolve();
  });
}

// Ads. A cover feeds every card, the player poster and the share image, so a frame with someone's ad in view is never
// kept (one cover once showed a banner from the game's own page). Ads come in frames: a frame counts as an ad when its
// host is one of these ad servers or a subdomain of one (Google's AdSense, Ad Manager and IMA video ads, the big
// exchanges, and the networks web games use; add one when a capture shows it), or when it has the name Google's ad
// tags give their frames. Hosts that also serve games (GameDistribution, GameMonetize) are not on the list: their ads
// come through IMA.
export const AD_HOSTS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com', 'imasdk.googleapis.com', 'googletagservices.com',
  'amazon-adsystem.com', 'adnxs.com', 'rubiconproject.com', 'pubmatic.com', 'openx.net', 'criteo.com', 'criteo.net', 'casalemedia.com',
  'adform.net', 'smartadserver.com', 'yieldmo.com', 'sharethrough.com', 'teads.tv', '33across.com', 'media.net', 'sovrn.com', 'lijit.com',
  'taboola.com', 'outbrain.com', 'revcontent.com', 'mgid.com', 'adskeeper.com',
  'adinplay.com', 'cpmstar.com', 'applixir.com', 'vntsm.com', 'nitropay.com', 'pub.network', 'snigelweb.com', 'playwire.com', 'aniview.com',
  'ezoic.net', 'ezodn.com', 'adthrive.com', 'mediavine.com',
  'adsterra.com', 'propellerads.com', 'popads.net', 'a-ads.com', 'coinzilla.io', 'bitmedia.io', 'adcash.com', 'exoclick.com', 'juicyads.com',
  'hilltopads.net', 'infolinks.com', 'buysellads.com', 'carbonads.net',
];
// AdSense names its frames aswift_0, aswift_1, …; Ad Manager google_ads_iframe_<slot>. Both start out as about:blank.
const AD_FRAME_NAME = /^(?:aswift_\d|google_ads_i?frame)/i;

/** Whether a frame is an ad, from its address and name: both read as data, bounded, and matched against fixed lists. */
export function isAdFrame(url, name, hosts = AD_HOSTS) {
  if (typeof name === 'string' && AD_FRAME_NAME.test(name.slice(0, 64))) return true;
  if (typeof url !== 'string') return false;
  let host;
  try {
    const u = new URL(url.slice(0, 4096));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** How much of the viewport an ad frame must cover to count: a share of its area and a side (never a tracking pixel). */
const AD_MIN = { share: 0.01, side: 20 };

/**
 * After every screenshot: was an ad frame in view? Frames are found by address and name (isAdFrame, any depth). One
 * counts when its box overlaps the viewport by at least AD_MIN and nothing hides it (display, visibility, opacity: an
 * IMA frame waits at opacity 0 over the game until an ad plays). The page is only asked yes or no; a frame whose box or
 * visibility can't be read in time counts as in view. Never throws.
 */
export async function adInView(page, o) {
  const { width, height } = o.viewport;
  const main = page.mainFrame();
  for (const frame of page.frames()) {
    if (frame === main || frame.isDetached()) continue;
    let ad = false;
    try {
      ad = isAdFrame(frame.url(), frame.name());
    } catch {}
    if (!ad) continue;
    const el = await within(frame.frameElement(), o.clickTimeout, null);
    if (!el) {
      if (frame.isDetached()) continue;
      return true;
    }
    try {
      const box = await within(el.boundingBox(), o.clickTimeout, undefined);
      if (box === undefined) {
        if (frame.isDetached()) continue;
        return true;
      }
      if (!box) continue; // not rendered (display: none, or gone)
      const w = Math.min(box.x + box.width, width) - Math.max(box.x, 0);
      const h = Math.min(box.y + box.height, height) - Math.max(box.y, 0);
      if (w < AD_MIN.side || h < AD_MIN.side || w * h < AD_MIN.share * width * height) continue;
      const shown = await within(el.evaluate((e) => (typeof e.checkVisibility === 'function' ? e.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true)), o.clickTimeout, null);
      if (shown === false || (shown === null && frame.isDetached())) continue;
      return true;
    } finally {
      el.dispose().catch(() => {});
    }
  }
  return false;
}

// The start step. Most games that kept a single frame sat on a title, menu or name-entry screen: the centre click and
// Enter of the plain schedule don't press a Play button off-centre, so every frame was the same menu and the
// near-duplicate check kept one. With `start: true` the capture presses the game's own Start or Play button, found by
// its accessible name or its whole visible text, types a placeholder name into a name field, and plays a little
// (movement keys, a click) between frames. Nothing the page says is saved or logged: the page is only asked whether
// such an element is visible, and before every press whether it may be pressed (pressCheck): links are never followed
// (they can lead off the game), and wallet, payment, sign-in, rating and sharing controls are never pressed (DENY).
const phrase = (words) => new RegExp(`^[\\W_]*(?:${words.join('|')})[\\W_]*$`, 'i');
/**
 * Options that start a game alone on this machine (no server list, no strangers): pressed before any other start
 * button, so "Play" never opens a lobby browser when "Solo" or "Bots" sits next to it. English and German.
 */
export const SOLO_NAMES = phrase([
  'solo', 'play solo', 'solo play', 'single ?player', 'play single ?player', 'offline', 'play offline', 'offline mode',
  'practi[cs]e', 'practi[cs]e mode', 'practi[cs]e (?:run|round|match|range)', 'training', 'training mode', 'free ?play', 'sandbox',
  'play (?:vs|against|with) (?:the )?(?:cpu|ai|computer|bots?)', '(?:vs|versus) (?:cpu|ai|computer|bots?)', '(?:ffa |free for all )?bots? (?:lobby|match|game|mode)', 'add bots?',
  'einzelspieler', 'offline spielen', 'gegen (?:den )?(?:computer|bots?|ki)', '(?:ü|ue)bung', 'trainingsmodus',
]);
/** Buttons that start a game, matched against the whole name or text (arrows and punctuation around it ignored). */
export const START_NAMES = phrase([
  'play', 'start', 'play now', 'play game', 'play the game', 'start game', 'start the game', 'new game', 'start run', 'new run',
  'begin', 'begin game', 'begin run', 'begin adventure', 'begin journey', 'launch', 'launch game', 'launch mission', 'quick ?play',
  'single ?player', 'solo', 'play solo', 'play offline', 'play as guest', 'play (?:vs|against) (?:cpu|ai|computer|bots?)', 'vs (?:cpu|ai)',
  "let[\\u2019']?s (?:go|play)", '(?:click|tap|press) (?:here |anywhere )?to (?:start|play|begin)', 'press start', 'start (?:adventure|mission|playing|now|demo)',
  'enter (?:the )?(?:game|arena|world|battle|match)', 'run game', 'dive in', 'drop in', 'jump in', 'insert coin',
  // German
  'spielen', 'jetzt spielen', 'spiel starten', 'starten', 'neues spiel', 'spiel beginnen', 'beginnen', 'los', "los geht[\\u2019']?s",
  '(?:klicken|tippen|dr(?:ü|ue)cken) (?:zum|um zu) (?:starten|spielen)',
]);
/**
 * Second-screen buttons (after a name or a mode): pressed only when no start button is visible. A question in the way
 * ("Enable sound?", a newsletter) gets the declining answer: a capture never opts in to anything.
 */
export const NEXT_NAMES = phrase([
  'continue', 'join', 'join game', 'enter', 'go', 'fight', 'ok', 'okay', 'got it', 'skip', 'skip intro', 'next', 'ready', "i[\\u2019']?m ready", 'deploy', 'embark',
  'no', 'no thanks', 'not now', 'maybe later', 'mute', 'sound off', 'no sound', '(?:play )?without sound',
  'weiter', 'fortfahren', 'beitreten', 'bereit', '(?:ü|ue)berspringen', 'verstanden', 'alles klar', 'nein', 'nein danke', 'sp(?:ä|ae)ter', 'ohne ton',
]);
/**
 * A room or server in a list, shown with its player count ("Neon Corner 0/12"): the last resort, pressed once when a
 * game offers nothing to start alone and no other button, and only on a local run that asks for it (`rooms`): a
 * public room can hold strangers whose names and chat would end up in the cover. (Playwright passes the pattern inside
 * a selector string, which allows no "u" flag and no bare "/".)
 */
export const ROOM_NAMES = /^[\W_]*(?=[^\/]*[a-zÀ-ɏ])[a-zÀ-ɏ0-9][a-zÀ-ɏ0-9 '.#(-]{0,39}?\s*\d{1,3}\s*\/\s*\d{1,3}[\W_]*$/i;
/**
 * Controls the capture never presses, whatever name got them found: wallets and crypto, payments and shops, accounts
 * and sign-ins, ratings and votes, sharing, downloads and installs, bets, and anything that accepts or allows (cookies,
 * consent, terms, permissions). Checked before every click and key (pressCheck) against an element's visible text,
 * aria-label, title, alt and value, and those of the control it sits in. English and German, like the start names.
 */
export const DENY = /\b(?:wallets?|connect|buy|purchas|pay|donat|subscri|sign[\s_-]*(?:in|up|on)|log[\s_-]*(?:in|on|out)|regist|rat(?:e[sd]?|ings?)\b|vot(?:e[sd]?|ing)\b|shar(?:e[sd]?|ing)\b|download|install|shop|premium|check[\s_-]*out|carts?\b|mint|bets?\b|betting|deposit|withdraw|nft|crypto|airdrop|redeem|sponsor|patreon|ko-?fi|wishlist|google|facebook|discord|twitter|github|metamask|accept|agree|consent|cookie|allow|terms\b|privacy|gdpr|kauf|bezahl|spende|abonn|anmeld|einlogg|bewert|abstimm|teilen|herunterlad|akzeptier|zustimm|einverstanden|erlaub|datenschutz)/i;
const DENY_ARG = { deny: DENY.source, flags: DENY.flags };
/** A name field: its label or placeholder asks for a name. */
export const NAME_FIELD = /\bnick(?:name)?\b|\b(?:user ?)?name\b|\bcall ?sign\b|who are you/i;
export const PLAYER_NAME = 'Player';

/**
 * Runs in the page before every press: may the capture press this? `el` is an element found by its name; without it,
 * the element at (x, y) for a mouse click, or the focused element for a `key`. No for a link to another page, and for a
 * control whose text, aria-label, title, alt or value matches `deny` (DENY), or that sits in one. A focused element
 * that fails is blurred, so the key goes to the page instead; for Enter that includes a field whose form would submit
 * with such a button. The answer is a yes or no, never page text. Self-contained: serialized into the page.
 */
export function pressCheck(el, { deny, flags, x, y, key }) {
  const re = new RegExp(deny, flags);
  // The composed tree: through slots and out of shadow roots, so a button in a component inside a link is still in it.
  const up = (e) => e.assignedSlot || e.parentElement || (e.parentNode && e.parentNode.host) || null;
  const closest = (e, sel) => {
    for (let n = e; n; n = up(n)) if (n.nodeType === 1 && n.matches(sel)) return n;
    return null;
  };
  const LINK = 'a[href]:not([href^="#"]):not([href^="javascript:" i]), area[href]:not([href^="#"]):not([href^="javascript:" i])';
  const CONTROL = 'a, area, button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"]';
  const said = (e) => {
    const root = e.getRootNode();
    const ids = (e.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    return [
      e.getAttribute('aria-label'),
      e.getAttribute('title'),
      e.getAttribute('alt'),
      e.tagName === 'INPUT' && /^(?:submit|button|reset|image)$/i.test(e.type) ? e.value : null, // a button's label, never typed text
      ...ids.map((id) => (root.getElementById ? root.getElementById(id) : document.getElementById(id))?.textContent),
    ];
  };
  // What a control says: its text (`text`), its labels, and the labels of what is inside it (an icon's alt).
  const denied = (e, text) => {
    const all = said(e);
    if (text) {
      all.push(e.innerText ?? e.textContent);
      for (const d of [...e.querySelectorAll('[aria-label], [aria-labelledby], [title], img[alt], input')].slice(0, 30)) all.push(...said(d));
    }
    return all.some((s) => typeof s === 'string' && re.test(s.slice(0, 2000)));
  };
  // `self`: an element found by its name, whose own text counts even when it isn't a control (a div called "Play").
  const bad = (e, self) => {
    if (closest(e, LINK)) return true;
    if (self && denied(e, true)) return true;
    const control = closest(e, CONTROL);
    if (control && !(self && control === e) && denied(control, true)) return true;
    // A generic element with a click handler counts by its labels only: its text can be a whole menu.
    const handler = closest(e, '[onclick]');
    return !!handler && handler !== control && denied(handler, false);
  };
  if (el) return !bad(el, true);
  if (key) {
    let f = document.activeElement;
    try {
      for (;;) {
        if (f && f.shadowRoot && f.shadowRoot.activeElement) f = f.shadowRoot.activeElement;
        else if (f && f.tagName === 'IFRAME' && f.contentDocument) f = f.contentDocument.activeElement;
        else break;
      }
    } catch {}
    if (!f || f === f.ownerDocument.body || f === f.ownerDocument.documentElement) return true;
    let unsafe = bad(f, false);
    if (!unsafe && key === 'Enter' && f.form) {
      const submit = [...f.form.elements].find((c) => (c.tagName === 'BUTTON' && c.type === 'submit') || (c.tagName === 'INPUT' && (c.type === 'submit' || c.type === 'image')));
      unsafe = !!submit && bad(submit, true);
    }
    if (unsafe) f.blur();
    return !unsafe;
  }
  let e = document.elementFromPoint(x, y);
  while (e && e.shadowRoot) {
    const inner = e.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === e) break;
    e = inner;
  }
  return !e || !bad(e, false);
}

/**
 * Runs in the page: the button that submits a filled name field, or null. In a form, the form's default button (its
 * first submit button, the one Enter would press); outside any form, an explicit submit button in the field's own box
 * (the nearest of its four closest ancestors that holds one). Never just any button beside the field. Self-contained.
 */
export function nameSubmit(field) {
  const submits = (c) => (c.tagName === 'BUTTON' && c.type === 'submit') || (c.tagName === 'INPUT' && (c.type === 'submit' || c.type === 'image'));
  let button = null;
  if (field.form) button = [...field.form.elements].find(submits) || null;
  else {
    for (let n = field.parentElement, i = 0; n && i < 4 && !button; n = n.parentElement, i++) {
      button = [...n.querySelectorAll('button[type="submit" i], input[type="submit" i], input[type="image" i]')].find((c) => !c.form) || null;
    }
  }
  return button && !button.matches(':disabled') ? button : null;
}

/** Between post-start frames: hold movement keys (arrows and WASD), jump or shoot, and move the mouse. */
const PLAY_STEPS = [
  { keys: ['ArrowRight', 'KeyD'] },
  { keys: ['ArrowUp', 'KeyW'], press: 'Space' },
  { keys: ['ArrowLeft', 'KeyA'], click: [0.62, 0.42] },
  { keys: ['ArrowDown', 'KeyS'], press: 'Space' },
];

// A solo or start option is pressed once: the start step marks it, so a tab called "Play" or an "Offline" toggle that
// stays on screen never eats the rounds the next button (Deploy, Join) needs. Continue/OK buttons may be pressed again.
const PRESSED = 'data-capture-pressed';
const NOT_PRESSED = `:not([${PRESSED}]):not([${PRESSED}] *)`;

/**
 * The budget for pressCheck's answer before a press that starts the game (a named button, the centre click, Enter):
 * its own, never shorter than a click's. Play input between frames keeps the click budget: frames never wait for it.
 */
const checkBudget = (o) => Math.max(o.checkTimeout, o.clickTimeout);

/** A mouse click at (x, y), unless pressCheck says no (or can't answer within `budget`). True after a click. */
async function clickAt(page, x, y, o, guard, budget = checkBudget(o)) {
  const ok = await guard(within(page.evaluate(`(${pressCheck})(null, ${JSON.stringify({ ...DENY_ARG, x, y })})`), budget, false));
  if (ok) await guard(within(page.mouse.click(x, y), o.clickTimeout));
  return ok === true;
}

/** A key press (Enter, Space), after pressCheck has moved focus off a link or a control that isn't the game's. */
async function pressKey(page, key, o, guard, budget = checkBudget(o)) {
  const ok = await guard(within(page.evaluate(`(${pressCheck})(null, ${JSON.stringify({ ...DENY_ARG, key })})`), budget, null));
  // No answer (a busy or navigating page): no key either, since whatever has focus may be such a control.
  if (ok === null) return false;
  await guard(within(page.keyboard.press(key), o.clickTimeout));
  return true;
}

/**
 * Presses one element after pressCheck: a mouse click, else (`event`) the click event itself, for a button under a
 * transparent layer (a full-screen canvas or overlay that takes the pointer) or one that never stops moving. Returns
 * 'clicked', 'event' (dispatched: the page may have ignored it), 'denied' or false.
 */
async function press(el, o, guard, { event = true } = {}) {
  // No answer (the element went away, a page busy past the check's budget) is no press either.
  const allowed = await guard(within(el.evaluate(pressCheck, DENY_ARG), checkBudget(o), null));
  if (allowed !== true) return allowed === false ? 'denied' : false;
  if (await guard(within(el.click({ timeout: o.clickTimeout }).then(() => true), o.clickTimeout + 500, false))) return 'clicked';
  if (event && (await guard(within(el.dispatchEvent('click').then(() => true), o.clickTimeout, false)))) return 'event';
  return false;
}

/**
 * Presses the first visible element whose accessible name (buttons) or whole text matches `names` and that pressCheck
 * allows (never a link, never a wallet, shop or sign-in). Returns how it was pressed ('clicked' or 'event'), or false.
 * Every call is bounded by `o.clickTimeout`, the whole search by `until` (a time); `guard` keeps the capture deadline.
 * `once`: skip elements pressed before, and mark this one.
 */
async function clickByName(page, names, o, guard, until, { once = false, label = 'button', trace } = {}) {
  const tries = [page.getByRole('button', { name: names }), page.getByText(names)];
  for (const [i, all] of tries.entries()) {
    if (Date.now() > until) return false;
    const visible = all.filter({ visible: true });
    const loc = once ? visible.and(page.locator(NOT_PRESSED)) : visible;
    const n = Math.min(await guard(within(loc.count(), o.clickTimeout, 0)), 3);
    for (let k = 0; k < n && Date.now() <= until; k++) {
      // One element, held while it is pressed and marked (a locator would find whatever replaced it after the click).
      const el = await guard(within(loc.nth(k).elementHandle({ timeout: o.clickTimeout }), o.clickTimeout + 500, null));
      if (!el) continue;
      try {
        const how = await press(el, o, guard);
        const match = `${i ? 'text' : 'button role'}, match ${k + 1} of ${n}`;
        if (how === 'denied') trace?.(`skipped a ${label}: a link, or a control that isn't the game's (${match})`);
        else trace?.(`${how ? `pressed (${how === 'clicked' ? 'clicked' : 'click event'})` : 'could not press'} a ${label} (${match})`);
        if (how !== 'clicked' && how !== 'event') continue;
        // Marked after the press: a press that failed is tried again next round.
        if (once) await guard(within(el.evaluate((e, attr) => e.setAttribute(attr, ''), PRESSED), o.clickTimeout));
        return how;
      } finally {
        el.dispose().catch(() => {});
      }
    }
  }
  return false;
}

/**
 * Gets past a title, menu or name-entry screen: fills a visible name field once, then presses a solo or offline option,
 * else a start button (each once), else a continue/join button, else (local runs with `rooms` only) a room in a list,
 * up to `o.startRounds` presses within `o.startBudget` ms. A filled name with nothing to press gets Enter, then its
 * form's submit button. A canvas title screen gets the centre click and Enter of the plain schedule, after which a DOM
 * menu may appear. While nothing has been pressed the step keeps looking (a menu can appear after a long load); after a
 * press it looks `o.startIdle` more times for the next screen's button. When every press was only a click event, which
 * the page may have ignored, the centre click and Enter still follow. Never throws except for the deadline.
 */
export async function startGame(page, o, guard, signal) {
  const until = Date.now() + o.startBudget;
  const pause = (ms) => guard(sleep(ms, signal));
  const centre = async (trace) => {
    if (!(await clickAt(page, o.viewport.width / 2, o.viewport.height / 2, o, guard))) trace?.("no centre click: a link, or a control that isn't the game's");
    await pressKey(page, 'Enter', o, guard);
  };
  const nameField = () => page.getByRole('textbox', { name: NAME_FIELD }).or(page.getByPlaceholder(NAME_FIELD)).and(page.locator('input:not([type="email"]):not([type="search"])')).filter({ visible: true }).first();
  let named = false;
  let enterTried = false;
  let nameButtonTried = false;
  let canvasTried = false;
  let presses = 0;
  let clicked = false; // a press landed as a real mouse click (not just a click event)
  let idle = 0; // rounds without a press since the last one
  for (let round = 0; presses < o.startRounds && Date.now() <= until; round++) {
    // Local review only: our own decisions, never anything the page says.
    const trace = typeof o.trace === 'function' ? (s) => o.trace(`start round ${round + 1}: ${s}`) : undefined;
    if (!named) {
      const field = nameField();
      if (await guard(within(field.count(), o.clickTimeout, 0))) {
        named = await guard(within(field.fill(PLAYER_NAME, { timeout: o.clickTimeout }).then(() => true), o.clickTimeout + 500, false));
        trace?.(named ? 'filled a name field' : 'could not fill a name field');
      }
    }
    const how =
      (await clickByName(page, SOLO_NAMES, o, guard, until, { once: true, label: 'solo option', trace })) ||
      (await clickByName(page, START_NAMES, o, guard, until, { once: true, label: 'start button', trace })) ||
      (await clickByName(page, NEXT_NAMES, o, guard, until, { label: 'next button', trace })) ||
      (o.rooms === true && (await clickByName(page, ROOM_NAMES, o, guard, until, { once: true, label: 'room in a list', trace })));
    if (how) {
      presses++;
      if (how === 'clicked') clicked = true;
      idle = 0;
      await pause(o.startPause);
      continue;
    }
    if (named && !presses && !enterTried) {
      // A name field whose form submits on Enter (pressKey first moves focus off a field whose form would submit
      // with a wallet or sign-in button).
      enterTried = true;
      trace?.('Enter after the name');
      await pressKey(page, 'Enter', o, guard);
      await pause(o.startPause);
      continue;
    }
    if (named && !presses && !nameButtonTried) {
      // A name form whose submit button has a name of its own ("Open Café"): the form's default button, or outside a
      // form an explicit submit button in the field's own box (nameSubmit). Never just the button beside the field.
      nameButtonTried = true;
      const field = await guard(within(nameField().elementHandle({ timeout: o.clickTimeout }), o.clickTimeout + 500, null));
      const found = field && (await guard(within(field.evaluateHandle(nameSubmit), o.clickTimeout, null)));
      field?.dispose().catch(() => {});
      const button = found?.asElement() ?? null;
      if (found && !button) found.dispose().catch(() => {});
      let res = false;
      if (button) {
        try {
          res = await press(button, o, guard, { event: false });
        } finally {
          button.dispose().catch(() => {});
        }
      }
      trace?.(res === 'clicked' ? "pressed the name form's submit button" : res === 'denied' ? "skipped the name form's submit button: not the game's" : 'no submit button for the name');
      if (res === 'clicked') {
        presses++;
        clicked = true;
        idle = 0;
        await pause(o.startPause);
        continue;
      }
    }
    // A game already started by a button gets no Enter (in many multiplayer games it opens the chat); it gets a short
    // look for the next screen's button, then the frames.
    if (presses) {
      if (++idle > o.startIdle) break;
      trace?.('nothing new to press yet');
      await pause(o.startPause);
      continue;
    }
    if (!canvasTried) {
      canvasTried = true;
      trace?.('nothing to press: centre click and Enter');
      await centre(trace);
      await pause(o.startPause);
      continue;
    }
    // Nothing pressed yet: the menu may still be loading.
    if (round === 2) trace?.('nothing to press yet: looking again until the start budget ends');
    await pause(o.startPause);
  }
  const trace = typeof o.trace === 'function' ? (s) => o.trace(`start: ${s}`) : undefined;
  if (presses && !clicked && !canvasTried) {
    // Every press was a click event, which the page may have ignored (a bouncing "PRESS START" over a game that
    // starts on Enter): the centre click and Enter still get their turn.
    canvasTried = true;
    trace?.('every press was a click event: centre click and Enter');
    await centre(trace);
  }
  // Focus the game for the play input that follows (the click budget: nothing waits for a focus click).
  if (!canvasTried) await clickAt(page, o.viewport.width / 2, o.viewport.height / 2, o, guard, o.clickTimeout);
}

/**
 * Play input between post-start frames: step i of PLAY_STEPS. Clicks and Space go through pressCheck within the click
 * budget: on a page too busy to answer in time the input is skipped, never the frame after it delayed.
 */
async function playInput(page, i, o, guard, signal) {
  const step = PLAY_STEPS[i % PLAY_STEPS.length];
  const { width, height } = o.viewport;
  if (step.click) {
    await guard(within(page.mouse.move(width * step.click[0], height * step.click[1], { steps: 4 }), o.clickTimeout));
    await clickAt(page, width * step.click[0], height * step.click[1], o, guard, o.clickTimeout);
  }
  for (const k of step.keys) await guard(within(page.keyboard.down(k), o.clickTimeout));
  await guard(sleep(o.holdMs, signal));
  for (const k of step.keys) await guard(within(page.keyboard.up(k), o.clickTimeout));
  if (step.press) await pressKey(page, step.press, o, guard, o.clickTimeout);
}

/** How long the end of a capture waits for engine answers still out, its own last scan's among them. */
const ENGINE_WAIT = 750;

/**
 * Captures cover.png, shot-1.png and shot-2.png and writes engine.json for an opened game into outDir.
 * @returns {Promise<{ ok: true, files: string[] } | { ok: false, reason: string, detail?: string }>}
 */
export async function captureOne(url, outDir, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const files = NAMES.map((n) => join(outDir, `${n}.png`));
  const engineFile = join(outDir, 'engine.json');
  const cleanup = () => {
    for (const f of files) rmSync(f, { force: true });
    try {
      rmdirSync(outDir); // only if empty
    } catch {}
  };
  rmSync(engineFile, { force: true });
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
  const started = Date.now();
  const trace = typeof o.trace === 'function' ? o.trace : undefined; // local review only: our own decisions and timings
  const limit = o.deadline + (start ? o.startExtra : 0);
  const deadline = setTimeout(() => fail('deadline', `no result after ${limit} ms`), limit);
  const stop = new AbortController();

  // Frames taken so far live outside `work`, so a deadline or a frozen page after the cover still keeps the cover.
  // With the start step, `before` holds the frame taken before it (the menu), used only when nothing after it is.
  // `ads` counts frames dropped because an ad was in view.
  const state = { context: null, page: null, opened: false, finished: false, shots: [], before: [], timedOut: false, ads: 0 };
  // The best engine and the best renderer across all scans, each by its own priority.
  let engine = { engine: null, renderer: null, evidence: [] };
  const better = (order, next, current) => next && (!current || order.indexOf(next) < order.indexOf(current));
  const detected = (next) => {
    if (better(ENGINE_PRIORITY, next.engine, engine.engine)) engine = { ...engine, engine: next.engine, evidence: next.evidence };
    if (better(RENDERERS, next.renderer, engine.renderer)) engine = { ...engine, renderer: next.renderer };
  };
  // Engine scans: when the game is found, after each input that can start it, and at the end. An answer counts whenever
  // it comes before the capture stops reading (`scanning`): a page busy drawing on a loaded runner can take longer than
  // any fixed wait to answer, and a scan at the end alone missed engines that the first click started.
  const scanning = new AbortController();
  const scans = [];
  const scan = () => scans.push(detectPageEngine(state.page, limit + ENGINE_WAIT, scanning.signal).then(detected));
  const pick = () => pickFrames([...state.shots, ...state.before], { preferred: state.shots.length });
  const work = async () => {
    const b = await guard(
      getBrowser(o).catch((e) => {
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
    // Every capture, first: no pointer lock, fullscreen or keyboard lock for anything the page runs.
    await guard(context.addInitScript(`(${noLocks})(window);`));
    await guard(context.addInitScript(installEngineProbe, ENGINE_GLOBALS));
    if (o.throttle) await guard(context.addInitScript(`(${throttleFrames})(window, ${Number(o.throttleGap) || 250});`));
    // A local browser runs on someone's machine: no File System Access pickers and no clipboard writes for the page.
    if (o.gpu || o.headed || o.chrome) await guard(context.addInitScript(`(${noFilePickers})(window);(${noClipboardWrites})(window);`));
    if (o.webgl) await guard(context.addInitScript(`(${noWebGPU})(window);`));
    const page = await guard(context.newPage());
    state.page = page;
    // A file input never opens a native dialog: a listener makes Playwright intercept it, and nothing is ever chosen.
    page.on('filechooser', () => {});
    context.on('page', (p) => p !== page && p.close().catch(() => {})); // popups
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('download', (d) => {
      d.cancel().catch(() => {});
      fail('download');
    });
    page.on('crash', () => fail('crash'));

    const open = async (target) => {
      state.opened = true;
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

    // Scan all frames after finding itch's game, while the screenshot schedule proceeds. Later scans catch engines
    // loaded by the first click, Play or a late iframe.
    scan();

    // One frame. A busy renderer can miss one frame deadline; one retry before giving up on the game. Null when the
    // game stopped answering after earlier frames (those may be enough; later ones are a bonus); false when an ad was
    // in view (adInView): that frame is dropped and the schedule goes on.
    // Local review (`--all-frames`): every frame of every pass is also written as it is taken, picked or not, and a
    // frame dropped for an ad ends in `-ad`.
    const pass = `${start ? 'start' : 'plain'}${o.throttle ? '-throttled' : ''}${o.itchPage ? '-itchpage' : ''}`;
    let taken = 0;
    const snap = async () => {
      for (let attempt = 0; ; attempt++) {
        const asked = Date.now();
        let buf;
        try {
          buf = await guard(page.screenshot({ type: 'png', timeout: o.shotTimeout }));
        } catch (e) {
          trace?.(`screenshot failed after ${Date.now() - asked} ms`);
          if (e instanceof CaptureError || attempt === 1) {
            if (state.shots.length || state.before.length) {
              state.timedOut = true;
              return null;
            }
            throw e instanceof CaptureError ? e : new CaptureError('screenshot', firstLine(e));
          }
          continue;
        }
        trace?.(`screenshot took ${Date.now() - asked} ms`);
        const ad = await guard(adInView(page, o));
        if (o.allFrames) {
          mkdirSync(o.allFrames, { recursive: true });
          writeFileSync(join(o.allFrames, `${pass}-${taken++}${ad ? '-ad' : ''}.png`), buf);
        }
        if (!ad) return buf;
        state.ads++;
        trace?.('ad in view: frame dropped');
        return false;
      }
    };

    const t0 = Date.now();
    if (start) {
      await guard(sleep(t0 + o.times[0] - Date.now(), stop.signal));
      const menu = await snap();
      if (menu) state.before.push(menu);
      await startGame(page, o, guard, stop.signal);
      scan();
      const t1 = Date.now();
      // Local review (`--trace`): when the start step ended and when each frame after it came, from the capture's start.
      trace?.(`start step done at ${t1 - started} ms`);
      for (let i = 0; i < o.startTimes.length; i++) {
        await guard(sleep(t1 + o.startTimes[i] - Date.now(), stop.signal));
        const shot = await snap();
        trace?.(`frame ${i + 1} of ${o.startTimes.length} ${shot ? 'taken' : shot === false ? 'dropped' : 'lost'} at ${Date.now() - started} ms`);
        if (shot === null) return;
        if (shot) state.shots.push(shot);
        if (i < o.startTimes.length - 1) {
          const played = Date.now();
          await playInput(page, i, o, guard, stop.signal);
          trace?.(`play input ${i + 1} took ${Date.now() - played} ms`);
        }
      }
      return;
    }
    for (let i = 0; i < o.times.length; i++) {
      await guard(sleep(t0 + o.times[i] - Date.now(), stop.signal));
      const shot = await snap();
      if (shot === null) return;
      if (shot) state.shots.push(shot);
      if (i === 0) {
        // One click in the centre starts games that wait for input (never on a link or a wallet button: pressCheck)…
        await clickAt(page, o.viewport.width / 2, o.viewport.height / 2, o, guard);
        scan();
      } else if (i === 1) {
        // …and Enter gets past "press any key" menus.
        await pressKey(page, 'Enter', o, guard);
        scan();
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
    // No frame without an ad: the live images stay, and the run says why ("ads").
    if (!picked.length) {
      if (state.timedOut) throw new CaptureError('screenshot', 'frames timed out after a blank start');
      if (state.ads) throw new CaptureError('ads', `${state.ads} frames had an ad in view, and no other frame was usable`);
      throw new CaptureError('blank', 'every frame was black, blank or a loading screen');
    }
    mkdirSync(outDir, { recursive: true });
    picked.forEach((buf, i) => writeFileSync(files[i], buf));
    // `stalled`: frames stopped coming after these (a screenshot timed out), so a throttled pass may get more.
    result = { ok: true, files: files.slice(0, picked.length), ...(picked.length < files.length ? { partial: true } : {}), ...(state.timedOut ? { stalled: true } : {}) };
  } catch (e) {
    cleanup();
    const froze = e instanceof CaptureError && (e.reason === 'deadline' || e.reason === 'screenshot');
    const keep = froze && (state.shots.length || state.before.length) ? await pick() : [];
    if (keep.length) {
      // The game froze or ran out of time after some good frames: keep those.
      trace?.(`${e.reason} at ${Date.now() - started} ms: kept ${keep.length} frames`);
      mkdirSync(outDir, { recursive: true });
      keep.forEach((buf, i) => writeFileSync(files[i], buf));
      result = { ok: true, files: files.slice(0, keep.length), partial: true, stalled: true };
    } else {
      result = e instanceof CaptureError ? { ok: false, reason: e.reason, detail: e.message } : { ok: false, reason: 'error', detail: firstLine(e) };
    }
  } finally {
    over = true;
    state.finished = true;
    clearTimeout(deadline);
    stop.abort();
    // The last scan, then at most ENGINE_WAIT ms for its answer and any other still out; what answered by then counts.
    if (state.opened) scan();
    await within(Promise.all(scans), ENGINE_WAIT);
    scanning.abort();
    await Promise.all(scans);
    await closeContext(state.context, o.closeTimeout);
    if (state.opened) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(engineFile, JSON.stringify(engine) + '\n');
    }
  }
  // How many frames an ad cost: the run log says so.
  return state.ads ? { ...result, adFrames: state.ads } : result;
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
        const all = {
          ...(opts.allFrames ? { allFrames: join(opts.allFrames, slug) } : {}),
          ...(opts.trace === true ? { trace: (line) => log(`     ${slug}: ${line}`) } : {}),
        };
        const run = (o) => captureOne(url, join(out, slug), { ...o, ...all }).catch((e) => ({ ok: false, reason: 'error', detail: firstLine(e) }));
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
        // One more pass in a scratch folder, so a worse pass never removes a better one: it replaces this game's files
        // only when it kept more than `kept` frames. Returns its result with the files in place, or null.
        const betterPass = async (o, kept) => {
          const scratch = mkdtempSync(join(tmpdir(), 'capture-pass-'));
          try {
            const again = await captureOne(url, join(scratch, slug), { ...o, ...all }).catch((e) => ({ ok: false, reason: 'error', detail: firstLine(e) }));
            if (!again.ok || again.files.length <= kept) return null;
            for (const n of NAMES) rmSync(join(out, slug, `${n}.png`), { force: true });
            mkdirSync(join(out, slug), { recursive: true });
            const files = again.files.map((f) => {
              const to = join(out, slug, basename(f));
              copyFileSync(f, to);
              return to;
            });
            copyFileSync(join(scratch, slug, 'engine.json'), join(out, slug, 'engine.json'));
            return { ...again, files };
          } finally {
            rmSync(scratch, { recursive: true, force: true });
          }
        };
        // start: 'retry'. A game that kept fewer than three frames (usually a menu that never changed) or only blank
        // ones gets one more pass with the start step; the pass that kept more frames wins.
        const kept = res.ok ? res.files.length : 0;
        if (opts.start === 'retry' && (res.ok ? kept < NAMES.length : res.reason === 'blank') && Date.now() - batchStart < budgetMs) {
          log(`     ${slug}: ${res.ok ? `${kept} of ${NAMES.length} frames` : res.reason}, retry with the start step`);
          const again = await betterPass({ ...opts, start: true, ...(res.throttled ? { throttle: true } : {}), ...(res.itchPage ? { itchPage: true } : {}) }, kept);
          if (again) res = { ...again, started: true };
        }
        // Frames that stopped coming (every later screenshot timed out, as when heavy 3D starts after a light menu) leave
        // only what came before: one more pass with throttled frames; the pass that kept more frames wins.
        if (res.ok && res.stalled && !res.throttled && !opts.throttle && res.files.length < NAMES.length && Date.now() - batchStart < budgetMs) {
          log(`     ${slug}: frames stopped after ${res.files.length}, retry throttled`);
          const started = res.started || opts.start === true;
          const again = await betterPass({ ...opts, throttle: true, ...(started ? { start: true } : {}), ...(res.itchPage ? { itchPage: true } : {}) }, res.files.length);
          if (again) res = { ...again, throttled: true, ...(res.started ? { started: true } : {}), ...(res.itchPage ? { itchPage: true } : {}) };
        }
      }
    }
    const name = SLUG.test(slug) ? slug : '(invalid)';
    if (!res.ok) appendFailure(out, { slug: name, reason: res.reason, ...(res.detail ? { detail: res.detail } : {}) });
    if (res.skipped) log(`skip ${name}: the creator sent screenshots`);
    else log(`${res.ok ? 'ok  ' : 'FAIL'} ${name} (${((Date.now() - started) / 1000).toFixed(1)} s${res.ok ? `, ${res.files.length} of ${NAMES.length} frames` : ''}${res.ok && res.adFrames ? `, ${res.adFrames} dropped for an ad in view` : ''})${res.ok ? '' : `: ${res.reason}`}`);
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

/**
 * Seconds of play after the start step, for slow games (a management sim, a rocket on the pad) whose frames a few
 * seconds apart look the same: the post-start frames spread evenly up to that time, and the deadline grows with it.
 * 15 to 120; anything else is no change.
 */
export function playOptions(seconds) {
  const s = Math.floor(Number(seconds));
  if (!(s >= 15 && s <= 120)) return {};
  const first = DEFAULTS.startTimes[0];
  const last = s * 1000;
  const n = DEFAULTS.startTimes.length;
  const startTimes = Array.from({ length: n }, (_, i) => Math.round(first + ((last - first) * i) / (n - 1)));
  return { startTimes, startExtra: DEFAULTS.startExtra + last - DEFAULTS.startTimes[n - 1] };
}

/**
 * Command-line options. CI passes slugs only. A local capture on a machine with a GPU adds `--gpu` (Playwright's
 * Chromium) or `--chrome` (the installed Chrome), `--headed` to watch, `--webgl` for a game whose WebGPU path draws
 * nothing, `--play <s>` for slow games, `--rooms` (the start step may join a room from a list: look at every frame, a
 * public room can show strangers' names and chat), `--trace` (the start step's decisions) and `--all-frames <dir>`
 * (every frame, for review); it may read entries from another checkout (`--root`, e.g. a seed branch's worktree) and
 * write elsewhere (`--out`).
 */
export function cliOptions(argv) {
  const res = { slugs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--gpu') res.gpu = true;
    else if (a === '--headed') res.headed = true;
    else if (a === '--trace') res.trace = true;
    else if (a === '--rooms') res.rooms = true;
    else if (a === '--webgl') res.webgl = true;
    else if (a === '--chrome') res.chrome = true;
    else if (a === '--play') {
      const p = playOptions(argv[++i]);
      if (!p.startTimes) throw new Error('--play needs 15 to 120 seconds');
      Object.assign(res, p);
    } else if (a === '--root' || a === '--out' || a === '--all-frames') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a directory`);
      res[{ '--root': 'root', '--out': 'out', '--all-frames': 'allFrames' }[a]] = v;
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else res.slugs.push(a);
  }
  return res;
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
  let cli;
  try {
    cli = cliOptions(process.argv.slice(2));
  } catch {
    cli = null;
  }
  if (!cli?.slugs.length) {
    console.error('usage: node scripts/capture.mjs [--gpu] [--chrome] [--headed] [--webgl] [--rooms] [--trace] [--play <15-120 s>] [--root <catalog checkout>] [--out <dir>] [--all-frames <dir>] <slug…>');
    process.exit(2);
  }
  const { slugs, ...local } = cli;
  const results = await captureSlugs(slugs, { ...waitOptions(process.env.CAPTURE_WAIT), ...startOptions(process.env.CAPTURE_START), ...local });
  await closeBrowser();
  for (const line of summary(results)) console.log(line);
  // Failed games are expected and logged; a browser that never starts is a broken runner.
  process.exit(results.some((r) => r.reason === 'browser') && !results.some((r) => r.ok && !r.skipped) ? 1 : 0);
}
