import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { stringify } from 'yaml';
import { processImage, contactSheet, escapeText, runUpload, s3Put, r2Credentials, sniff, uploadsOf, siteOrigin, fetchUpload, UPLOAD_LIMITS } from '../scripts/upload.mjs';

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
  assert.match(row, /<img src="https:\/\/media\.gamesbyai\.win\/games\/evil-game\/cover-320\.webp\?v=[a-z0-9]+" width="160"/);
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
  // The public sheet shows the games, never review flags.
  assert.doesNotMatch(lines[header], /Flags/);
  assert.ok(!md.includes('injection'));
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
  assert.match(sheet, /games\/good\/cover-320\.webp\?v=[a-z0-9]+"/, 'contact-sheet images carry a version (edge cache)');
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

test('a re-capture run uploads only the games it was asked for', async () => {
  const { out, games } = await fixtureOut();
  const res = await runUpload({ outDir: out, gamesDir: games, only: ['good'], dryRun: true, log: () => {} });
  assert.ok(res.uploaded.includes('games/good/ready.json'));
  assert.equal(res.problems.stray, 'not-in-pr');
  await assert.rejects(runUpload({ outDir: out, gamesDir: games, only: ['../x'], dryRun: true, log: () => {} }), /invalid/);
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

// --- Creators' own screenshots (sent with the site's submit form) ---

const MARK = 'GBAI-METADATA-PAYLOAD-7f3c';
const XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:description="${MARK}"/></rdf:RDF></x:xmpmeta>`;
/** A screenshot as a creator would send it: PNG, JPEG or WebP, with EXIF and XMP metadata. */
async function creatorShot(format = 'jpeg', width = 1920, height = 1080) {
  const img = sharp(await shot(width, height));
  const encoded = format === 'png' ? img.png() : format === 'jpeg' ? img.jpeg({ quality: 90 }) : img.webp({ quality: 90 });
  return encoded.withExif({ IFD0: { ImageDescription: MARK, Copyright: MARK } }).withXmp(XMP).toBuffer();
}

test('magic bytes decide the format: PNG, JPEG and WebP, nothing else', async () => {
  assert.equal(sniff(await shot()), 'png');
  assert.equal(sniff(await creatorShot('jpeg')), 'jpeg');
  assert.equal(sniff(await creatorShot('webp')), 'webp');
  assert.equal(sniff(Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'latin1')), null);
  assert.equal(sniff(Buffer.from('GIF89a')), null);
  assert.equal(sniff(Buffer.from([0xff, 0xd8])), null, 'too short');
  assert.equal(sniff(Buffer.alloc(0)), null);
});

test("a creator's JPEG, WebP or PNG is re-encoded from its pixels: the same variants, and no metadata survives", async () => {
  for (const format of ['jpeg', 'webp', 'png']) {
    const input = await creatorShot(format);
    assert.ok(input.includes(MARK), `the ${format} input carries the metadata`);
    assert.ok((await sharp(input).metadata()).exif, `the ${format} input has EXIF`);
    const out = await processImage(input, { og: true, upload: true });
    assert.deepEqual(Object.keys(out).sort(), ['-1280.avif', '-1280.webp', '-320.avif', '-320.webp', '-640.avif', '-640.webp', '-960.avif', '-960.webp', '-og.jpg'], format);
    for (const [suffix, buf] of Object.entries(out)) {
      assert.ok(!buf.includes(MARK), `${format} ${suffix} carries the metadata`);
      const m = await sharp(buf).metadata();
      assert.equal(m.exif, undefined, `${format} ${suffix} has EXIF`);
      assert.equal(m.xmp, undefined, `${format} ${suffix} has XMP`);
      if (suffix === '-1280.webp') assert.deepEqual([m.width, m.height], [1280, 720]);
      if (suffix === '-og.jpg') assert.deepEqual([m.width, m.height], [1200, 630]);
    }
  }
});

test('JPEG EXIF orientation is applied before validating dimensions and encoding pixels', async () => {
  const orientedJpeg = async (width, height, orientation, pixelAt) => {
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      raw.set(pixelAt(x, y), (y * width + x) * 3);
    }
    return sharp(raw, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 100 })
      .withMetadata({ orientation })
      .toBuffer();
  };

  // Encoded landscape is displayed as too-small portrait after orientation 6.
  const turnedPortrait = await orientedJpeg(1280, 720, 6, () => [40, 80, 120]);
  await assert.rejects(processImage(turnedPortrait, { upload: true }), /smaller than 1280x720/);

  // Encoded portrait becomes a valid landscape screenshot after orientation 6.
  const turnedLandscape = await orientedJpeg(720, 1280, 6, () => [40, 80, 120]);
  const valid = await processImage(turnedLandscape, { upload: true });
  const validMeta = await sharp(valid['-1280.webp']).metadata();
  assert.deepEqual([validMeta.width, validMeta.height], [1280, 720]);

  // Orientation 3 must rotate the pixels too, not only swap dimensions.
  const quadrants = await orientedJpeg(1280, 720, 3, (x, y) => x < 640
    ? (y < 360 ? [240, 20, 20] : [20, 240, 20])
    : (y < 360 ? [20, 20, 240] : [240, 240, 20]));
  const output = await processImage(quadrants, { upload: true });
  const { data, info } = await sharp(output['-1280.webp']).raw().toBuffer({ resolveWithObject: true });
  const sample = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  const near = (actual, expected) => actual.every((v, i) => Math.abs(v - expected[i]) < 40);
  assert.ok(near(sample(100, 100), [240, 240, 20]), `top-left after rotation: ${sample(100, 100)}`);
  assert.ok(near(sample(1180, 100), [20, 240, 20]), `top-right after rotation: ${sample(1180, 100)}`);
  assert.ok(near(sample(100, 620), [20, 20, 240]), `bottom-left after rotation: ${sample(100, 620)}`);
  assert.ok(near(sample(1180, 620), [240, 20, 20]), `bottom-right after rotation: ${sample(1180, 620)}`);
});

test("a creator's screenshot must be landscape, at least 1280x720 and at most 3840 px a side", async () => {
  const plain = (w, h, format = 'png') => sharp(Buffer.alloc(w * h * 3, 90), { raw: { width: w, height: h, channels: 3 } })[format]().toBuffer();
  for (const [w, h, format] of [[1280, 720], [1280, 1280], [3840, 2160, 'jpeg'], [2560, 1440, 'webp']]) {
    const out = await processImage(await plain(w, h, format), { upload: true });
    assert.equal((await sharp(out['-1280.webp']).metadata()).width, 1280, `${w}x${h}`);
  }
  await assert.rejects(processImage(await plain(1279, 720), { upload: true }), /smaller than 1280x720/);
  await assert.rejects(processImage(await plain(1280, 719), { upload: true }), /smaller than 1280x720/);
  await assert.rejects(processImage(await plain(1300, 1400), { upload: true }), /portrait/);
  await assert.rejects(processImage(await plain(3841, 1000), { upload: true }), /3840/);
  // Captures keep their own limits: a small capture is still fine.
  await processImage(await plain(400, 300));
});

test("a creator's screenshot over 3 MB, in another format, or truncated is rejected", async () => {
  const big = withChunk(await shot(), 'tEXt', Buffer.alloc(UPLOAD_LIMITS.maxBytes, 0x61));
  assert.ok(big.length > UPLOAD_LIMITS.maxBytes);
  await assert.rejects(processImage(big, { upload: true }), /too large/);
  assert.equal(UPLOAD_LIMITS.maxBytes, 3 * 1024 * 1024);
  const gif = await sharp(await shot()).gif().toBuffer();
  await assert.rejects(processImage(gif, { upload: true }), /not a PNG, JPEG or WebP \(gif\)/);
  const tiff = await sharp(await shot()).tiff().toBuffer();
  await assert.rejects(processImage(tiff, { upload: true }), /not a PNG, JPEG or WebP \(tiff\)/);
  await assert.rejects(processImage(Buffer.from('<html><script>alert(1)</script></html>'), { upload: true }), /not an image/);
  for (const format of ['jpeg', 'webp', 'png']) {
    const full = await creatorShot(format);
    await assert.rejects(processImage(full.subarray(0, Math.floor(full.length / 2)), { upload: true }), /decode|not an image/, format);
  }
  // A capture is still a PNG only.
  await assert.rejects(processImage(await creatorShot('jpeg')), /not a PNG \(jpeg\)/);
});

test('uploadsOf reads provenance.uploads as data and accepts only { ref: 16 hex, count: 1-3 }', () => {
  const e = (uploads) => ({ provenance: { foundVia: 'form', uploads } });
  assert.deepEqual(uploadsOf(e({ ref: '3f9a0c1e8b7d6a54', count: 2 })), { ref: '3f9a0c1e8b7d6a54', count: 2 });
  for (const bad of [undefined, null, 'x', [], { ref: '3F9A0C1E8B7D6A54', count: 2 }, { ref: '3f9a0c1e8b7d6a5', count: 2 }, { ref: '../../../etc/passwd', count: 1 }, { ref: '3f9a0c1e8b7d6a54', count: 0 }, { ref: '3f9a0c1e8b7d6a54', count: 4 }, { ref: '3f9a0c1e8b7d6a54', count: '2' }, { ref: 3, count: 1 }]) {
    assert.equal(uploadsOf(e(bad)), null, JSON.stringify(bad));
  }
  assert.equal(uploadsOf(null), null);
  assert.equal(uploadsOf({ slug: 'x' }), null);
});

test("the site's origin comes from the notify URL: https only, its path dropped", () => {
  assert.equal(siteOrigin('https://site.example/api/internal/notify'), 'https://site.example');
  assert.equal(siteOrigin('https://site.example:8443/x?y=1'), 'https://site.example:8443');
  for (const bad of ['http://site.example/api/internal/notify', 'https://u:p@site.example/', 'not a url', '', undefined]) assert.equal(siteOrigin(bad), null, String(bad));
});

const REF = '3f9a0c1e8b7d6a54';
const NOTIFY = 'https://site.example/api/internal/notify';
const TOKEN = 'test-token-not-a-secret';

/** The site's internal uploads route, mocked: images[n - 1] for /api/internal/uploads/<ref>/<n>, or a status per n. */
function site(images, { status = {}, calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url, init });
    const m = /^https:\/\/site\.example\/api\/internal\/uploads\/([0-9a-f]{16})\/([1-3])$/.exec(url);
    if (!m || new Headers(init?.headers).get('authorization') !== `Bearer ${TOKEN}`) return new Response('not found', { status: 404 });
    const n = Number(m[2]);
    if (status[n]) return new Response('no', { status: status[n] });
    return images[n - 1] ? new Response(images[n - 1], { headers: { 'content-type': 'image/jpeg' } }) : new Response('not found', { status: 404 });
  };
}

async function sentFixture(count = 3, uploads = { ref: REF, count }) {
  const { root, out, games } = await fixtureOut();
  writeFileSync(join(games, 'sent.yaml'), stringify({ slug: 'sent', title: 'Sent Game', play: { url: 'https://sent.example/' }, provenance: { foundVia: 'form', submittedBy: '#9', uploads } }));
  // A stray capture of the same game is ignored: the creator's screenshots win.
  mkdirSync(join(out, 'sent'));
  writeFileSync(join(out, 'sent', 'cover.png'), 'not an image');
  return { root, out, games };
}

test("the creator's screenshots are fetched with the token and go through the capture pipeline: n=1 cover, n=2 shot-1, n=3 shot-2", async () => {
  const { out, games } = await sentFixture(3);
  const images = [await creatorShot('jpeg'), await creatorShot('webp', 1600, 900), await creatorShot('png', 1280, 720)];
  const calls = [];
  const puts = [];
  const logs = [];
  const res = await runUpload({ outDir: out, gamesDir: games, uploads: ['sent'], notifyUrl: NOTIFY, notifyToken: TOKEN, fetchImpl: site(images, { calls }), put: (key, file, type) => puts.push({ key, file, type }), log: (l) => logs.push(l) });
  assert.deepEqual(calls.map((c) => c.url), [1, 2, 3].map((n) => `https://site.example/api/internal/uploads/${REF}/${n}`));
  for (const c of calls) {
    assert.equal(new Headers(c.init.headers).get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(c.init.redirect, 'error', 'the token never follows a redirect');
  }
  assert.equal(res.problems.sent, undefined);
  const sent = puts.filter((p) => p.key.startsWith('games/sent/'));
  assert.equal(sent.length, 3 * 8 + 1 + 1);
  for (const key of ['games/sent/cover-og.jpg', 'games/sent/cover-320.avif', 'games/sent/shot-1-1280.webp', 'games/sent/shot-2-640.avif']) assert.ok(sent.some((p) => p.key === key), key);
  assert.equal(sent.at(-1).key, 'games/sent/ready.json', 'the ready marker goes up last');
  assert.deepEqual(JSON.parse(readFileSync(sent.at(-1).file, 'utf8')).names, ['cover', 'shot-1', 'shot-2']);
  for (const p of sent) if (!p.key.endsWith('.json')) assert.ok(!readFileSync(p.file).includes(MARK), `${p.key} carries the creator's metadata`);
  // The other games of the run are handled as before.
  assert.ok(puts.some((p) => p.key === 'games/good/ready.json'));
  assert.equal(res.problems.bad, 'rejected');
  const sheet = readFileSync(join(out, 'contact-sheet.md'), 'utf8');
  assert.match(sheet, /games\/sent\/cover-320\.webp\?v=/);
  assert.ok(sheet.includes('Sent Game'));
  assert.ok(!logs.join('\n').includes(TOKEN), 'the token is never logged');
});

test('one screenshot from the creator gives the cover alone', async () => {
  const { out, games } = await sentFixture(1);
  const calls = [];
  const puts = [];
  await runUpload({ outDir: out, gamesDir: games, uploads: ['sent'], notifyUrl: NOTIFY, notifyToken: TOKEN, fetchImpl: site([await creatorShot('webp')], { calls }), put: (key, file) => puts.push({ key, file }), log: () => {} });
  assert.equal(calls.length, 1);
  const sent = puts.filter((p) => p.key.startsWith('games/sent/'));
  assert.ok(!sent.some((p) => p.key.includes('/shot-')));
  assert.deepEqual(JSON.parse(readFileSync(sent.at(-1).file, 'utf8')).names, ['cover']);
});

test("a failed fetch is a problem for that game in the sheet, never a crash, and nothing of it is uploaded", async () => {
  const { out, games } = await sentFixture(3);
  const images = [await creatorShot('jpeg'), await creatorShot('jpeg'), await creatorShot('jpeg')];
  for (const status of [404, 401, 500]) {
    const calls = [];
    const puts = [];
    const logs = [];
    const res = await runUpload({ outDir: out, gamesDir: games, uploads: ['sent'], notifyUrl: NOTIFY, notifyToken: TOKEN, fetchImpl: site(images, { status: { 2: status }, calls }), fetchBackoffMs: 1, put: (key) => puts.push(key), log: (l) => logs.push(l) });
    assert.equal(res.problems.sent, 'fetch-failed', String(status));
    assert.ok(!puts.some((k) => k.startsWith('games/sent/')), String(status));
    assert.ok(puts.includes('games/good/ready.json'), 'the rest of the run goes on');
    assert.ok(readFileSync(join(out, 'contact-sheet.md'), 'utf8').includes('no capture (fetch-failed)'));
    // Client errors are final; server errors are retried.
    assert.equal(calls.filter((c) => c.url.endsWith('/2')).length, status >= 500 ? 3 : 1, String(status));
    assert.match(logs.join('\n'), new RegExp(`screenshot 2 of 3: not fetched \\(HTTP ${status}\\)`));
    assert.ok(!logs.join('\n').includes('site.example'), 'the internal URL is never logged');
  }
  const res = await runUpload({ outDir: out, gamesDir: games, uploads: ['sent'], notifyUrl: NOTIFY, notifyToken: TOKEN, fetchImpl: async () => { throw new TypeError('fetch failed'); }, fetchBackoffMs: 1, put: () => {}, log: () => {} });
  assert.equal(res.problems.sent, 'fetch-failed');
});

test('server errors are retried until the screenshot arrives', async () => {
  const img = await creatorShot('jpeg');
  let n = 0;
  const buf = await fetchUpload(NOTIFY, TOKEN, REF, 1, { fetchImpl: async () => (++n < 3 ? new Response('busy', { status: 503 }) : new Response(img)), backoffMs: 1 });
  assert.equal(n, 3);
  assert.ok(buf.equals(img));
});

test('fetchUpload refuses a bad ref or number without a request, and a body over 3 MB however it is sent', async () => {
  let calls = 0;
  const counting = async () => (calls++, new Response('x'));
  for (const [ref, n] of [['../x', 1], ['3F9A0C1E8B7D6A54', 1], [REF, 0], [REF, 4], [REF, 1.5]]) await assert.rejects(fetchUpload(NOTIFY, TOKEN, ref, n, { fetchImpl: counting }), /invalid request/);
  await assert.rejects(fetchUpload('http://site.example/x', TOKEN, REF, 1, { fetchImpl: counting }), /invalid request/);
  await assert.rejects(fetchUpload(NOTIFY, '', REF, 1, { fetchImpl: counting }), /invalid request/);
  assert.equal(calls, 0);
  const declared = async () => new Response('x', { headers: { 'content-length': String(UPLOAD_LIMITS.maxBytes + 1) } });
  await assert.rejects(fetchUpload(NOTIFY, TOKEN, REF, 1, { fetchImpl: declared }), /too large/);
  const chunk = new Uint8Array(1024 * 1024);
  const streamed = async () => new Response(new ReadableStream({ pull(c) { c.enqueue(chunk); } }));
  await assert.rejects(fetchUpload(NOTIFY, TOKEN, REF, 1, { fetchImpl: streamed }), /too large/);
  // Too large is the image's fault: a rejected game, not a fetch to retry.
  const { out, games } = await sentFixture(1);
  const res = await runUpload({ outDir: out, gamesDir: games, uploads: ['sent'], notifyUrl: NOTIFY, notifyToken: TOKEN, fetchImpl: declared, put: () => {}, log: () => {} });
  assert.equal(res.problems.sent, 'rejected');
});

test("a creator's screenshot that breaks the limits rejects the game", async () => {
  const { out, games } = await sentFixture(2);
  const res = await runUpload({ outDir: out, gamesDir: games, uploads: ['sent'], notifyUrl: NOTIFY, notifyToken: TOKEN, fetchImpl: site([await creatorShot('jpeg'), await creatorShot('jpeg', 1280, 1600)]), put: () => {}, log: () => {} });
  assert.equal(res.problems.sent, 'rejected');
});

test('no fetch without an https notify URL and a token, for a game whose entry names no uploads, or outside the PR', async () => {
  let calls = 0;
  const counting = async () => (calls++, new Response('x'));
  const { out, games } = await sentFixture(2);
  for (const [notifyUrl, notifyToken] of [[undefined, TOKEN], [NOTIFY, undefined], ['http://site.example/api/internal/notify', TOKEN]]) {
    const res = await runUpload({ outDir: out, gamesDir: games, uploads: ['sent'], notifyUrl, notifyToken, fetchImpl: counting, dryRun: true, log: () => {} });
    assert.equal(res.problems.sent, 'fetch-failed');
  }
  const plain = await runUpload({ outDir: out, gamesDir: games, uploads: ['good'], notifyUrl: NOTIFY, notifyToken: TOKEN, fetchImpl: counting, dryRun: true, log: () => {} });
  assert.equal(plain.problems.good, 'no-uploads', 'a game in --uploads whose entry names none');
  const bad = await sentFixture(2, { ref: 'NOT-A-REF', count: 2 });
  assert.equal((await runUpload({ outDir: bad.out, gamesDir: bad.games, uploads: ['sent'], notifyUrl: NOTIFY, notifyToken: TOKEN, fetchImpl: counting, dryRun: true, log: () => {} })).problems.sent, 'no-uploads');
  const other = await runUpload({ outDir: out, gamesDir: games, only: ['good'], uploads: ['sent'], notifyUrl: NOTIFY, notifyToken: TOKEN, fetchImpl: counting, dryRun: true, log: () => {} });
  assert.equal(other.problems.sent, 'not-in-pr');
  assert.equal(calls, 0);
  await assert.rejects(runUpload({ outDir: out, gamesDir: games, uploads: ['../x'], dryRun: true, log: () => {} }), /invalid --uploads/);
});

test("a run with only the creator's screenshots needs no capture artifact", async () => {
  const root = tmp();
  const games = join(root, 'games');
  mkdirSync(games);
  writeFileSync(join(games, 'sent.yaml'), stringify({ slug: 'sent', title: 'Sent', play: { url: 'https://sent.example/' }, provenance: { uploads: { ref: REF, count: 1 } } }));
  const out = join(root, 'out'); // never created: no artifact was downloaded
  const res = await runUpload({ outDir: out, gamesDir: games, uploads: ['sent'], notifyUrl: NOTIFY, notifyToken: TOKEN, fetchImpl: site([await creatorShot('png')]), dryRun: true, log: () => {} });
  assert.deepEqual(res.problems, {});
  assert.ok(res.uploaded.includes('games/sent/ready.json'));
  assert.match(readFileSync(join(out, 'contact-sheet.md'), 'utf8'), /1 of 1 game captured/);
});
