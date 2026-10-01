import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { backfillGame } from '../scripts/backfill-widths.mjs';

const png = () => sharp({ create: { width: 1280, height: 720, channels: 3, background: { r: 40, g: 120, b: 200 } } }).webp().toBuffer();

function r2({ marker, lastModified = 'Tue, 29 Sep 2026 18:00:00 GMT' }) {
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    if (url.includes('/ready.json')) return marker ? Response.json(marker, { headers: { 'Last-Modified': lastModified } }) : new Response('', { status: 404 });
    if (url.includes('-1280.webp')) return new Response(await png(), { headers: { 'Content-Type': 'image/webp' } });
    return new Response('', { status: 404 });
  };
  const puts = [];
  const put = async (key, file, type) => puts.push({ key, type, data: readFileSync(file) });
  return { fetchImpl, put, puts, fetched };
}

test('a game without the 960 size gets it for every image, then a marker that lists it', async () => {
  const s = r2({ marker: { slug: 'sky', files: 13, names: ['cover', 'shot-1'] } });
  assert.equal(await backfillGame('sky', { fetchImpl: s.fetchImpl, put: s.put }), 'added');
  assert.deepEqual(s.puts.map((p) => p.key), ['games/sky/cover-960.avif', 'games/sky/cover-960.webp', 'games/sky/shot-1-960.avif', 'games/sky/shot-1-960.webp', 'games/sky/ready.json']);
  assert.equal((await sharp(s.puts[1].data).metadata()).width, 960);
  assert.equal(s.puts[0].type, 'image/avif');
  const marker = JSON.parse(s.puts.at(-1).data.toString());
  assert.deepEqual(marker.widths, [320, 640, 960, 1280]);
  assert.deepEqual(marker.names, ['cover', 'shot-1']);
  // The source image is read at the marker's version, never a stale edge-cached copy.
  assert.ok(s.fetched.some((u) => /cover-1280\.webp\?v=[a-z0-9]+$/.test(u)));
});

test('games that already have it, or have no marker, are left alone', async () => {
  const done = r2({ marker: { names: ['cover'], widths: [320, 640, 960, 1280] } });
  assert.equal(await backfillGame('sky', { fetchImpl: done.fetchImpl, put: done.put }), 'done');
  const none = r2({ marker: null });
  assert.equal(await backfillGame('sky', { fetchImpl: none.fetchImpl, put: none.put }), 'no-marker');
  assert.equal(done.puts.length + none.puts.length, 0);
});

test('a failed upload (s3Put answers ok: false) stops the game before its marker lists the new width', async () => {
  const s = r2({ marker: { slug: 'sky', files: 13, names: ['cover', 'shot-1'] } });
  const keys = [];
  const put = async (key) => (keys.push(key), key.endsWith('shot-1-960.webp') ? { ok: false, error: new Error('R2 403: AccessDenied') } : { ok: true });
  await assert.rejects(backfillGame('sky', { fetchImpl: s.fetchImpl, put }), /shot-1-960\.webp: R2 403/);
  assert.ok(!keys.includes('games/sky/ready.json'), 'the marker is never rewritten after a failed upload');
  const thrower = async (key) => { if (key.endsWith('cover-960.avif')) throw new Error('network'); };
  await assert.rejects(backfillGame('sky', { fetchImpl: s.fetchImpl, put: thrower }), /network/);
});

test('a marker from before names existed covers all three images', async () => {
  const s = r2({ marker: { slug: 'old', files: 19 } });
  await backfillGame('old', { fetchImpl: s.fetchImpl, put: s.put });
  assert.equal(s.puts.filter((p) => p.key.endsWith('.avif')).length, 3);
});
