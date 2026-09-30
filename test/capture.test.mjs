import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureOne, captureSlugs, closeBrowser, throttleFrames, DEFAULTS } from '../scripts/capture.mjs';

// Fixture pages are our own, so the Chromium sandbox is off here (CI's validate job has no sandbox setup).
const FAST = { times: [300, 700, 1100], navTimeout: 4000, deadline: 6000, shotTimeout: 2000, clickTimeout: 1000, closeTimeout: 2000, allowLocalHttp: true, sandbox: false };

const html = (body) => `<!doctype html><meta charset="utf-8"><title>fixture</title><style>html,body{margin:0;background:#000}</style>${body}`;
const PAGES = {
  '/game': html(`<canvas id="c" width="1280" height="720"></canvas><script>
    const g = document.getElementById('c').getContext('2d');
    let t = 0;
    (function frame() { t += 1; for (let x = 0; x < 1280; x += 40) for (let y = 0; y < 720; y += 40) { g.fillStyle = 'hsl(' + ((t * 7 + x + y * 3) % 360) + ' 80% ' + (20 + ((x + y + t * 23) % 60)) + '%)'; g.fillRect(x, y, 40, 40); }
      // The cell pattern repeats every 60 frames, and a throttled CI runner can capture two frames exactly one period
      // apart (deduped as the same picture). A white bar that moves with wall-clock time keeps every capture distinct.
      g.fillStyle = '#fff'; g.fillRect((performance.now() / 2) % 1080, 0, 200, 720);
      requestAnimationFrame(frame); })();
    addEventListener('click', () => { t += 90; });
  </script>`),
  '/hang': html(`<p style="color:#fff">loading</p><script>addEventListener('load', () => setTimeout(() => { for (;;) {} }, 200));</script>`),
  '/late-hang': html(`<canvas id="c" width="1280" height="720"></canvas><script>
    const g = document.getElementById('c').getContext('2d');
    for (let x = 0; x < 1280; x += 40) for (let y = 0; y < 720; y += 40) { g.fillStyle = 'hsl(' + ((x + y * 3) % 360) + ' 80% ' + (30 + ((x * y) % 40)) + '%)'; g.fillRect(x, y, 40, 40); }
    addEventListener('load', () => setTimeout(() => { for (;;) {} }, 600));
  </script>`),
  '/loading-then-game': html(`<canvas id="c" width="1280" height="720"></canvas><script>
    const g = document.getElementById('c').getContext('2d');
    g.fillStyle = '#050505'; g.fillRect(0, 0, 1280, 720);
    setTimeout(() => { for (let x = 0; x < 1280; x += 40) for (let y = 0; y < 720; y += 40) { g.fillStyle = 'hsl(' + ((x + y * 3) % 360) + ' 80% ' + (30 + ((x * y) % 40)) + '%)'; g.fillRect(x, y, 40, 40); } }, 500);
  </script>`),
  // Every frame blocks the main thread for 2 s, like a heavy WebGL game on software rendering.
  '/raf-hog': html(`<canvas id="c" width="1280" height="720"></canvas><script>
    const g = document.getElementById('c').getContext('2d');
    let t = 0;
    (function frame() {
      t += 1;
      for (let x = 0; x < 1280; x += 40) for (let y = 0; y < 720; y += 40) { g.fillStyle = 'hsl(' + ((t * 7 + x + y * 3) % 360) + ' 80% ' + (20 + ((x + y + t * 23) % 60)) + '%)'; g.fillRect(x, y, 40, 40); }
      const end = performance.now() + 2000; while (performance.now() < end) {}
      requestAnimationFrame(frame);
    })();
  </script>`),
  // Black at first; after 800 ms every frame blocks the main thread for 2 s.
  '/black-then-hog': html(`<canvas id="c" width="1280" height="720"></canvas><script>
    const g = document.getElementById('c').getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 1280, 720);
    let t = 0;
    setTimeout(function start() {
      (function frame() {
        t += 1;
        for (let x = 0; x < 1280; x += 40) for (let y = 0; y < 720; y += 40) { g.fillStyle = 'hsl(' + ((t * 7 + x + y * 3) % 360) + ' 80% ' + (20 + ((x + y + t * 23) % 60)) + '%)'; g.fillRect(x, y, 40, 40); }
        const end = performance.now() + 2000; while (performance.now() < end) {}
        requestAnimationFrame(frame);
      })();
    }, 800);
  </script>`),
  '/black': html(`<canvas width="1280" height="720" style="background:#000"></canvas>`),
  '/to-download': html(`<p style="color:#fff">starting</p><script>addEventListener('load', () => setTimeout(() => { location.href = '/download'; }, 100));</script>`),
  '/alerts': html(`<script>
    addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });
    addEventListener('load', () => setInterval(() => { alert('hi'); confirm('ok?'); prompt('name?'); }, 10));
  </script>`),
};

let server;
let base;
before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/download') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="game.exe"' });
      return res.end('MZ not really a program');
    }
    const page = PAGES[req.url];
    if (!page) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end(html('<p>not found</p>'));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await closeBrowser();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const tmp = () => mkdtempSync(join(tmpdir(), 'capture-'));
const files = (dir) => (existsSync(dir) ? readdirSync(dir) : []);
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

test('only https URLs are captured (http only for 127.0.0.1 when allowed)', async () => {
  for (const url of ['http://example.com/', 'file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,hi', 'not a url', 'http://127.0.0.1:1/']) {
    const res = await captureOne(url, join(tmp(), 'x'), { ...FAST, allowLocalHttp: url.startsWith('http://127') ? false : true });
    assert.deepEqual([url, res.ok, res.reason], [url, false, 'bad-url']);
  }
  const localhostName = await captureOne('http://localhost:1/', join(tmp(), 'x'), FAST);
  assert.equal(localhostName.reason, 'bad-url');
});

test('(a) a canvas game gives cover, shot-1 and shot-2 at 1280x720', async () => {
  const dir = join(tmp(), 'game');
  // Busy CI runners render this canvas in software: the FAST timings can let screenshots time out after the cover.
  const res = await captureOne(`${base}/game`, dir, { ...FAST, times: [400, 1200, 2000], shotTimeout: 6000, deadline: 20_000 });
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(files(dir).sort(), ['cover.png', 'shot-1.png', 'shot-2.png']);
  assert.deepEqual(res.files.map((f) => f.slice(dir.length + 1)), ['cover.png', 'shot-1.png', 'shot-2.png']);
  const [cover, , last] = res.files.map((f) => readFileSync(f));
  assert.equal(cover.subarray(1, 4).toString(), 'PNG');
  assert.deepEqual(pngSize(cover), { width: 1280, height: 720 });
  assert.notDeepEqual(cover, last, 'the game kept running between captures');
});

test('(b) a page that locks up after load fails within the deadline, leaves no files, and the next game still works', async () => {
  const dir = join(tmp(), 'hang');
  const started = Date.now();
  // Playwright's own screenshot timeout is far away: only the hard deadline can stop this one.
  const res = await captureOne(`${base}/hang`, dir, { ...FAST, deadline: 3000, shotTimeout: 60_000 });
  const took = Date.now() - started;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'deadline');
  assert.ok(took < 3000 + FAST.closeTimeout + 2500, `took ${took} ms`);
  assert.deepEqual(files(dir), []);

  const next = await captureOne(`${base}/game`, join(tmp(), 'next'), FAST);
  assert.equal(next.ok, true, next.reason);
});

test('(c) a URL that answers with a download fails and removes stale files', async () => {
  const dir = join(tmp(), 'dl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cover.png'), 'stale capture from an earlier run');
  const res = await captureOne(`${base}/download`, dir, FAST);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'download');
  assert.deepEqual(files(dir), []);
});

test('(c) a page that sends the browser to a download after load fails', async () => {
  const dir = join(tmp(), 'to-dl');
  const res = await captureOne(`${base}/to-download`, dir, FAST);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'download');
  assert.deepEqual(files(dir), []);
});

test('an error status fails the capture', async () => {
  const res = await captureOne(`${base}/missing`, join(tmp(), 'missing'), FAST);
  assert.deepEqual([res.ok, res.reason], [false, 'http-status']);
});

test('(d) a page spamming dialogs finishes within the deadline', async () => {
  const dir = join(tmp(), 'alerts');
  const started = Date.now();
  const res = await captureOne(`${base}/alerts`, dir, FAST);
  const took = Date.now() - started;
  assert.ok(took < FAST.deadline + FAST.closeTimeout + 2500, `took ${took} ms`);
  if (res.ok) assert.equal(files(dir).length, 3);
  else assert.deepEqual(files(dir), []);
});

test('the CLI loop reads entries, logs failures to failed.json and always continues', async () => {
  const root = tmp();
  mkdirSync(join(root, 'games'));
  const entry = (slug, url) => `slug: ${slug}\ntitle: ${slug}\nplay: { url: "${url}", platforms: [browser] }\n`;
  writeFileSync(join(root, 'games', 'hangs.yaml'), entry('hangs', `${base}/hang`));
  writeFileSync(join(root, 'games', 'plays.yaml'), entry('plays', `${base}/game`));
  const out = join(root, 'out');
  mkdirSync(out);
  writeFileSync(join(out, 'failed.json'), JSON.stringify([{ slug: 'earlier', reason: 'navigation' }]));

  const results = await captureSlugs(['hangs', 'no-such-game', '../escape', 'plays'], { ...FAST, deadline: 2500, shotTimeout: 60_000, root, out, log: () => {} });
  assert.deepEqual(results.map((r) => r.ok), [false, false, false, true]);
  // The loop continued and captured the good game. Its frame count isn't the point here: the 2.5 s deadline that keeps
  // the hanging case fast can end a slow runner's capture after the cover (a partial result, still ok).
  assert.ok(files(join(out, 'plays')).includes('cover.png'));
  assert.ok(!existsSync(join(out, 'hangs')) || files(join(out, 'hangs')).length === 0);
  const failed = JSON.parse(readFileSync(join(out, 'failed.json'), 'utf8'));
  assert.deepEqual(failed.map((f) => [f.slug, f.reason]), [
    ['earlier', 'navigation'],
    ['hangs', 'deadline'],
    ['no-such-game', 'no-entry'],
    ['(invalid)', 'invalid-slug'],
  ]);
});

test('a game that freezes after its cover keeps the cover (partial capture)', async () => {
  const dir = join(tmp(), 'late');
  const res = await captureOne(`${base}/late-hang`, dir, { ...FAST, deadline: 3000, shotTimeout: 1000 });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.partial, true);
  assert.deepEqual(files(dir), ['cover.png']);
});

test('a game whose frames hog the main thread times out, then is captured on a throttled second pass', async () => {
  const hog = { ...FAST, times: [300, 700], shotTimeout: 1900, deadline: 20_000 };
  const first = await captureOne(`${base}/raf-hog`, join(tmp(), 'hog'), hog);
  assert.equal(first.ok, false);
  assert.equal(first.reason, 'screenshot');

  const root = tmp();
  mkdirSync(join(root, 'games'));
  writeFileSync(join(root, 'games', 'hog.yaml'), `play:
  url: ${base}/raf-hog
`);
  const lines = [];
  const [res] = await captureSlugs(['hog'], { ...hog, root, out: join(root, 'out'), log: (l) => lines.push(l) });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.throttled, true);
  assert.ok(existsSync(join(root, 'out', 'hog', 'cover.png')));
  assert.match(lines.join(' '), /retry throttled/);
});

test('a black first frame followed by screenshot timeouts still gets the throttled retry', async () => {
  const root = tmp();
  mkdirSync(join(root, 'games'));
  writeFileSync(join(root, 'games', 'late.yaml'), `play:\n  url: ${base}/black-then-hog\n`);
  const lines = [];
  const [res] = await captureSlugs(['late'], { ...FAST, times: [200, 1200, 1600], shotTimeout: 1900, deadline: 20_000, root, out: join(root, 'out'), log: (l) => lines.push(l) });
  assert.match(lines.join(' '), /retry throttled/);
  assert.notEqual(res.reason, 'blank');
});

test('no throttled retry once the batch budget is spent', async () => {
  const root = tmp();
  mkdirSync(join(root, 'games'));
  writeFileSync(join(root, 'games', 'hog.yaml'), `play:\n  url: ${base}/raf-hog\n`);
  const lines = [];
  const [res] = await captureSlugs(['hog'], { ...FAST, times: [300, 700], shotTimeout: 1900, deadline: 20_000, budgetMs: 0, root, out: join(root, 'out'), log: (l) => lines.push(l) });
  assert.equal(res.ok, false);
  assert.doesNotMatch(lines.join(' '), /retry throttled/);
});

test('the throttle keeps requestAnimationFrame working and cancellable', async () => {
  const calls = [];
  const timers = new Map();
  let next = 0;
  const win = {
    requestAnimationFrame: (cb) => { const id = ++next; calls.push(['raf', id]); queueMicrotask(() => cb(16)); return id; },
    cancelAnimationFrame: (id) => calls.push(['caf', id]),
    setTimeout: (fn, ms) => { const id = ++next; timers.set(id, fn); calls.push(['timeout', ms]); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  throttleFrames(win, 250);
  let ran = 0;
  const a = win.requestAnimationFrame(() => ran++);
  const b = win.requestAnimationFrame(() => ran++);
  win.cancelAnimationFrame(b);
  for (const fn of [...timers.values()]) fn();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ran, 1);
  assert.ok(calls.some(([k, ms]) => k === 'timeout' && ms === 250));
  assert.notEqual(a, b);
});

test('pickFrames drops black and flat frames, puts the most detailed first and skips near-duplicates', async () => {
  const { pickFrames } = await import('../scripts/capture.mjs');
  const sharp = (await import('sharp')).default;
  const solid = (r, g, b) => sharp({ create: { width: 320, height: 180, channels: 3, background: { r, g, b } } }).png().toBuffer();
  // Two clearly different detailed frames: a horizontal and a vertical gradient.
  const gradient = async (horizontal) => {
    const px = Buffer.alloc(320 * 180 * 3);
    for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) px.fill(horizontal ? Math.round((x / 319) * 255) : Math.round((y / 179) * 255), (y * 320 + x) * 3, (y * 320 + x) * 3 + 3);
    return sharp(px, { raw: { width: 320, height: 180, channels: 3 } }).png().toBuffer();
  };
  const noisy = (seed) => gradient(seed === 1);
  const black = await solid(2, 2, 3);
  const grey = await solid(128, 128, 128);
  const a = await noisy(1);
  const b = await noisy(99);
  const picked = await pickFrames([black, a, grey, a, b]);
  assert.equal(picked.length, 2, 'black, flat grey and the duplicate are dropped');
  assert.ok(picked.includes(a) && picked.includes(b));
  assert.deepEqual(await pickFrames([black, grey]), []);
});

test('a dark title screen is kept as the only frame when nothing brighter exists; a spinner on black never is', async () => {
  const { pickFrames } = await import('../scripts/capture.mjs');
  const sharp = (await import('sharp')).default;
  const px = (draw) => {
    const buf = Buffer.alloc(320 * 180 * 3, 2);
    for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) { const v = draw(x, y); if (v !== undefined) buf.fill(v, (y * 320 + x) * 3, (y * 320 + x) * 3 + 3); }
    return sharp(buf, { raw: { width: 320, height: 180, channels: 3 } }).png().toBuffer();
  };
  // A logo-and-menu block on black: dark overall, but clearly content.
  const darkTitle = await px((x, y) => (x >= 80 && x < 240 && y >= 60 && y < 120 ? 20 + Math.round(((x - 80) / 159) * 100) : undefined));
  // A small spinner on black.
  const spinner = await px((x, y) => (x >= 155 && x < 165 && y >= 85 && y < 95 ? 255 : undefined));
  const black = await px(() => undefined);
  const bright = await px((x) => Math.round((x / 319) * 255));
  assert.deepEqual(await pickFrames([black, darkTitle, black]), [darkTitle]);
  assert.deepEqual(await pickFrames([black, spinner]), []);
  assert.deepEqual(await pickFrames([darkTitle, bright]), [bright], 'a real frame wins; the fallback is only for dark games');
});

test('a loading screen never becomes the cover; an all-black game is not captured', async () => {
  const dir = join(tmp(), 'loading');
  const res = await captureOne(`${base}/loading-then-game`, dir, FAST);
  assert.equal(res.ok, true, res.reason);
  const { default: sharp } = await import('sharp');
  const { channels } = await sharp(readFileSync(join(dir, 'cover.png'))).stats();
  assert.ok(channels[0].mean > 18, 'the cover is the game, not the black loading frame');
  const black = await captureOne(`${base}/black`, join(tmp(), 'black'), FAST);
  assert.equal(black.ok, false);
  assert.equal(black.reason, 'blank');
});

test('a slow game can get a longer wait: every frame moves later and the deadline grows with it', async () => {
  const { waitOptions } = await import('../scripts/capture.mjs');
  assert.deepEqual(waitOptions(0), {});
  const o = waitOptions(30);
  assert.deepEqual(o.times, DEFAULTS.times.map((t) => t + 30_000));
  assert.equal(o.deadline, DEFAULTS.deadline + 30_000);
  assert.deepEqual(waitOptions(500).times, DEFAULTS.times.map((t) => t + 90_000), 'capped at 90 seconds');
  assert.deepEqual(waitOptions('nope'), {});
});
