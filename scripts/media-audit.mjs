#!/usr/bin/env node
// Checks every entry's images on our media host, so missing screenshots or sizes never go unnoticed again:
//   node scripts/media-audit.mjs [--json <file>] [--summary <file>] [--max-without-shots <percent>]
// Read-only and needs no secrets: GETs each game's ready.json and HEADs every variant it names
// (.github/workflows/media-audit.yml runs it weekly). Errors, which fail the run:
//   broken      ready.json names an image or size whose file is missing: a broken image on the site
//   no-marker   a listed game has no ready.json: its page shows placeholder art
//   unreachable the media host did not answer
// Warnings: screenshots the entry lists but the capture never kept (the page shows fewer), and markers without every
// upload size (media-backfill.yml adds them). With --max-without-shots, the run also fails when more than that share
// of live games show no screenshot at all.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { MEDIA_URL, WIDTHS } from './upload.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NAMES = ['cover', 'shot-1', 'shot-2'];
const ORIGINAL_WIDTHS = [320, 640, 1280]; // markers written before `widths` existed
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** File suffixes of one image at the given widths: AVIF and WebP per width, plus the OG JPEG for the cover. */
export const variants = (name, widths) => [...widths.flatMap((w) => [`-${w}.avif`, `-${w}.webp`]), ...(name === 'cover' ? ['-og.jpg'] : [])];

async function answer(fetchImpl, url, init, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
      if (res.status < 500 && res.status !== 429) return res;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e?.name === 'TimeoutError' ? 'timed out' : 'network error';
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
  }
  throw new Error(last);
}

/**
 * One entry's images: what the entry lists, what ready.json says went up, and which of those files answer.
 * @returns {Promise<{ slug, status, marker: 'ok' | 'missing' | 'unreachable', listed: string[], live: string[], widths: number[], broken: string[], missingShots: string[], missingWidths: number[], error?: string }>}
 */
export async function auditGame(entry, { fetchImpl = fetch, mediaUrl = MEDIA_URL } = {}) {
  const slug = entry.slug;
  const keys = [entry.media?.cover, ...(Array.isArray(entry.media?.screenshots) ? entry.media.screenshots : [])].filter((k) => typeof k === 'string');
  // Only our own captures (games/<slug>/<name>); other keys are not ours to check.
  const listed = keys.filter((k) => k.startsWith(`games/${slug}/`)).map((k) => k.slice(`games/${slug}/`.length)).filter((n) => NAMES.includes(n));
  const row = { slug, status: entry.status ?? 'live', marker: 'ok', listed, live: [], widths: [], broken: [], missingShots: [], missingWidths: [] };
  if (!listed.length) return row;
  let res;
  try {
    res = await answer(fetchImpl, `${mediaUrl}/games/${slug}/ready.json?audit=${Date.now().toString(36)}`, { method: 'GET' });
  } catch (e) {
    return { ...row, marker: 'unreachable', error: e.message };
  }
  if (res.status === 404) return { ...row, marker: 'missing' };
  if (!res.ok) return { ...row, marker: 'unreachable', error: `HTTP ${res.status}` };
  const body = await res.json().catch(() => ({}));
  const live = Array.isArray(body?.names) ? body.names.filter((n) => NAMES.includes(n)) : [...NAMES];
  const widths = Array.isArray(body?.widths) && body.widths.every((w) => Number.isInteger(w) && w > 0 && w <= 4096) ? body.widths : ORIGINAL_WIDTHS;
  row.live = live;
  row.widths = widths;
  row.missingShots = listed.filter((n) => n !== 'cover' && !live.includes(n));
  row.missingWidths = WIDTHS.filter((w) => !widths.includes(w));
  // What the site links: every listed image ready.json names, at every width it lists.
  for (const name of listed.filter((n) => live.includes(n))) {
    for (const suffix of variants(name, widths)) {
      const key = `games/${slug}/${name}${suffix}`;
      try {
        const r = await answer(fetchImpl, `${mediaUrl}/${key}`, { method: 'HEAD' });
        if (r.status !== 200) row.broken.push(key);
      } catch (e) {
        return { ...row, marker: 'unreachable', error: `${key}: ${e.message}` };
      }
    }
  }
  return row;
}

/** Audits every entry, `concurrency` at a time, in slug order. */
export async function auditAll(entries, { concurrency = 12, ...opts } = {}) {
  const rows = new Array(entries.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    for (let i; (i = next++) < entries.length; ) rows[i] = await auditGame(entries[i], opts);
  }));
  return rows.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Groups, counts and the lines to print, plus whether the run fails. */
export function report(rows, { maxWithoutShots } = {}) {
  const listed = rows.filter((r) => r.listed.length);
  const live = listed.filter((r) => r.status === 'live');
  const groups = {
    broken: listed.filter((r) => r.broken.length),
    noMarker: listed.filter((r) => r.marker === 'missing' && r.status === 'live'),
    unreachable: listed.filter((r) => r.marker === 'unreachable'),
    withoutShots: live.filter((r) => r.marker === 'ok' && r.listed.some((n) => n !== 'cover') && r.missingShots.length === r.listed.filter((n) => n !== 'cover').length),
    fewerShots: live.filter((r) => r.marker === 'ok' && r.missingShots.length),
    missingWidths: listed.filter((r) => r.marker === 'ok' && r.missingWidths.length),
  };
  const share = live.length ? groups.withoutShots.length / live.length : 0;
  const tooMany = maxWithoutShots !== undefined && share * 100 > maxWithoutShots;
  const names = (list, f = (r) => r.slug) => list.map(f).join(' ');
  const lines = [
    `media: ${listed.length} games, ${live.length} live; ${groups.broken.length} with broken files, ${groups.noMarker.length} without ready.json, ${groups.unreachable.length} unreachable`,
    `screenshots: ${groups.withoutShots.length} live games show none (${(share * 100).toFixed(0)}%), ${groups.fewerShots.length} show fewer than listed; ${groups.missingWidths.length} games lack a size (${WIDTHS.join('/')})`,
  ];
  if (groups.broken.length) lines.push(`::error title=Broken media::${groups.broken.length} games: ${names(groups.broken, (r) => `${r.slug} (${r.broken.length} files)`)}`);
  if (groups.noMarker.length) lines.push(`::error title=No ready.json::${groups.noMarker.length} live games: ${names(groups.noMarker)}`);
  if (groups.unreachable.length) lines.push(`::error title=Media host unreachable::${groups.unreachable.length} games: ${names(groups.unreachable)}`);
  if (groups.fewerShots.length) lines.push(`::warning title=Fewer screenshots than listed::${groups.fewerShots.length} games (re-capture with the start step): ${names(groups.fewerShots)}`);
  if (groups.missingWidths.length) lines.push(`::warning title=Missing sizes::${groups.missingWidths.length} games (run media-backfill): ${names(groups.missingWidths)}`);
  if (tooMany) lines.push(`::error title=Too many games without screenshots::${(share * 100).toFixed(0)}% of live games show no screenshot (limit ${maxWithoutShots}%)`);
  const failed = Boolean(groups.broken.length || groups.noMarker.length || groups.unreachable.length || tooMany);
  return { groups, lines, failed };
}

/** A Markdown table for the run summary: one row per game with a problem. */
export function summaryTable(rows) {
  const bad = rows.filter((r) => r.listed.length && (r.broken.length || r.marker !== 'ok' || r.missingShots.length || r.missingWidths.length));
  const out = ['| Game | Status | Live images | Missing screenshots | Missing sizes | Broken files |', '| --- | --- | --- | --- | --- | --- |'];
  for (const r of bad) out.push(`| \`${r.slug}\` | ${r.status} | ${r.marker === 'ok' ? r.live.join(', ') : r.marker} | ${r.missingShots.join(', ') || '—'} | ${r.missingWidths.join(', ') || '—'} | ${r.broken.length || '—'} |`);
  return `### Media audit\n\n${bad.length ? out.join('\n') : 'Every listed image is live.'}\n`;
}

/** Entries from games/*.yaml (read as data; a file that doesn't parse is skipped and reported). */
export function readEntries(dir = join(ROOT, 'games')) {
  const entries = [];
  const unreadable = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
    try {
      const e = parse(readFileSync(join(dir, f), 'utf8'));
      if (e && typeof e === 'object' && SLUG.test(e.slug ?? '')) entries.push(e);
      else unreadable.push(f);
    } catch {
      unreadable.push(f);
    }
  }
  return { entries, unreadable };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const usage = () => {
    console.error('usage: node scripts/media-audit.mjs [--json <file>] [--summary <file>] [--max-without-shots <percent>]');
    process.exit(2);
  };
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') opts.json = args[++i] ?? usage();
    else if (args[i] === '--summary') opts.summary = args[++i] ?? usage();
    else if (args[i] === '--max-without-shots') {
      const n = Number(args[++i]);
      opts.maxWithoutShots = Number.isFinite(n) && n >= 0 && n <= 100 ? n : usage();
    } else usage();
  }
  const { entries, unreadable } = readEntries();
  const rows = await auditAll(entries);
  const { lines, failed, groups } = report(rows, opts);
  for (const l of lines) console.log(l);
  if (unreadable.length) console.log(`::warning title=Unreadable entries::${unreadable.join(' ')}`);
  if (opts.json) writeFileSync(opts.json, JSON.stringify({ rows, groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.map((r) => r.slug)])) }, null, 1) + '\n');
  if (opts.summary) writeFileSync(opts.summary, summaryTable(rows), { flag: 'a' });
  process.exit(failed ? 1 : 0);
}
