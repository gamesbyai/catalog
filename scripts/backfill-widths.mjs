#!/usr/bin/env node
// Adds the 960 px size to screenshots uploaded before it existed: reads each image's 1280 WebP back from R2 (at the
// marker's version, so never a stale edge-cached copy), writes 960 AVIF and WebP, then rewrites ready.json with
// `widths` last. The new marker time changes the site's image URLs. Idempotent: games that have 960 are skipped.
// CI only (needs the R2 token): .github/workflows/media-backfill.yml
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { MEDIA_URL, WIDTHS, r2Credentials, s3Put } from './upload.mjs';

const NAMES = ['cover', 'shot-1', 'shot-2'];
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** @returns {Promise<'added' | 'done' | 'no-marker'>} */
export async function backfillGame(slug, { fetchImpl = fetch, put, width = 960 }) {
  if (!SLUG.test(slug)) throw new Error('bad slug');
  const r = await fetchImpl(`${MEDIA_URL}/games/${slug}/ready.json`);
  if (r.status === 404) return 'no-marker';
  if (!r.ok) throw new Error(`ready.json for ${slug}: HTTP ${r.status}`);
  const marker = await r.json();
  const widths = Array.isArray(marker.widths) ? marker.widths : [320, 640, 1280];
  if (widths.includes(width)) return 'done';
  const t = Date.parse(r.headers.get('last-modified') ?? '');
  const v = Number.isNaN(t) ? String(Date.now()) : (t / 1000).toString(36);
  const dir = mkdtempSync(join(tmpdir(), `backfill-${slug}-`));
  for (const name of Array.isArray(marker.names) ? marker.names.filter((n) => NAMES.includes(n)) : NAMES) {
    const src = await fetchImpl(`${MEDIA_URL}/games/${slug}/${name}-1280.webp?v=${v}`);
    if (!src.ok) throw new Error(`${slug}/${name}-1280.webp: HTTP ${src.status}`);
    const buf = Buffer.from(await src.arrayBuffer());
    for (const [ext, type, encode] of [
      ['avif', 'image/avif', (s) => s.avif({ quality: 55, effort: 4 })],
      ['webp', 'image/webp', (s) => s.webp({ quality: 80 })],
    ]) {
      const file = join(dir, `${name}-${width}.${ext}`);
      writeFileSync(file, await encode(sharp(buf).resize({ width, withoutEnlargement: true })).toBuffer());
      await put(`games/${slug}/${name}-${width}.${ext}`, file, type);
    }
  }
  const file = join(dir, 'ready.json');
  writeFileSync(file, JSON.stringify({ ...marker, widths: [...new Set([...widths, width])].sort((a, b) => a - b) }));
  await put(`games/${slug}/ready.json`, file, 'application/json');
  return 'added';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const creds = await r2Credentials(process.env.R2_UPLOAD_TOKEN, accountId);
  const put = (key, file, type) => s3Put(key, file, type, { creds, accountId });
  const slugs = readdirSync('games').filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5));
  const counts = {};
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let slug; (slug = slugs[i++]); ) {
      const res = await backfillGame(slug, { put }).catch((e) => `error: ${e.message}`);
      counts[res] = (counts[res] ?? 0) + 1;
      if (res.startsWith('error')) console.log(`${slug}: ${res}`);
    }
  }));
  console.log(JSON.stringify(counts), `(upload sizes now ${WIDTHS.join('/')})`);
  if (Object.keys(counts).some((k) => k.startsWith('error'))) process.exit(1);
}
