import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { join } from 'node:path';
import { captureOne, captureSlugs, closeBrowser, throttleFrames, itchFrame, DEFAULTS } from '../scripts/capture.mjs';

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
  // An itch.io-style page: the game fills the window and the page's toolbar sits over its top-right corner.
  '/itch-page': html(`<div id="user_tools" style="position:fixed;top:0;right:0;width:240px;height:160px;background:#f00;z-index:9"></div>
    <canvas id="c" width="1280" height="720"></canvas><script>
    const g = document.getElementById('c').getContext('2d');
    for (let x = 0; x < 1280; x += 40) for (let y = 0; y < 720; y += 40) { g.fillStyle = 'hsl(' + ((x + y * 3) % 360) + ' 60% ' + (30 + ((x * y) % 40)) + '%)'; g.fillRect(x, y, 40, 40); }
  </script>`),
  '/to-download': html(`<p style="color:#fff">starting</p><script>addEventListener('load', () => setTimeout(() => { location.href = '/download'; }, 100));</script>`),
  '/alerts': html(`<script>
    addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });
    addEventListener('load', () => setInterval(() => { alert('hi'); confirm('ok?'); prompt('name?'); }, 10));
  </script>`),
  // Title screens like most games that kept one frame: a still scene behind a magenta menu whose Play button sits
  // off-centre, so the plain schedule's centre click and Enter never start the game.
  '/menu': menuPage(`<button style="position:absolute;left:40px;bottom:40px;font-size:40px" onclick="startGame()">&#9654; PLAY</button>
    <button style="position:absolute;left:40px;bottom:120px;font-size:30px">Settings</button>`),
  // A name-entry screen: Join stays disabled until the name field has text.
  '/name-entry': menuPage(`<input id="n" placeholder="Enter your nickname" style="position:absolute;left:40px;top:40px;font-size:30px">
    <button id="j" disabled style="position:absolute;left:40px;bottom:40px;font-size:40px" onclick="startGame()">Join</button>
    <script>document.getElementById('n').addEventListener('input', (e) => { document.getElementById('j').disabled = !e.target.value.trim(); });</script>`),
  // A text-only menu (no button role) with a link to another page called "Play" before it: the link is never followed.
  '/text-menu': menuPage(`<a href="/elsewhere" style="position:absolute;left:40px;top:40px;font-size:30px;color:#fff">Play</a>
    <div style="position:absolute;left:40px;bottom:40px;font-size:40px;color:#fff;cursor:pointer" onclick="startGame()">PLAY</div>`),
  '/link-only': menuPage(`<a href="/elsewhere" style="position:absolute;left:40px;bottom:40px;font-size:40px;color:#fff">Play</a>`),
  // "Play" opens a server list here (the game never starts); "Solo" starts it.
  '/solo-menu': menuPage(`<button style="position:absolute;left:40px;top:40px;font-size:40px" onclick="location.hash = 'servers'">PLAY</button>
    <button style="position:absolute;left:40px;bottom:40px;font-size:40px" onclick="startGame()">Solo</button>`),
  '/german-menu': menuPage(`<button style="position:absolute;left:40px;bottom:40px;font-size:40px" onclick="startGame()">Neues Spiel</button>`),
  // A transparent layer over the whole page takes every mouse click.
  '/covered-menu': menuPage(`<button style="position:absolute;left:40px;bottom:40px;font-size:40px" onclick="startGame()">PLAY</button>
    <div style="position:fixed;inset:0;z-index:5"></div>`),
  // The menu's button appears only after a long load.
  '/late-menu': menuPage(`<script>setTimeout(() => {
      const b = document.createElement('button'); b.textContent = 'PLAY'; b.style.cssText = 'position:absolute;left:40px;bottom:40px;font-size:40px';
      b.onclick = () => startGame(); document.getElementById('menu').appendChild(b);
    }, 1500);</script>`),
  // A "Play" tab that stays on screen and does nothing; the game starts with Deploy.
  '/tab-menu': menuPage(`<div style="position:absolute;left:40px;top:40px;font-size:30px;color:#fff;cursor:pointer">Play</div>
    <button style="position:absolute;left:40px;bottom:40px;font-size:40px" onclick="startGame()">Deploy</button>`),
  // A name with a button of its own and no form.
  '/name-button': menuPage(`<input placeholder="Your name" style="position:absolute;left:40px;top:40px;font-size:30px">
    <button style="position:absolute;left:40px;top:120px;font-size:30px" onclick="startGame()">Open Caf&eacute;</button>`),
  '/rooms': menuPage(`<button style="position:absolute;left:40px;top:40px;font-size:30px" onclick="startGame()">Neon Corner 0/12</button>
    <button style="position:absolute;left:40px;bottom:40px;font-size:30px">Back</button>`),
  // A question first ("No" declines it), then the menu.
  '/sound-prompt': menuPage(`<p style="position:absolute;left:40px;top:40px;font-size:30px">Enable sounds?</p>
    <button id="yes" style="position:absolute;left:40px;top:200px;font-size:30px">Yes</button>
    <button id="no" style="position:absolute;left:200px;top:200px;font-size:30px">No</button>
    <script>document.getElementById('no').onclick = () => {
      const m = document.getElementById('menu'); m.innerHTML = '';
      const b = document.createElement('button'); b.textContent = 'PLAY'; b.style.cssText = 'position:absolute;left:40px;bottom:40px;font-size:40px';
      b.onclick = () => startGame(); m.appendChild(b);
    };</script>`),
};

// The scene behind the menus: still until startGame(); after that it scrolls only while arrow or WASD keys are held.
function menuPage(menu) {
  return html(`<canvas id="c" width="1280" height="720" style="position:fixed;inset:0"></canvas>
    <div id="menu" style="position:fixed;left:60px;top:80px;width:500px;height:560px;background:#f0f">${menu}</div>
    <script>
    const g = document.getElementById('c').getContext('2d');
    let x = 0, y = 0, vx = 0, vy = 0, on = false;
    const draw = () => { for (let i = 0; i < 1280; i += 40) for (let j = 0; j < 720; j += 40) { g.fillStyle = 'hsl(' + ((i + j * 3 + x * 2 + y * 5) % 360) + ' 70% ' + (25 + ((i * j + x * 3 + y * 7) % 45)) + '%)'; g.fillRect(i, j, 40, 40); } };
    draw();
    const keys = { ArrowRight: [12, 0], KeyD: [12, 0], ArrowLeft: [-12, 0], KeyA: [-12, 0], ArrowUp: [0, -12], KeyW: [0, -12], ArrowDown: [0, 12], KeyS: [0, 12] };
    addEventListener('keydown', (e) => { if (on && keys[e.code]) [vx, vy] = keys[e.code]; });
    addEventListener('keyup', (e) => { if (keys[e.code]) vx = vy = 0; });
    window.startGame = () => { if (on) return; on = true; document.getElementById('menu').remove(); (function frame() { x += vx; y += vy; draw(); requestAnimationFrame(frame); })(); };
    </script>`);
}

let server;
let base;
const hits = { elsewhere: 0 };
before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/elsewhere') hits.elsewhere++;
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

test("itchFrame: an itch.io game page gives the game's own frame on itch's CDN, nothing else does", () => {
  const src = 'https://html-classic.itch.zone/html/18045891/index.html?v=1782553893';
  assert.equal(itchFrame('https://fixture.itch.io/game', src), src);
  assert.equal(itchFrame('https://fixture.itch.io/game', 'https://html.itch.zone/html/42/Build/index.html'), 'https://html.itch.zone/html/42/Build/index.html');
  // Upload ids with a build suffix, and folder names with spaces (sent encoded).
  assert.equal(itchFrame('https://fixture.itch.io/game', 'https://html-classic.itch.zone/html/17992902-1817582/index.html?v=1784940635'), 'https://html-classic.itch.zone/html/17992902-1817582/index.html?v=1784940635');
  assert.equal(itchFrame('https://fixture.itch.io/game', 'https://html-classic.itch.zone/html/16619648/Marble Garble/index.html?v=1782564506'), 'https://html-classic.itch.zone/html/16619648/Marble%20Garble/index.html?v=1782564506');
  // Only itch.io pages, and only itch's CDN pattern: no other host, scheme or path is ever followed.
  for (const page of ['https://example.com/game', 'https://itch.io.example.com/game', 'not a url']) assert.equal(itchFrame(page, src), null, page);
  for (const bad of [
    'https://html-classic.itch.zone.example.com/html/1/index.html',
    'http://html-classic.itch.zone/html/1/index.html',
    'https://user:pass@html.itch.zone/html/1/index.html',
    'https://html.itch.zone:444/html/1/index.html',
    'https://html-classic.itch.zone/other/1/index.html',
    'https://html-classic.itch.zone/html/1/../../x.html',
    `<title>src="${src}"</title>`,
    '',
    null,
    undefined,
  ]) assert.equal(itchFrame('https://fixture.itch.io/game', bad), null, String(bad));
});

test('itchFrame: encoded dot segments cannot escape the upload directory after URL normalisation', () => {
  for (const src of [
    'https://html.itch.zone/html/42/%2e%2e/%2e%2e/index.html',
    'https://html-classic.itch.zone/html/42/%2E%2e/%2e%2E/index.html',
    'https://html.itch.zone/html/42/%2e%2e/43/index.html',
  ]) assert.equal(itchFrame('https://fixture.itch.io/game', src), null, src);
  assert.equal(itchFrame('https://fixture.itch.io/game', 'https://html.itch.zone/html/42/sub/%2e%2e/index.html'), 'https://html.itch.zone/html/42/index.html');
});

test('captureOne: only the game frame is read from an itch.io page, even with a decoy URL in the title', async (t) => {
  await closeBrowser();
  const pageUrl = 'https://fixture.itch.io/game';
  const frameUrl = 'https://html.itch.zone/html/42/index.html';
  const spacedUrl = 'https://html-classic.itch.zone/html/42/Marble Garble/index.html?v=123';
  const decoy = 'https://html.itch.zone/html/99/index.html';
  const placeholder = (markup) => `<div class="iframe_placeholder" data-iframe="${markup.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"></div>`;
  const fixtures = [
    ['game_drop wins over the title and placeholder', `<iframe id="game_drop" src="${frameUrl}"></iframe>${placeholder(`<iframe src="${decoy}"></iframe>`)}`, frameUrl],
    ['placeholder HTML supports single quotes and spaces', placeholder(`<iframe src='${spacedUrl}'></iframe>`), spacedUrl.replace(/ /g, '%20')],
    ['placeholder text is not a frame', placeholder(`<!-- src="${decoy}" --><iframe src="${frameUrl}"></iframe>`), frameUrl],
    ['an unrelated iframe is ignored', `<iframe src="${decoy}"></iframe>`, null],
    ['an invalid game_drop does not select another frame', `<iframe id="game_drop" src="https://example.com/game.html"></iframe>${placeholder(`<iframe src="${frameUrl}"></iframe>`)}`, null],
    ['a title alone is ignored', '', null],
  ];
  let markup;
  let page;
  let navigations;
  const connect = chromium.connect.bind(chromium);
  t.mock.method(chromium, 'connect', async (...args) => {
    const b = await connect(...args);
    const newContext = b.newContext.bind(b);
    t.mock.method(b, 'newContext', async (...args) => {
      const context = await newContext(...args);
      // Every request is answered locally; these fixtures never contact itch.io or its CDN.
      await context.route('**/*', (route) => {
        const req = route.request();
        if (req.isNavigationRequest() && !req.frame().parentFrame()) navigations.push(req.url());
        return route.fulfill({ contentType: 'text/html', body: req.url() === pageUrl ? markup : PAGES['/game'] });
      });
      context.on('page', (p) => { page = p; t.mock.method(p, 'content'); });
      return context;
    });
    return b;
  });
  try {
    for (const [name, body, frame] of fixtures) await t.test(name, async () => {
      markup = PAGES['/game'].replace('<title>fixture</title>', `<title>src="${decoy}"</title>`) + body;
      navigations = [];
      // The first fixture starts a cold browser inside the deadline; 6 s was too tight on slow CI runners.
      const res = await captureOne(pageUrl, join(tmp(), 'itch-frame'), { ...FAST, times: [100], deadline: 20_000 });
      assert.deepEqual(navigations, frame ? [pageUrl, frame] : [pageUrl]);
      assert.equal(page.content.mock.callCount(), 0, 'the whole page markup is never read');
      assert.equal(res.ok, true, JSON.stringify(res));
    });
  } finally {
    await closeBrowser();
  }
});

const ITCH_TEST = { itchHost: /^127\.0\.0\.1$/ };

test('itchPage: the itch.io page is captured with its toolbar hidden', async () => {
  const dir = join(tmp(), 'itch');
  const res = await captureOne(`${base}/itch-page`, dir, { ...FAST, ...ITCH_TEST, itchPage: true, times: [400, 900], shotTimeout: 6000, deadline: 20_000 });
  assert.equal(res.ok, true, res.reason);
  const { data } = await sharp(readFileSync(join(dir, 'cover.png'))).extract({ left: 1200, top: 20, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  assert.notDeepEqual([...data.subarray(0, 3)], [255, 0, 0], 'the toolbar is not in the cover');
});

test('an itch.io game that fails in its own frame gets one more try on the itch page', async () => {
  const root = tmp();
  mkdirSync(join(root, 'games'));
  writeFileSync(join(root, 'games', 'dark.yaml'), `play:\n  url: ${base}/black\n`);
  writeFileSync(join(root, 'games', 'plain.yaml'), `play:\n  url: ${base}/black\n`);
  const lines = [];
  const [itch] = await captureSlugs(['dark'], { ...FAST, ...ITCH_TEST, root, out: join(root, 'out'), log: (l) => lines.push(l) });
  assert.equal(itch.reason, 'blank');
  assert.match(lines.join(' '), /dark: blank, retry on the itch page/);
  const other = [];
  await captureSlugs(['plain'], { ...FAST, root, out: join(root, 'out2'), log: (l) => other.push(l) });
  assert.doesNotMatch(other.join(' '), /itch page/, 'only itch.io games get the page retry');
});

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
  // A hogged main thread can also slow the page load on a busy CI runner: load gets its own generous limit.
  const hog = { ...FAST, times: [300, 700], shotTimeout: 1900, deadline: 20_000, navTimeout: 15_000 };
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
  const [res] = await captureSlugs(['late'], { ...FAST, times: [200, 1200, 1600], shotTimeout: 1900, deadline: 20_000, navTimeout: 15_000, root, out: join(root, 'out'), log: (l) => lines.push(l) });
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

const sentEntry = (url, uploads = { ref: '3f9a0c1e8b7d6a54', count: 2 }) =>
  `slug: sent\ntitle: Sent\nplay: { url: "${url}", platforms: [browser] }\nprovenance:\n  foundVia: form\n  submittedBy: "#9"\n  uploads: ${JSON.stringify(uploads)}\n`;

test('a game whose creator sent screenshots is never opened in the browser: skipped, no files, no failure', async () => {
  const root = tmp();
  mkdirSync(join(root, 'games'));
  // The play URL would capture fine: the skip is the entry's doing, not the page's.
  writeFileSync(join(root, 'games', 'sent.yaml'), sentEntry(`${base}/game`));
  const out = join(root, 'out');
  const lines = [];
  const started = Date.now();
  const [res] = await captureSlugs(['sent'], { ...FAST, root, out, log: (l) => lines.push(l) });
  assert.deepEqual(res, { slug: 'sent', ok: true, skipped: 'uploads' });
  assert.ok(Date.now() - started < 1000, 'no page was loaded');
  assert.ok(!existsSync(join(out, 'sent')));
  assert.ok(!existsSync(join(out, 'failed.json')), 'a skip is not a failure');
  assert.match(lines.join(' '), /skip sent: the creator sent screenshots/);
});

test('splitUploads sends games with valid creator uploads to the upload job and every other slug to the browser', async () => {
  const { splitUploads } = await import('../scripts/capture.mjs');
  const root = tmp();
  mkdirSync(join(root, 'games'));
  writeFileSync(join(root, 'games', 'sent.yaml'), sentEntry('https://sent.example/'));
  writeFileSync(join(root, 'games', 'plain.yaml'), 'slug: plain\nplay: { url: "https://plain.example/" }\nprovenance: { foundVia: form }\n');
  writeFileSync(join(root, 'games', 'odd.yaml'), sentEntry('https://odd.example/', { ref: 'NOT-HEX', count: 2 }));
  writeFileSync(join(root, 'games', 'many.yaml'), sentEntry('https://many.example/', { ref: '3f9a0c1e8b7d6a54', count: 4 }));
  writeFileSync(join(root, 'games', 'broken.yaml'), 'slug: [unclosed\n');
  assert.deepEqual(splitUploads(['plain', 'sent', 'odd', 'many', 'broken', 'missing', '../games/sent'], { root }), {
    capture: ['plain', 'odd', 'many', 'broken', 'missing', '../games/sent'],
    uploads: ['sent'],
  });
});

test('capture.mjs --split prints the split as JSON for the workflow', async () => {
  const { execFileSync } = await import('node:child_process');
  const slug = readdirSync('games').find((f) => f.endsWith('.yaml')).slice(0, -5);
  const list = join(tmp(), 'slugs.txt');
  writeFileSync(list, `${slug}\nno-such-game\n`);
  const res = JSON.parse(execFileSync(process.execPath, ['scripts/capture.mjs', '--split', list], { encoding: 'utf8' }));
  assert.deepEqual(res, { capture: [slug, 'no-such-game'], uploads: [] });
});

test('the capture workflow: the capture job holds no secrets and skips uploaded games; the upload job fetches them', async () => {
  const { parse } = await import('yaml');
  const wf = parse(readFileSync('.github/workflows/capture.yml', 'utf8'));
  const capture = JSON.stringify(wf.jobs.capture);
  assert.doesNotMatch(capture, /secrets\./, 'game pages run in the capture job: it gets no secrets');
  assert.match(wf.jobs.capture.steps.find((s) => s.name === 'Capture').run, /capture\.txt/, 'only the split list is captured');
  assert.match(wf.jobs.capture.outputs.uploads, /steps\.split\.outputs\.uploads/);
  const step = wf.jobs.upload.steps.find((s) => s.id === 'upload');
  assert.equal(step.env.INTERNAL_NOTIFY_TOKEN, '${{ secrets.INTERNAL_NOTIFY_TOKEN }}');
  assert.equal(step.env.UPLOADS, '${{ needs.capture.outputs.uploads }}');
  assert.equal(step.run.match(/--uploads "\$UPLOADS"/g).length, 2);
  assert.match(wf.jobs.upload.if, /needs\.capture\.outputs\.uploads != ''/);
});

test('the capture workflow: start step and min_frames inputs, parallel re-capture chunks, uploads from current main', async () => {
  const { parse } = await import('yaml');
  const wf = parse(readFileSync('.github/workflows/capture.yml', 'utf8'));
  const inputs = wf.on.workflow_dispatch.inputs;
  assert.ok(inputs.start && inputs.min_frames && inputs.slugs);
  const capture = wf.jobs.capture.steps.find((s) => s.name === 'Capture');
  assert.equal(capture.env.CAPTURE_START, '${{ inputs.start || vars.CAPTURE_START }}');
  // Chunks of a re-capture must not cancel each other; PR runs still replace their earlier run.
  assert.match(wf.concurrency.group, /github\.event\.pull_request\.number \|\| \(inputs\.slugs && github\.run_id\) \|\| inputs\.branch/);
  assert.equal(wf.concurrency['cancel-in-progress'], true);
  // The upload job runs main's current code, never the PR head or a stale base commit.
  assert.equal(wf.jobs.upload.steps.find((s) => s.uses?.startsWith('actions/checkout')).with.ref, 'main');
  const step = wf.jobs.upload.steps.find((s) => s.id === 'upload');
  assert.equal(step.env.MIN_FRAMES, '${{ inputs.min_frames }}');
  const [check, onlyLine, prLine] = step.run.trim().split('\n');
  assert.match(check, /\^\[1-3\]\$/, 'min_frames is validated before use');
  assert.match(onlyLine, /--only "\$ONLY".*\$\{MIN_FRAMES:\+--min-frames "\$MIN_FRAMES"\}/);
  assert.doesNotMatch(prLine, /min-frames/, 'PR captures of new games never compare with live images');
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

// --- The start step (CAPTURE_START) ---

const START_FAST = { start: true, startTimes: [250, 650, 1050], startExtra: 6000, startPause: 300, startBudget: 6000, holdMs: 200, shotTimeout: 4000, deadline: 12_000 };
const magentaAt = async (file, left, top) => {
  const { data } = await sharp(readFileSync(file)).extract({ left, top, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  const [r, g, b] = data;
  return r > 200 && g < 60 && b > 200;
};

test('start, next and name-field patterns match whole names only', async () => {
  const { START_NAMES, NEXT_NAMES, NAME_FIELD } = await import('../scripts/capture.mjs');
  for (const s of ['Play', '▶ PLAY', 'PLAY NOW!', 'Start Game', 'start', "Let's go", 'Let’s play', 'Tap to start', 'Click here to play', 'Single Player', 'singleplayer', 'New Game', 'Begin Adventure', 'Play vs CPU', 'Quick Play', '[ Launch ]']) assert.match(s, START_NAMES, s);
  for (const s of ['Display', 'How to play', 'Play with friends', 'Playground', 'Settings', 'Leaderboard', 'Play on itch.io', 'Restart level', 'Join Discord', 'Continue']) assert.doesNotMatch(s, START_NAMES, s);
  for (const s of ['Continue', 'JOIN', 'OK', 'Got it!', 'Skip intro', "I'm ready"]) assert.match(s, NEXT_NAMES, s);
  for (const s of ['Join Discord', 'Next level select', 'Okay then']) assert.doesNotMatch(s, NEXT_NAMES, s);
  for (const s of ['Enter your nickname', 'Your name', 'Username', 'Pilot name', 'Callsign', 'NAME']) assert.match(s, NAME_FIELD, s);
  for (const s of ['Search', 'Type a message to other players', 'Email', 'Rename']) assert.doesNotMatch(s, NAME_FIELD, s);
});

test('the root cause: a menu with an off-centre Play button keeps one frame (the menu) on the plain schedule', async () => {
  const dir = join(tmp(), 'menu-plain');
  const res = await captureOne(`${base}/menu`, dir, { ...FAST, times: [300, 700, 1100, 1500], shotTimeout: 4000, deadline: 12_000 });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.partial, true);
  assert.deepEqual(files(dir), ['cover.png'], 'every frame was the same menu');
  assert.ok(await magentaAt(join(dir, 'cover.png'), 300, 200), 'the cover is the menu');
});

test('the start step presses Play, plays between frames, and the cover is the game, not the menu', async () => {
  const dir = join(tmp(), 'menu-start');
  const res = await captureOne(`${base}/menu`, dir, { ...FAST, ...START_FAST });
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(files(dir).sort(), ['cover.png', 'shot-1.png', 'shot-2.png']);
  for (const f of res.files) assert.ok(!(await magentaAt(f, 300, 200)), `${f.slice(dir.length + 1)} shows the menu`);
});

test('the start step fills a name field, then presses Join', async () => {
  const dir = join(tmp(), 'name');
  const res = await captureOne(`${base}/name-entry`, dir, { ...FAST, ...START_FAST });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.files.length, 3);
  assert.ok(!(await magentaAt(res.files[0], 300, 200)), 'the cover is past the name screen');
});

test('the start step presses a text-only menu item, and never follows a link', async () => {
  hits.elsewhere = 0;
  const menu = await captureOne(`${base}/text-menu`, join(tmp(), 'text'), { ...FAST, ...START_FAST });
  assert.equal(menu.ok, true, menu.reason);
  assert.equal(menu.files.length, 3);
  const linkOnly = await captureOne(`${base}/link-only`, join(tmp(), 'link'), { ...FAST, ...START_FAST });
  assert.equal(linkOnly.ok, true, linkOnly.reason);
  assert.equal(linkOnly.files.length, 1, 'nothing to press: the menu stays');
  assert.equal(hits.elsewhere, 0, 'a link called Play is never followed');
});

test('the start step still captures a canvas game with no buttons', async () => {
  const res = await captureOne(`${base}/game`, join(tmp(), 'canvas-start'), { ...FAST, ...START_FAST });
  assert.equal(res.ok, true, res.reason);
  assert.ok(res.files.length >= 2, `${res.files.length} frames`);
});

test("start 'retry': a game that kept one frame gets a pass with the start step, and the better pass wins", async () => {
  const root = tmp();
  mkdirSync(join(root, 'games'));
  writeFileSync(join(root, 'games', 'menu.yaml'), `play:\n  url: ${base}/menu\n`);
  const lines = [];
  const { start, ...startFast } = START_FAST;
  const [res] = await captureSlugs(['menu'], { ...FAST, times: [300, 700, 1100], shotTimeout: 4000, ...startFast, start: 'retry', root, out: join(root, 'out'), log: (l) => lines.push(l) });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.started, true);
  assert.match(lines.join('\n'), /menu: 1 of 3 frames, retry with the start step/);
  assert.match(lines.join('\n'), /ok {3}menu \([\d.]+ s, 3 of 3 frames\)/);
  assert.deepEqual(files(join(root, 'out', 'menu')).sort(), ['cover.png', 'shot-1.png', 'shot-2.png']);
  assert.ok(!(await magentaAt(join(root, 'out', 'menu', 'cover.png'), 300, 200)));
});

test('solo, German, decline and room patterns match whole names only', async () => {
  const { SOLO_NAMES, START_NAMES, NEXT_NAMES, ROOM_NAMES } = await import('../scripts/capture.mjs');
  for (const s of ['Solo', 'Play Offline', 'OFFLINE', 'Practice', 'Practice Range', 'Training', 'FFA Bot Lobby', 'Bot Match', 'Play vs Bots', 'vs CPU', 'Single Player', 'Einzelspieler', 'Übung', 'Gegen Computer']) assert.match(s, SOLO_NAMES, s);
  for (const s of ['Play', 'Browse Lobbies', 'Online', 'Multiplayer', 'Solo leaderboard', 'Bot settings']) assert.doesNotMatch(s, SOLO_NAMES, s);
  for (const s of ['Neues Spiel', 'Spielen', 'Jetzt spielen', 'Spiel starten', 'Starten', 'Los geht’s', 'Enter the Arena ↗', 'Enter Game']) assert.match(s, START_NAMES, s);
  for (const s of ['Spielanleitung', 'Spielstand wählen', 'Enter your name', 'Enter the code']) assert.doesNotMatch(s, START_NAMES, s);
  for (const s of ['Weiter', 'No', 'No thanks', 'Not now', 'Nein', 'Überspringen', 'Play without sound']) assert.match(s, NEXT_NAMES, s);
  for (const s of ['Yes', 'Accept', 'Nothing', 'Notes', 'Weitere Spiele']) assert.doesNotMatch(s, NEXT_NAMES, s);
  for (const s of ['Neon Corner 0/12', 'Agartha (0/32)', 'EU-1 3/16', 'Room #4 2 / 8']) assert.match(s, ROOM_NAMES, s);
  for (const s of ['01 / 11', '1/2', 'Settings', 'Neon Corner']) assert.doesNotMatch(s, ROOM_NAMES, s);
  // Playwright passes each pattern inside a selector string, which allows no "u" flag and no bare "/".
  for (const re of [SOLO_NAMES, START_NAMES, NEXT_NAMES, ROOM_NAMES]) assert.doesNotMatch(re.flags, /u/, re.source);
});

const startsTheGame = async (path) => {
  const dir = join(tmp(), path.slice(1));
  const res = await captureOne(`${base}${path}`, dir, { ...FAST, ...START_FAST });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.files.length, 3, `${path}: ${res.files.length} frames`);
  for (const f of res.files) assert.ok(!(await magentaAt(f, 300, 200)), `${path}: ${f.slice(dir.length + 1)} shows the menu`);
};

test('the start step prefers Solo over a Play button that opens a server list', () => startsTheGame('/solo-menu'));
test('the start step presses German start buttons', () => startsTheGame('/german-menu'));
test('the start step presses a button under a transparent layer with a click event', () => startsTheGame('/covered-menu'));
test('the start step keeps looking while a menu is still loading', () => startsTheGame('/late-menu'));
test('a start option that stays on screen is pressed once, so the next button gets its turn', () => startsTheGame('/tab-menu'));
test("a name with no form gets the button beside it", () => startsTheGame('/name-button'));
test('a room list with player counts: the first room is joined', () => startsTheGame('/rooms'));
test('a question in the way gets the declining answer, then the menu its Play', () => startsTheGame('/sound-prompt'));

test('local captures: launch options, command line, play time and page scripts', async () => {
  const { launchOptions, cliOptions, playOptions, noFilePickers, noWebGPU } = await import('../scripts/capture.mjs');
  const ci = launchOptions({ sandbox: true });
  assert.equal(ci.headless, true);
  assert.equal(ci.channel, undefined, "CI keeps Playwright's headless shell");
  assert.ok(ci.args.includes('--use-angle=swiftshader'));
  assert.deepEqual(launchOptions({ gpu: true }), { headless: true, channel: 'chromium', chromiumSandbox: DEFAULTS.sandbox, args: ['--ignore-gpu-blocklist'] });
  assert.equal(launchOptions({ chrome: true }).channel, 'chrome');
  assert.equal(launchOptions({ headed: true }).headless, false);

  assert.deepEqual(cliOptions(['a', 'b']), { slugs: ['a', 'b'] }, 'CI passes slugs only');
  const local = cliOptions(['--chrome', '--webgl', '--trace', '--root', 'wt', '--out', 'o', '--all-frames', 'f', '--play', '30', 'x']);
  assert.deepEqual({ ...local, startTimes: undefined, startExtra: undefined }, { slugs: ['x'], chrome: true, webgl: true, trace: true, root: 'wt', out: 'o', allFrames: 'f', startTimes: undefined, startExtra: undefined });
  for (const bad of [['--nope', 'x'], ['--root'], ['--out', '--gpu'], ['--play', '5', 'x']]) assert.throws(() => cliOptions(bad), bad.join(' '));

  const p = playOptions(40);
  assert.equal(p.startTimes.length, DEFAULTS.startTimes.length);
  assert.equal(p.startTimes[0], DEFAULTS.startTimes[0]);
  assert.equal(p.startTimes.at(-1), 40_000);
  assert.ok(p.startTimes.every((t, i) => !i || t > p.startTimes[i - 1]), 'frames in order');
  assert.equal(p.startExtra, DEFAULTS.startExtra + 40_000 - DEFAULTS.startTimes.at(-1));
  for (const v of [0, 10, 200, 'nope']) assert.deepEqual(playOptions(v), {}, String(v));

  const win = { showOpenFilePicker() {}, showSaveFilePicker() {}, showDirectoryPicker() {}, Navigator: function () {} };
  win.Navigator.prototype.gpu = {};
  noFilePickers(win);
  noWebGPU(win);
  assert.equal(win.showOpenFilePicker, undefined);
  assert.equal(win.showDirectoryPicker, undefined);
  assert.equal(new win.Navigator().gpu, undefined);
});

test('--all-frames keeps every frame of every pass for review, picked or not', async () => {
  const all = join(tmp(), 'all');
  const res = await captureOne(`${base}/menu`, join(tmp(), 'menu-all'), { ...FAST, times: [300, 700, 1100, 1500], shotTimeout: 4000, deadline: 12_000, allFrames: all });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.files.length, 1, 'the picked frames: one menu');
  assert.deepEqual(files(all).sort(), ['plain-0.png', 'plain-1.png', 'plain-2.png', 'plain-3.png']);
});

test('CAPTURE_START: true, retry or off; the summary warns about games with fewer than three frames', async () => {
  const { startOptions, summary } = await import('../scripts/capture.mjs');
  assert.deepEqual(startOptions('true'), { start: true });
  assert.deepEqual(startOptions(' Retry '), { start: 'retry' });
  for (const v of ['', undefined, 'false', 'nope']) assert.deepEqual(startOptions(v), {}, String(v));
  const lines = summary([
    { slug: 'full', ok: true, files: ['a', 'b', 'c'] },
    { slug: 'menu', ok: true, files: ['a'], partial: true },
    { slug: 'sent', ok: true, skipped: 'uploads' },
    { slug: 'dead', ok: false, reason: 'navigation' },
  ]);
  assert.equal(lines[0], 'captured 2 of 4, 1 with all 3 frames');
  assert.match(lines[1], /^::warning title=Fewer than 3 frames::1 games: menu \(1\)$/);
  assert.equal(summary([{ slug: 'full', ok: true, files: ['a', 'b', 'c'] }]).length, 1, 'no warning when every game is complete');
});
