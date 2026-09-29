#!/usr/bin/env node
// Re-encodes captured PNGs, uploads the variants to R2 and writes out/contact-sheet.md:
//   node scripts/upload.mjs out/ [--dry-run] [--games <dir> | --entries-ref <git ref> [--base-ref <git ref>]]
// Runs in CI's upload job, which holds the R2 token. Everything in out/ came from a job that ran untrusted game
// code, so it is only ever read as bytes: PNGs are decoded by sharp and re-encoded from raw pixels (no metadata, no
// trailing bytes survive), failed.json is parsed as JSON, and nothing from out/ is executed or uploaded as-is.
import { lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import sharp from 'sharp';
import { AwsClient } from 'aws4fetch';
import { createHash } from 'node:crypto';

export const MEDIA_URL = 'https://media.gamesbyai.win';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUCKET = 'gamesbyai-media';
const CACHE_CONTROL = 'public, max-age=604800';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CODE = /^[a-z0-9-]{1,32}$/;
const NAMES = ['cover', 'shot-1', 'shot-2'];
const WIDTHS = [320, 640, 1280];
const MAX_SIDE = 4096;
const MAX_BYTES = 20 * 1024 * 1024;
const TYPES = { avif: 'image/avif', webp: 'image/webp', jpg: 'image/jpeg' };
const isSlug = (s) => typeof s === 'string' && SLUG.test(s);

export class ImageError extends Error {}

// The GamesByAI corner mark on OG images: lime wordmark on a near-black chip.
const MARK_W = 164;
const MARK_H = 38;
const MARK = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${MARK_W}" height="${MARK_H}" viewBox="0 0 ${MARK_W} ${MARK_H}">` +
    `<rect width="${MARK_W}" height="${MARK_H}" rx="7" fill="#0a0b0d"/>` +
    `<text x="${MARK_W / 2}" y="25.5" text-anchor="middle" font-family="DejaVu Sans, Verdana, Arial, sans-serif" font-size="16" font-weight="700" letter-spacing="1.6" fill="#c6ff3d">GAMESBYAI</text>` +
    `</svg>`,
);

/**
 * Validates one capture and returns its variants, keyed by file suffix:
 * -320/-640/-1280 .avif and .webp, plus -og.jpg (1200x630 with the corner mark) when `og` is set.
 */
export async function processImage(buf, { og = false } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new ImageError('empty file');
  if (buf.length > MAX_BYTES) throw new ImageError('file too large');
  let meta;
  try {
    meta = await sharp(buf).metadata();
  } catch {
    throw new ImageError('not an image');
  }
  if (meta.format !== 'png') throw new ImageError(`not a PNG (${meta.format})`);
  if (!(meta.width > 0 && meta.height > 0) || meta.width > MAX_SIDE || meta.height > MAX_SIDE) throw new ImageError(`not within ${MAX_SIDE} px`);

  // Decode once to raw 8-bit sRGB pixels; every output is encoded from these pixels alone.
  let pixels;
  try {
    pixels = await sharp(buf, { failOn: 'error', limitInputPixels: MAX_SIDE * MAX_SIDE })
      .flatten({ background: '#0a0b0d' })
      .toColourspace('srgb')
      .raw({ depth: 'uchar' })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new ImageError('cannot decode');
  }
  const { width, height, channels } = pixels.info;
  const from = () => sharp(pixels.data, { raw: { width, height, channels } });

  const out = {};
  for (const w of WIDTHS) {
    out[`-${w}.avif`] = await from().resize({ width: w, withoutEnlargement: true }).avif({ quality: 55, effort: 4 }).toBuffer();
    out[`-${w}.webp`] = await from().resize({ width: w, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
  }
  if (og) {
    out['-og.jpg'] = await from()
      .resize(1200, 630, { fit: 'cover', position: 'centre' })
      .composite([{ input: MARK, left: 1200 - MARK_W - 24, top: 630 - MARK_H - 24 }])
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
  }
  return out;
}

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;', '|': '&#124;', '[': '&#91;', ']': '&#93;', '\\': '&#92;', '*': '&#42;', '_': '&#95;', '~': '&#126;' };

/**
 * Makes third-party text safe inside a Markdown table cell on GitHub: one line, no HTML, no Markdown syntax,
 * no links, no @mentions or #references (a zero-width space breaks those), no bidi tricks. Capped at `max` characters.
 */
export function escapeText(value, max = 120) {
  let s = String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...s];
  if (chars.length > max) s = chars.slice(0, max - 1).join('').trimEnd() + '…';
  return s
    .replace(/:\/\//g, ':\u200b//')
    .replace(/www\./gi, (m) => `${m.slice(0, 3)}\u200b.`)
    .replace(/[@#]/g, (c) => `${c}\u200b`)
    .replace(/[&<>"'`|[\]\\*_~]/g, (c) => ENTITIES[c]);
}

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const list = (v, sep = ', ') => strings(v).map((x) => escapeText(x, 60)).join(sep) || '—';

function playLink(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return 'invalid URL';
  }
  if (u.protocol !== 'https:' || u.username || u.password) return 'invalid URL';
  const href = u.href.replace(/[()[\]<>|"'`\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  return `[${escapeText(u.hostname, 60)}](${href})`;
}

function jamCell(jam) {
  if (!jam || typeof jam !== 'object') return '—';
  const { rank, entries, placement } = jam;
  if (Number.isInteger(rank) && rank > 0) return Number.isInteger(entries) && entries > 0 ? `${rank} / ${entries}` : String(rank);
  return typeof placement === 'string' ? escapeText(placement, 40) : '—';
}

/**
 * Markdown contact sheet for a PR comment. `entries` are catalog entries (third-party text, all escaped);
 * `problems` maps slug → a short reason code for games without usable captures.
 */
export function contactSheet(entries, baseUrl = MEDIA_URL, { problems = {} } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[a-z0-9._-]+)*$/i.test(base)) throw new Error('baseUrl must be a plain https URL');
  const games = entries.filter((e) => e && typeof e === 'object' && isSlug(e.slug));
  const problemOf = (slug) => (Object.hasOwn(problems, slug) ? (CODE.test(problems[slug]) ? problems[slug] : 'failed') : null);
  const captured = games.filter((e) => !problemOf(e.slug)).length;
  const lines = [
    `### Contact sheet: ${captured} of ${games.length} game${games.length === 1 ? '' : 's'} captured`,
    '',
    'Screenshots were taken in a CI job without secrets and re-encoded before upload. Entry text is shown as plain text.',
    '',
    '| Cover | Game | Made with | Engine | Genres | Jam rank | Embeddable | Flags | Play |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const e of games) {
    const problem = problemOf(e.slug);
    const made = e.made && typeof e.made === 'object' ? e.made : {};
    const models = strings(made.models);
    const cells = [
      problem ? `no capture (${problem})` : `<img src="${base}/games/${e.slug}/cover-320.webp" width="160">`,
      `**${escapeText(typeof e.title === 'string' ? e.title : e.slug, 80)}**<br>\`${e.slug}\``,
      list([...strings(made.tools), ...(models.length ? models : strings(made.providers))]),
      typeof e.tech?.engine === 'string' ? escapeText(e.tech.engine, 60) : '—',
      list(e.genres),
      jamCell(e.jam),
      e.play?.embeddable === true ? 'yes' : 'no',
      list(e.provenance?.flags, '; '),
      playLink(e.play?.url),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  if (!games.length) lines.push('', 'No games in this run.');
  return lines.join('\n') + '\n';
}

function readRegularFile(file, max = MAX_BYTES) {
  const st = lstatSync(file); // lstat: a symlink in the artifact is never followed
  if (!st.isFile()) throw new ImageError('not a regular file');
  if (st.size > max) throw new ImageError('file too large');
  return readFileSync(file);
}

function readFailed(outDir) {
  try {
    const list = JSON.parse(readRegularFile(join(outDir, 'failed.json'), 1 << 20).toString('utf8'));
    return Array.isArray(list) ? list.filter((f) => f && typeof f === 'object') : [];
  } catch {
    return [];
  }
}

function loadEntry(slug, { gamesDir, entriesRef, repoDir }) {
  try {
    const text = entriesRef
      ? // git show prints the blob, so a symlinked entry yields its target path, never the target's content.
        execFileSync('git', ['-C', repoDir, 'show', `${entriesRef}:games/${slug}.yaml`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 20 })
      : readRegularFile(join(gamesDir, `${slug}.yaml`), 1 << 20).toString('utf8');
    const data = parse(text);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * R2's S3 credentials for an R2 API token: the access key id is the token's id, the secret is the SHA-256 of its value.
 * The id comes from Cloudflare's token-verify endpoint (account-owned tokens first, then user tokens).
 */
export async function r2Credentials(token, accountId, fetchImpl = fetch) {
  for (const url of [`https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`, 'https://api.cloudflare.com/client/v4/user/tokens/verify']) {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) continue;
    const id = (await res.json())?.result?.id;
    if (id) return { accessKeyId: id, secretAccessKey: createHash('sha256').update(token).digest('hex') };
  }
  throw new Error('could not verify R2_UPLOAD_TOKEN');
}

/**
 * Uploads one file to R2 through its S3 API (what R2 API tokens are for). Retries server errors and rate limits with
 * backoff; returns { ok, error }.
 */
export async function s3Put(key, file, type, { creds, accountId = process.env.CLOUDFLARE_ACCOUNT_ID, fetchImpl = fetch, attempts = 3, backoffMs = 1000 } = {}) {
  const client = new AwsClient({ accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, service: 's3', region: 'auto' });
  const url = `https://${accountId}.r2.cloudflarestorage.com/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const body = readFileSync(file);
  let error;
  for (let i = 0; i < attempts; i++) {
    try {
      const req = await client.sign(url, { method: 'PUT', headers: { 'Content-Type': type, 'Cache-Control': CACHE_CONTROL }, body });
      const res = await fetchImpl(req);
      if (res.ok) return { ok: true };
      const text = await res.text().catch(() => '');
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? text.slice(0, 120);
      error = new Error(`R2 ${res.status}: ${code}`);
      if (res.status < 500 && res.status !== 429) break; // auth or bad request: retrying won't help
    } catch (e) {
      error = e;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, backoffMs * 2 ** i));
  }
  return { ok: false, error };
}

let credsPromise;
const defaultPut = async (key, file, type) => {
  credsPromise ??= r2Credentials(process.env.R2_UPLOAD_TOKEN, process.env.CLOUDFLARE_ACCOUNT_ID);
  const r = await s3Put(key, file, type, { creds: await credsPromise });
  if (!r.ok) throw r.error;
};

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await Promise.resolve()
        .then(() => fn(items[i]))
        .then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Processes out/<slug>/{cover,shot-1,shot-2}.png for every slug that has an entry, puts the variants
 * (unless dryRun) and writes out/contact-sheet.md. Returns the uploaded keys and a slug → problem map.
 */
export async function runUpload({ outDir, gamesDir = join(ROOT, 'games'), entriesRef, baseRef, repoDir = ROOT, dryRun = false, baseUrl = MEDIA_URL, put = defaultPut, variantsDir, concurrency = 4, log = console.log } = {}) {
  const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
  if (entriesRef !== undefined && !REF.test(entriesRef)) throw new Error('invalid --entries-ref');
  if (baseRef !== undefined && (!REF.test(baseRef) || entriesRef === undefined)) throw new Error('invalid --base-ref (needs --entries-ref)');
  // Only games the PR itself adds or changes: the shots artifact never decides which live game's images get replaced.
  const inPr = baseRef === undefined ? null : new Set(
    execFileSync('git', ['-C', repoDir, 'diff', '--name-only', '--diff-filter=AM', baseRef, entriesRef, '--', 'games/'], { encoding: 'utf8' })
      .split('\n').map((l) => /^games\/([a-z0-9]+(?:-[a-z0-9]+)*)\.yaml$/.exec(l.trim())?.[1]).filter(Boolean),
  );
  rmSync(join(outDir, 'contact-sheet.md'), { force: true }); // never post a sheet we didn't write
  const problems = {};
  for (const f of readFailed(outDir)) if (isSlug(f.slug)) problems[f.slug] = typeof f.reason === 'string' && CODE.test(f.reason) ? f.reason : 'failed';

  const captured = readdirSync(outDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isSlug(d.name))
    .map((d) => d.name)
    .sort();
  const cache = new Map();
  const entryOf = (slug) => {
    if (!cache.has(slug)) cache.set(slug, loadEntry(slug, { gamesDir, entriesRef, repoDir }));
    return cache.get(slug);
  };
  const vdir = variantsDir ?? mkdtempSync(join(tmpdir(), 'gamesbyai-variants-'));
  const uploaded = [];

  for (const slug of captured) {
    delete problems[slug]; // a fresh capture replaces an earlier failure
    if (inPr && !inPr.has(slug)) {
      problems[slug] = 'not-in-pr';
      log(`skip ${slug}: not added or changed by this PR`);
      continue;
    }
    if (!entryOf(slug)) {
      problems[slug] = 'no-entry';
      log(`skip ${slug}: no entry`);
      continue;
    }
    const variants = [];
    // The cover is required; screenshots are uploaded when the capture got them.
    const names = NAMES.filter((name) => name === 'cover' || existsSync(join(outDir, slug, `${name}.png`)));
    try {
      for (const name of names) {
        const out = await processImage(readRegularFile(join(outDir, slug, `${name}.png`)), { og: name === 'cover' });
        for (const [suffix, data] of Object.entries(out)) variants.push({ key: `games/${slug}/${name}${suffix}`, data, type: TYPES[suffix.split('.').pop()] });
      }
    } catch (e) {
      problems[slug] = 'rejected';
      log(`FAIL ${slug}: ${e instanceof ImageError ? e.message : 'unreadable capture'}`);
      continue;
    }
    mkdirSync(join(vdir, slug), { recursive: true });
    for (const v of variants) {
      v.file = join(vdir, slug, v.key.slice(`games/${slug}/`.length));
      writeFileSync(v.file, v.data);
    }
    const results = dryRun ? variants.map(() => ({ ok: true })) : await mapLimit(variants, concurrency, (v) => put(v.key, v.file, v.type));
    variants.forEach((v, i) => results[i].ok && uploaded.push(v.key));
    // The ready marker goes up last and only after every variant: the site links a game's images only when it exists.
    if (results.every((r) => r.ok)) {
      const marker = { key: `games/${slug}/ready.json`, file: join(vdir, slug, 'ready.json'), type: 'application/json' };
      writeFileSync(marker.file, JSON.stringify({ slug, files: variants.length, names }));
      const [res] = dryRun ? [{ ok: true }] : await mapLimit([marker], 1, (v) => put(v.key, v.file, v.type));
      if (res.ok) uploaded.push(marker.key);
      else results.push(res);
    }
    const failedPut = results.find((r) => !r.ok);
    if (failedPut) {
      problems[slug] = 'upload-failed';
      log(`FAIL ${slug}: upload failed (${String(failedPut.error?.message ?? failedPut.error).slice(0, 300)})`);
    } else log(`${dryRun ? 'ready' : 'ok   '} ${slug} (${variants.length} files)`);
  }

  const slugs = [...new Set([...captured, ...Object.keys(problems)])].sort();
  const sheet = contactSheet(
    slugs.map((slug) => ({ ...(entryOf(slug) ?? {}), slug })),
    baseUrl,
    { problems },
  );
  writeFileSync(join(outDir, 'contact-sheet.md'), sheet);
  return { uploaded, problems, variantsDir: vdir, sheet };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const usage = () => {
    console.error('usage: node scripts/upload.mjs <out-dir> [--dry-run] [--games <dir> | --entries-ref <git ref>]');
    process.exit(2);
  };
  const args = process.argv.slice(2);
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') opts.dryRun = true;
    else if (args[i] === '--games') opts.gamesDir = args[++i] ?? usage();
    else if (args[i] === '--entries-ref') opts.entriesRef = args[++i] ?? usage();
    else if (args[i] === '--base-ref') opts.baseRef = args[++i] ?? usage();
    else if (args[i].startsWith('--')) usage();
    else positional.push(args[i]);
  }
  if (positional.length !== 1) usage();
  if (!opts.dryRun) {
    const missing = ['R2_UPLOAD_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'].filter((k) => !process.env[k]);
    if (missing.length) {
      console.error(`missing environment variables: ${missing.join(', ')} (or pass --dry-run)`);
      process.exit(1);
    }
  }
  const res = await runUpload({ outDir: positional[0], ...opts });
  const failed = Object.entries(res.problems);
  console.log(`${res.uploaded.length} files ${opts.dryRun ? 'ready (dry run, nothing uploaded)' : 'uploaded'}; variants in ${res.variantsDir}`);
  if (failed.length) console.log(`problems: ${failed.map(([s, p]) => `${s} (${p})`).join(', ')}`);
  console.log(`contact sheet: ${join(positional[0], 'contact-sheet.md')}`);
  process.exit(failed.some(([, p]) => p === 'upload-failed') ? 1 : 0);
}
