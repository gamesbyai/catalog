#!/usr/bin/env node
// Re-encodes captured PNGs and creators' own screenshots, uploads the variants to R2 and writes out/contact-sheet.md:
//   node scripts/upload.mjs out/ [--dry-run] [--games <dir> | --entries-ref <git ref> [--base-ref <git ref>]] [--uploads <slugs>]
// Runs in CI's upload job, which holds the R2 token. Everything in out/ came from a job that ran untrusted game
// code, so it is only ever read as bytes: PNGs are decoded by sharp and re-encoded from raw pixels (no metadata, no
// trailing bytes survive), failed.json is parsed as JSON, and nothing from out/ is executed or uploaded as-is.
// Games in --uploads whose entry names the creator's screenshots (provenance.uploads, from the site's submit form) get
// those instead: fetched from the site's internal route (NOTIFY_URL's origin, INTERNAL_NOTIFY_TOKEN), held in memory
// only, and decoded and re-encoded the same way.
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
// 960 serves phones (about 720 device pixels wide at 1.75x) without the 1280 download.
export const WIDTHS = [320, 640, 960, 1280];
const MAX_SIDE = 4096;
const MAX_BYTES = 20 * 1024 * 1024;
// A creator's screenshots: the limits the site's submit form enforces too.
export const UPLOAD_LIMITS = { maxBytes: 3 * 1024 * 1024, minWidth: 1280, minHeight: 720, maxSide: 3840 };
const UPLOAD_FORMATS = ['png', 'jpeg', 'webp'];
const UPLOAD_REF = /^[0-9a-f]{16}$/;
const TYPES = { avif: 'image/avif', webp: 'image/webp', jpg: 'image/jpeg' };
const isSlug = (s) => typeof s === 'string' && SLUG.test(s);

export class ImageError extends Error {}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The image format by its magic bytes (never by a name or a declared type): 'png', 'jpeg', 'webp' or null. */
export function sniff(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** The creator's screenshots an entry names ({ ref, count }, from the site's submit form), or null. */
export function uploadsOf(entry) {
  const u = entry && typeof entry === 'object' ? entry.provenance?.uploads : undefined;
  if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
  return typeof u.ref === 'string' && UPLOAD_REF.test(u.ref) && Number.isInteger(u.count) && u.count >= 1 && u.count <= 3 ? { ref: u.ref, count: u.count } : null;
}

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
 * -320/-640/-960/-1280 .avif and .webp, plus -og.jpg (1200x630 with the corner mark) when `og` is set.
 * A capture is a PNG; a creator's screenshot (`upload`) is a PNG, JPEG or WebP within UPLOAD_LIMITS, landscape.
 */
export async function processImage(buf, { og = false, upload = false } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new ImageError('empty file');
  const maxSide = upload ? UPLOAD_LIMITS.maxSide : MAX_SIDE;
  if (buf.length > (upload ? UPLOAD_LIMITS.maxBytes : MAX_BYTES)) throw new ImageError('file too large');
  let meta;
  try {
    meta = await sharp(buf).metadata();
  } catch {
    throw new ImageError('not an image');
  }
  // The magic bytes and sharp's own sniffing must agree on an allowed format.
  const formats = upload ? UPLOAD_FORMATS : ['png'];
  if (!formats.includes(meta.format) || sniff(buf) !== meta.format) throw new ImageError(`not a ${upload ? 'PNG, JPEG or WebP' : 'PNG'} (${meta.format})`);
  if (!(meta.width > 0 && meta.height > 0) || meta.width > maxSide || meta.height > maxSide) throw new ImageError(`not within ${maxSide} px`);
  if (upload && (meta.width < UPLOAD_LIMITS.minWidth || meta.height < UPLOAD_LIMITS.minHeight)) throw new ImageError(`smaller than ${UPLOAD_LIMITS.minWidth}x${UPLOAD_LIMITS.minHeight}`);
  if (upload && meta.width < meta.height) throw new ImageError('portrait');

  // Decode once to raw 8-bit sRGB pixels; every output is encoded from these pixels alone.
  let pixels;
  try {
    pixels = await sharp(buf, { failOn: 'error', limitInputPixels: maxSide * maxSide })
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
export function contactSheet(entries, baseUrl = MEDIA_URL, { problems = {}, version = Date.now().toString(36) } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[a-z0-9._-]+)*$/i.test(base)) throw new Error('baseUrl must be a plain https URL');
  const games = entries.filter((e) => e && typeof e === 'object' && isSlug(e.slug));
  const problemOf = (slug) => (Object.hasOwn(problems, slug) ? (CODE.test(problems[slug]) ? problems[slug] : 'failed') : null);
  const captured = games.filter((e) => !problemOf(e.slug)).length;
  const lines = [
    `### Contact sheet: ${captured} of ${games.length} game${games.length === 1 ? '' : 's'} captured`,
    '',
    'Entry text is shown as plain text.',
    '',
    '| Cover | Game | Made with | Engine | Genres | Jam rank | Embeddable | Play |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const e of games) {
    const problem = problemOf(e.slug);
    const made = e.made && typeof e.made === 'object' ? e.made : {};
    const models = strings(made.models);
    const cells = [
      // Versioned: the same URL may be edge-cached from an earlier capture.
      problem ? `no capture (${problem})` : `<img src="${base}/games/${e.slug}/cover-320.webp?v=${version}" width="160">`,
      `**${escapeText(typeof e.title === 'string' ? e.title : e.slug, 80)}**<br>\`${e.slug}\``,
      list([...strings(made.tools), ...(models.length ? models : strings(made.providers))]),
      typeof e.tech?.engine === 'string' ? escapeText(e.tech.engine, 60) : '—',
      list(e.genres),
      jamCell(e.jam),
      e.play?.embeddable === true ? 'yes' : 'no',
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

/** The site's origin from NOTIFY_URL (its internal notify endpoint): https only, the path dropped. Null otherwise. */
export function siteOrigin(notifyUrl) {
  let u;
  try {
    u = new URL(String(notifyUrl ?? ''));
  } catch {
    return null;
  }
  return u.protocol === 'https:' && !u.username && !u.password ? u.origin : null;
}

/** A response body as a Buffer, refused as soon as it grows past `max` bytes. */
async function readCapped(res, max) {
  if (Number(res.headers.get('content-length')) > max) throw new ImageError('file too large');
  const chunks = [];
  let size = 0;
  if (res.body) {
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > max) throw new ImageError('file too large'); // leaving the loop cancels the stream
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Fetches screenshot `n` (1-3) of a creator's upload `ref` from the site's internal route. The bytes are untrusted:
 * returned as a Buffer for processImage, never executed or saved as they are. Retries server errors, rate limits and
 * network errors with backoff; throws an Error whose message is safe to log (no URL, no token).
 */
export async function fetchUpload(site, token, ref, n, { fetchImpl = fetch, attempts = 3, backoffMs = 1000, timeoutMs = 30_000 } = {}) {
  const origin = siteOrigin(site);
  if (!origin || !token || !UPLOAD_REF.test(String(ref)) || !(Number.isInteger(n) && n >= 1 && n <= 3)) throw new Error('invalid request');
  const url = `${origin}/api/internal/uploads/${ref}/${n}`;
  let error;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return await readCapped(res, UPLOAD_LIMITS.maxBytes);
      await res.body?.cancel().catch(() => {});
      error = new Error(`HTTP ${res.status}`);
      if (res.status < 500 && res.status !== 429) break; // not found or not allowed: retrying won't help
    } catch (e) {
      if (e instanceof ImageError) throw e;
      error = new Error(e?.name === 'TimeoutError' ? 'timed out' : 'network error');
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, backoffMs * 2 ** i));
  }
  throw error;
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
 * Processes out/<slug>/{cover,shot-1,shot-2}.png for every slug that has an entry, and the creator's screenshots
 * (fetched from `notifyUrl`'s origin with `notifyToken`) for every slug in `uploads` whose entry names them: n=1 is the
 * cover, n=2 shot-1, n=3 shot-2. Puts the variants (unless dryRun) and writes out/contact-sheet.md. Returns the
 * uploaded keys and a slug → problem map.
 */
export async function runUpload({ outDir, gamesDir = join(ROOT, 'games'), entriesRef, baseRef, only, uploads = [], notifyUrl, notifyToken, fetchImpl = fetch, fetchBackoffMs = 1000, repoDir = ROOT, dryRun = false, baseUrl = MEDIA_URL, put = defaultPut, variantsDir, concurrency = 4, log = console.log } = {}) {
  if (only !== undefined && (!Array.isArray(only) || !only.every(isSlug))) throw new Error('invalid --only');
  if (!Array.isArray(uploads) || !uploads.every(isSlug)) throw new Error('invalid --uploads');
  const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
  if (entriesRef !== undefined && !REF.test(entriesRef)) throw new Error('invalid --entries-ref');
  if (baseRef !== undefined && (!REF.test(baseRef) || entriesRef === undefined)) throw new Error('invalid --base-ref (needs --entries-ref)');
  // Only games the PR itself adds or changes: the shots artifact never decides which live game's images get replaced.
  // A manual re-capture names its games (--only); a PR run allows what the PR adds or changes (--base-ref).
  const inPr = only ? new Set(only) : baseRef === undefined ? null : new Set(
    execFileSync('git', ['-C', repoDir, 'diff', '--name-only', '--diff-filter=AM', baseRef, entriesRef, '--', 'games/'], { encoding: 'utf8' })
      .split('\n').map((l) => /^games\/([a-z0-9]+(?:-[a-z0-9]+)*)\.yaml$/.exec(l.trim())?.[1]).filter(Boolean),
  );
  mkdirSync(outDir, { recursive: true }); // a run with only creators' screenshots has no capture artifact
  rmSync(join(outDir, 'contact-sheet.md'), { force: true }); // never post a sheet we didn't write
  const problems = {};
  for (const f of readFailed(outDir)) if (isSlug(f.slug)) problems[f.slug] = typeof f.reason === 'string' && CODE.test(f.reason) ? f.reason : 'failed';

  const fromCreator = new Set(uploads);
  const captured = readdirSync(outDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isSlug(d.name))
    .map((d) => d.name);
  const cache = new Map();
  const entryOf = (slug) => {
    if (!cache.has(slug)) cache.set(slug, loadEntry(slug, { gamesDir, entriesRef, repoDir }));
    return cache.get(slug);
  };
  const vdir = variantsDir ?? mkdtempSync(join(tmpdir(), 'gamesbyai-variants-'));
  const uploaded = [];

  for (const slug of [...new Set([...captured, ...fromCreator])].sort()) {
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
    // [name, read] per image, the cover first; read() returns its bytes.
    const upload = fromCreator.has(slug);
    let frames;
    if (upload) {
      // The creator's screenshots replace any capture of this game.
      const sent = uploadsOf(entryOf(slug));
      if (!sent) {
        problems[slug] = 'no-uploads';
        log(`skip ${slug}: the entry names no screenshots from its creator`);
        continue;
      }
      if (!siteOrigin(notifyUrl) || !notifyToken) {
        problems[slug] = 'fetch-failed';
        log(`FAIL ${slug}: NOTIFY_URL (https) and INTERNAL_NOTIFY_TOKEN are needed to fetch the creator's screenshots`);
        continue;
      }
      frames = [];
      try {
        for (let n = 1; n <= sent.count; n++) {
          const bytes = await fetchUpload(notifyUrl, notifyToken, sent.ref, n, { fetchImpl, backoffMs: fetchBackoffMs });
          frames.push([NAMES[n - 1], () => bytes]);
        }
      } catch (e) {
        problems[slug] = e instanceof ImageError ? 'rejected' : 'fetch-failed';
        log(`FAIL ${slug}: creator's screenshot ${frames.length + 1} of ${sent.count}: ${e instanceof ImageError ? e.message : `not fetched (${e.message})`}`);
        continue;
      }
    } else {
      // The cover is required; screenshots are uploaded when the capture got them.
      frames = NAMES.filter((name) => name === 'cover' || existsSync(join(outDir, slug, `${name}.png`))).map((name) => [name, () => readRegularFile(join(outDir, slug, `${name}.png`))]);
    }
    const names = frames.map(([name]) => name);
    const variants = [];
    try {
      for (const [name, read] of frames) {
        const out = await processImage(read(), { og: name === 'cover', upload });
        for (const [suffix, data] of Object.entries(out)) variants.push({ key: `games/${slug}/${name}${suffix}`, data, type: TYPES[suffix.split('.').pop()] });
      }
    } catch (e) {
      problems[slug] = 'rejected';
      log(`FAIL ${slug}: ${e instanceof ImageError ? e.message : upload ? "unreadable creator's screenshot" : 'unreadable capture'}`);
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
      writeFileSync(marker.file, JSON.stringify({ slug, files: variants.length, names, widths: WIDTHS }));
      const [res] = dryRun ? [{ ok: true }] : await mapLimit([marker], 1, (v) => put(v.key, v.file, v.type));
      if (res.ok) uploaded.push(marker.key);
      else results.push(res);
    }
    const failedPut = results.find((r) => !r.ok);
    if (failedPut) {
      problems[slug] = 'upload-failed';
      log(`FAIL ${slug}: upload failed (${String(failedPut.error?.message ?? failedPut.error).slice(0, 300)})`);
    } else log(`${dryRun ? 'ready' : 'ok   '} ${slug} (${variants.length} files${upload ? ", the creator's screenshots" : ''})`);
  }

  const slugs = [...new Set([...captured, ...fromCreator, ...Object.keys(problems)])].sort();
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
    console.error('usage: node scripts/upload.mjs <out-dir> [--dry-run] [--games <dir> | --entries-ref <git ref>] [--uploads <slugs>]');
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
    else if (args[i] === '--only') opts.only = (args[++i] ?? usage()).split(/[\s,]+/).filter(Boolean);
    else if (args[i] === '--uploads') opts.uploads = (args[++i] ?? usage()).split(/[\s,]+/).filter(Boolean);
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
  // Without these, games with the creator's screenshots are listed as problems (fetch-failed), never a crash.
  const res = await runUpload({ outDir: positional[0], ...opts, notifyUrl: process.env.NOTIFY_URL, notifyToken: process.env.INTERNAL_NOTIFY_TOKEN });
  const failed = Object.entries(res.problems);
  console.log(`${res.uploaded.length} files ${opts.dryRun ? 'ready (dry run, nothing uploaded)' : 'uploaded'}; variants in ${res.variantsDir}`);
  if (failed.length) console.log(`problems: ${failed.map(([s, p]) => `${s} (${p})`).join(', ')}`);
  console.log(`contact sheet: ${join(positional[0], 'contact-sheet.md')}`);
  process.exit(failed.some(([, p]) => p === 'upload-failed') ? 1 : 0);
}
