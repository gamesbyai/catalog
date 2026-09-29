import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureOne, captureSlugs, closeBrowser } from '../scripts/capture.mjs';

// Fixture pages are our own, so the Chromium sandbox is off here (CI's validate job has no sandbox setup).
const FAST = { times: [300, 700, 1100], navTimeout: 4000, deadline: 6000, shotTimeout: 2000, clickTimeout: 1000, closeTimeout: 2000, allowLocalHttp: true, sandbox: false };

const html = (body) => `<!doctype html><meta charset="utf-8"><title>fixture</title><style>html,body{margin:0;background:#000}</style>${body}`;
const PAGES = {
  '/game': html(`<canvas id="c" width="1280" height="720"></canvas><script>
    const g = document.getElementById('c').getContext('2d');
    let t = 0;
    (function frame() { t += 1; g.fillStyle = 'hsl(' + ((t * 7) % 360) + ' 80% 50%)'; g.fillRect(0, 0, 1280, 720); requestAnimationFrame(frame); })();
    addEventListener('click', () => { t += 90; });
  </script>`),
  '/hang': html(`<p style="color:#fff">loading</p><script>addEventListener('load', () => setTimeout(() => { for (;;) {} }, 200));</script>`),
  '/late-hang': html(`<canvas id="c" width="1280" height="720"></canvas><script>
    document.getElementById('c').getContext('2d').fillStyle = '#c6ff3d';
    document.getElementById('c').getContext('2d').fillRect(0, 0, 1280, 720);
    addEventListener('load', () => setTimeout(() => { for (;;) {} }, 600));
  </script>`),
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
  const res = await captureOne(`${base}/game`, dir, FAST);
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
  assert.deepEqual(files(join(out, 'plays')).sort(), ['cover.png', 'shot-1.png', 'shot-2.png']);
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
