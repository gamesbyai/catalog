import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { processImage, contactSheet, escapeText, runUpload, s3Put, r2Credentials } from '../scripts/upload.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'upload-'));
const shot = (width = 1280, height = 720) =>
  sharp({ create: { width, height, channels: 3, background: '#224466' } })
    .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 3}" fill="#ff8800"/></svg>`) }])
    .png()
    .toBuffer();

// Inserts a PNG chunk right before IEND (the last 12 bytes).
function withChunk(png, type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([png.subarray(0, png.length - 12), len, body, crc, png.subarray(png.length - 12)]);
}

test('a valid PNG gives 320/640/960/1280 AVIF and WebP, plus a 1200x630 JPEG for the cover', async () => {
  const out = await processImage(await shot(), { og: true });
  assert.deepEqual(Object.keys(out).sort(), ['-1280.avif', '-1280.webp', '-320.avif', '-320.webp', '-640.avif', '-640.webp', '-960.avif', '-960.webp', '-og.jpg']);
  for (const [suffix, buf] of Object.entries(out)) {
    const m = await sharp(buf).metadata();
    if (suffix === '-og.jpg') {
      assert.deepEqual([m.format, m.width, m.height], ['jpeg', 1200, 630]);
      continue;
    }
    const [, width, ext] = suffix.match(/^-(\d+)\.(\w+)$/);
    assert.equal(m.width, Number(width));
    assert.equal(m.height, Math.round((Number(width) * 720) / 1280));
    assert.equal(m.format, ext === 'avif' ? 'heif' : 'webp');
    if (ext === 'avif') assert.equal(m.compression, 'av1');
  }
  const plain = await processImage(await shot());
  assert.ok(!('-og.jpg' in plain), 'screenshots get no OG image');
});

test('small captures are never enlarged', async () => {
  const out = await processImage(await shot(400, 300));
  assert.equal((await sharp(out['-1280.webp']).metadata()).width, 400);
});

test('a text file named .png is rejected', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'cover.png'), '<html><script>alert(1)</script></html>');
  await assert.rejects(processImage(readFileSync(join(dir, 'cover.png'))), /not an image/);
});

test('an image that is not a PNG is rejected', async () => {
  const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000' } }).jpeg().toBuffer();
  await assert.rejects(processImage(jpeg), /not a PNG/);
});

test('a PNG wider than 4096 px is rejected', async () => {
  await assert.rejects(processImage(await shot(5000, 100)), /4096/);
});

test('a truncated PNG is rejected', async () => {
  const png = await shot();
  await assert.rejects(processImage(png.subarray(0, Math.floor(png.length / 2))), /decode|not an image/);
});

test('bytes after IEND and text chunks never reach the outputs', async () => {
  const payload = '<html><img src=x onerror=alert(1)></html>';
  const png = withChunk(await shot(), 'tEXt', Buffer.from(`Comment\0${payload}`, 'latin1'));
  const evil = Buffer.concat([png, Buffer.from(payload)]);
  assert.ok(evil.includes(payload));
  const out = await processImage(evil, { og: true });
  for (const [suffix, buf] of Object.entries(out)) {
    assert.ok(!buf.includes('onerror'), `${suffix} carries the payload`);
    assert.ok(!buf.includes('<html>'), `${suffix} carries the payload`);
  }
});

const evilEntry = {
  slug: 'evil-game',
  title: 'Evil | <img src=x onerror=alert(1)> [x](https://e.vil)\n| injected | row |',
  play: { url: 'https://e.vil/play?a=1|2&b=(3)', embeddable: true },
  made: { tools: ['claude-code'], models: ['claude-opus-5-5'] },
  tech: { engine: 'threejs' },
  genres: ['arcade', 'puzzle'],
  jam: { event: 'vibe-jam-2026', rank: 3, entries: 945 },
  provenance: { flags: ['injection: `@everyone` see #1 at www.e.vil'] },
};

test('escapeText neutralises Markdown, HTML, mentions and links', () => {
  const s = escapeText('Evil | <img src=x onerror=alert(1)> [x](https://e.vil) `code` @everyone #1 www.e.vil\nnext\u202eline');
  const text = s.replace(/&#?\w+;/g, ''); // our own entities are fine
  for (const bad of ['|', '<', '>', '[', ']', '`', '\n', '://', '@everyone', '#1', 'www.', '\u202e']) assert.ok(!text.includes(bad), `still contains ${JSON.stringify(bad)}: ${s}`);
  assert.ok(s.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the text itself stays readable');
  assert.equal(escapeText('x'.repeat(300), 80).length, 80);
});

test('contactSheet escapes third-party text and keeps one row per game', () => {
  const md = contactSheet([evilEntry], 'https://media.gamesbyai.win');
  const lines = md.split('\n');
  const header = lines.findIndex((l) => l.startsWith('| Cover'));
  assert.ok(header > 0);
  const cols = lines[header].split('|').length;
  const rows = lines.slice(header + 2).filter((l) => l.startsWith('|'));
  assert.equal(rows.length, 1, md);
  const row = rows[0];
  assert.equal(row.split('|').length, cols, 'no extra table cells');
  assert.ok(row.includes('<img src="https://media.gamesbyai.win/games/evil-game/cover-320.webp" width="160"'));
  assert.ok(!md.includes('<img src=x'));
  assert.ok(!md.includes('[x]('));
  assert.equal(row.split('](').length, 2, 'the play link is the only Markdown link');
  assert.ok(!md.includes('@everyone'));
  assert.ok(row.includes('3 / 945'));
  assert.ok(row.includes('claude-code'));
  assert.ok(row.includes('claude-opus-5-5'));
  assert.ok(row.includes('threejs'));
  assert.ok(row.includes('| yes |'));
  assert.ok(row.includes('[e.vil](https://e.vil/play?a=1%7C2&b=%283%29)'));
});

test('contactSheet shows failures without an image and refuses unsafe play links', () => {
  const md = contactSheet(
    [
      { slug: 'broken', title: 'Broken', play: { url: 'javascript:alert(1)' }, made: { tools: [], models: [], providers: ['openai'] }, genres: ['arcade'] },
      { slug: 'odd', title: 'Odd', play: { url: 'https://odd.example/' }, jam: { event: 'x', placement: 'Top 10' } },
      { slug: 'Not A Slug', title: 'Sneaky' },
    ],
    'https://media.gamesbyai.win',
    { problems: { broken: 'deadline', odd: 'Evil <b>reason</b>' } },
  );
  assert.ok(!md.includes('javascript:'));
  assert.ok(md.includes('no capture (deadline)'));
  assert.ok(md.includes('no capture (failed)'));
  assert.ok(!md.includes('games/broken/cover-320.webp'));
  assert.ok(!md.includes('<b>'));
  assert.ok(md.includes('Top 10'));
  assert.ok(md.includes('openai'));
  assert.ok(!md.includes('Sneaky'), 'entries with an invalid slug are left out');
  assert.ok(md.includes('| no |'));
});

async function fixtureOut() {
  const root = tmp();
  const out = join(root, 'out');
  const games = join(root, 'games');
  mkdirSync(games);
  for (const slug of ['good', 'bad', 'gone']) writeFileSync(join(games, `${slug}.yaml`), `slug: ${slug}\ntitle: ${slug} game\nplay: { url: "https://${slug}.example/" }\n`);
  mkdirSync(join(out, 'good'), { recursive: true });
  mkdirSync(join(out, 'bad'));
  mkdirSync(join(out, 'stray'));
  for (const name of ['cover', 'shot-1', 'shot-2']) writeFileSync(join(out, 'good', `${name}.png`), await shot());
  writeFileSync(join(out, 'bad', 'cover.png'), 'not an image');
  writeFileSync(join(out, 'bad', 'shot-1.png'), await shot());
  writeFileSync(join(out, 'bad', 'shot-2.png'), await shot());
  writeFileSync(join(out, 'stray', 'cover.png'), await shot());
  writeFileSync(join(out, 'failed.json'), JSON.stringify([{ slug: 'gone', reason: 'deadline' }, { slug: '../../x', reason: 'navigation' }]));
  writeFileSync(join(out, 'contact-sheet.md'), 'attacker-made sheet');
  return { root, out, games };
}

test('runUpload --dry-run processes captures, never calls put, and writes our own contact sheet', async () => {
  const { out, games } = await fixtureOut();
  const calls = [];
  const res = await runUpload({ outDir: out, gamesDir: games, dryRun: true, put: (...a) => calls.push(a), log: () => {} });
  assert.equal(calls.length, 0);
  assert.equal(res.uploaded.length, 3 * 8 + 1 + 1);
  assert.ok(res.uploaded.includes('games/good/cover-og.jpg'));
  assert.ok(res.uploaded.includes('games/good/shot-2-640.avif'));
  assert.ok(!res.uploaded.some((k) => k.startsWith('games/bad/') || k.startsWith('games/stray/')));
  assert.deepEqual(res.problems, { bad: 'rejected', gone: 'deadline', stray: 'no-entry' });
  const sheet = readFileSync(join(out, 'contact-sheet.md'), 'utf8');
  assert.ok(!sheet.includes('attacker'));
  assert.ok(sheet.includes('games/good/cover-320.webp'));
  assert.ok(sheet.includes('no capture (rejected)'));
  assert.ok(sheet.includes('no capture (deadline)'));
  assert.ok(existsSync(join(res.variantsDir, 'good', 'cover-og.jpg')));
});

test('runUpload puts every variant under games/<slug>/ with its content type', async () => {
  const { out, games } = await fixtureOut();
  const calls = [];
  const res = await runUpload({ outDir: out, gamesDir: games, put: (key, file, type) => calls.push({ key, file, type }), log: () => {} });
  assert.equal(calls.length, 26);
  assert.deepEqual(calls.map((c) => c.key), res.uploaded);
  // The ready marker goes up last, so the site never links a half-uploaded game.
  assert.equal(calls.at(-1).key, 'games/good/ready.json');
  assert.equal(calls.at(-1).type, 'application/json');
  const byKey = Object.fromEntries(calls.map((c) => [c.key, c]));
  assert.equal(byKey['games/good/cover-320.avif'].type, 'image/avif');
  assert.equal(byKey['games/good/shot-1-1280.webp'].type, 'image/webp');
  assert.equal(byKey['games/good/cover-og.jpg'].type, 'image/jpeg');
  assert.equal((await sharp(readFileSync(byKey['games/good/cover-og.jpg'].file)).metadata()).width, 1200);
});

test('runUpload marks a game whose upload fails and keeps going', async () => {
  const { out, games } = await fixtureOut();
  const res = await runUpload({ outDir: out, gamesDir: games, put: () => { throw new Error('r2 said no'); }, log: () => {} });
  assert.equal(res.problems.good, 'upload-failed');
  assert.ok(readFileSync(join(out, 'contact-sheet.md'), 'utf8').includes('no capture (upload-failed)'));
});

test('no ready marker when any variant fails to upload', async () => {
  const { out, games } = await fixtureOut();
  const keys = [];
  await runUpload({ outDir: out, gamesDir: games, put: (key) => { keys.push(key); if (key.endsWith('shot-2-1280.avif')) throw new Error('r2 said no'); }, log: () => {} });
  assert.ok(!keys.includes('games/good/ready.json'));
});

test('runUpload can read entries from a git ref instead of the working tree', async () => {
  const { root, out } = await fixtureOut();
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'games'), { recursive: true });
  writeFileSync(join(repo, 'games', 'good.yaml'), 'slug: good\ntitle: Good From Git\nplay: { url: "https://good.example/" }\n');
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'entries');
  const res = await runUpload({ outDir: out, repoDir: repo, entriesRef: 'HEAD', dryRun: true, log: () => {} });
  assert.equal(res.problems.bad, 'no-entry');
  assert.ok(readFileSync(join(out, 'contact-sheet.md'), 'utf8').includes('Good From Git'));
});

test('with a base ref, only games the PR adds or changes are uploaded; captures of other live games are refused', async () => {
  const { root, out } = await fixtureOut();
  const repo = join(root, 'repo2');
  mkdirSync(join(repo, 'games'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
  writeFileSync(join(repo, 'games', 'stray.yaml'), 'slug: stray\ntitle: Live Game\nplay: { url: "https://stray.example/" }\n');
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'main');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'games', 'good.yaml'), 'slug: good\ntitle: Good\nplay: { url: "https://good.example/" }\n');
  git('add', '.');
  git('commit', '-qm', 'pr');
  const res = await runUpload({ outDir: out, repoDir: repo, entriesRef: 'HEAD', baseRef: base, dryRun: true, log: () => {} });
  assert.ok(res.uploaded.includes('games/good/ready.json'));
  assert.ok(!res.uploaded.some((k) => k.startsWith('games/stray/')));
  assert.equal(res.problems.stray, 'not-in-pr');
});

test('R2 S3 credentials come from the R2 token: its id and the SHA-256 of its value', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return url.includes('/accounts/acc/tokens/verify') ? Response.json({ success: true, result: { id: 'tok-id', status: 'active' } }) : new Response('', { status: 404 });
  };
  const c = await r2Credentials('secret-token', 'acc', fetchImpl);
  assert.equal(c.accessKeyId, 'tok-id');
  const { createHash } = await import('node:crypto');
  assert.equal(c.secretAccessKey, createHash('sha256').update('secret-token').digest('hex'));
});

test('s3Put signs a PUT to the account R2 endpoint with type and cache headers, retrying server errors', async () => {
  const dir = tmp();
  const file = join(dir, 'x.webp');
  writeFileSync(file, 'data');
  const seen = [];
  let n = 0;
  const fetchImpl = async (req) => {
    seen.push(req);
    return ++n < 3 ? new Response('busy', { status: 503 }) : new Response('', { status: 200 });
  };
  const r = await s3Put('games/a/cover-640.webp', file, 'image/webp', { creds: { accessKeyId: 'id', secretAccessKey: 'k' }, accountId: 'acc', fetchImpl, backoffMs: 1 });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 3);
  assert.equal(seen[0].method, 'PUT');
  assert.equal(seen[0].url, 'https://acc.r2.cloudflarestorage.com/gamesbyai-media/games/a/cover-640.webp');
  assert.equal(seen[0].headers.get('content-type'), 'image/webp');
  assert.match(seen[0].headers.get('cache-control'), /max-age=604800/);
  assert.match(seen[0].headers.get('authorization'), /^AWS4-HMAC-SHA256 Credential=id\//);
});

test('s3Put reports a clear error after a permanent failure', async () => {
  const dir = tmp();
  const file = join(dir, 'x.webp');
  writeFileSync(file, 'data');
  const r = await s3Put('games/a/x.webp', file, 'image/webp', { creds: { accessKeyId: 'id', secretAccessKey: 'k' }, accountId: 'acc', fetchImpl: async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }), backoffMs: 1 });
  assert.equal(r.ok, false);
  assert.match(String(r.error.message), /403.*AccessDenied/);
});

test('a partial capture (cover only) is uploaded, and ready.json lists what exists', async () => {
  const root = tmp();
  const out = join(root, 'out');
  const games = join(root, 'games');
  mkdirSync(games);
  writeFileSync(join(games, 'part.yaml'), 'slug: part\ntitle: Part\nplay: { url: "https://part.example.com/" }\n');
  mkdirSync(join(out, 'part'), { recursive: true });
  writeFileSync(join(out, 'part', 'cover.png'), await shot());
  const puts = [];
  const res = await runUpload({ outDir: out, gamesDir: games, put: (key, file) => puts.push({ key, file }), log: () => {} });
  assert.deepEqual(res.problems, {});
  assert.ok(puts.some((p) => p.key === 'games/part/cover-640.webp'));
  assert.ok(!puts.some((p) => p.key.startsWith('games/part/shot-')));
  const marker = puts.find((p) => p.key === 'games/part/ready.json');
  assert.deepEqual(JSON.parse(readFileSync(marker.file, 'utf8')).names, ['cover']);
  assert.deepEqual(JSON.parse(readFileSync(marker.file, 'utf8')).widths, [320, 640, 960, 1280]);
});
