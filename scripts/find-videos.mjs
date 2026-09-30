#!/usr/bin/env node
// Weekly: finds YouTube videos whose description links a listed game's page on gamesbyai.win and adds them to those
// games' `videos` in the working tree; the workflow (videos.yml) turns the change into one PR for review. Video
// titles and channel names are the channels' own, untrusted text: they are stored as data (control characters
// removed, length capped to the schema), escaped in the PR body and rendered as text on the site.
// Usage (CI): YOUTUBE_API_KEY=… node scripts/find-videos.mjs --body <pr-body.md>
import { readFileSync, writeFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseDocument, isMap, isScalar, isSeq } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const API = 'https://www.googleapis.com/youtube/v3';
export const MAX_PER_GAME = 4;
const ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;

/** One line of plain text, capped. */
export const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
/** For the PR body: no Markdown, HTML or mentions from video text. */
export const esc = (s) => String(s).replace(/[\\`*_{}[\]()#+!|<>~@&]/g, (c) => `\\${c}`);

/** The game slugs a description links to on gamesbyai.win. */
export function slugsIn(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(/(?:^|[^a-z0-9.-])(?:www\.)?gamesbyai\.win\/games\/([a-z0-9]+(?:-[a-z0-9]+)*)/gi)) out.add(m[1].toLowerCase());
  return [...out];
}

async function get(path, params, { key, fetchImpl }) {
  const res = await fetchImpl(`${API}/${path}?${new URLSearchParams({ ...params, key })}`);
  if (!res.ok) throw new Error(`YouTube ${path} answered ${res.status}`);
  return res.json();
}

/** Recent videos that mention the site, with their full descriptions (search results carry only a snippet). */
export async function findVideos({ key, since, fetchImpl = fetch }) {
  const ids = new Set();
  for (const q of ['"gamesbyai.win"', 'gamesbyai']) {
    const r = await get('search', { part: 'id', type: 'video', q, order: 'date', maxResults: '50', publishedAfter: since }, { key, fetchImpl });
    for (const it of r.items ?? []) if (ID.test(it.id?.videoId ?? '')) ids.add(it.id.videoId);
  }
  if (!ids.size) return [];
  const r = await get('videos', { part: 'snippet', id: [...ids].join(','), maxResults: '50' }, { key, fetchImpl });
  return (r.items ?? []).filter((v) => ID.test(v.id) && v.snippet?.liveBroadcastContent === 'none');
}

/** The additions: one per (video, listed game it links), skipping duplicates and full games. */
export function proposals(videos, entries, today) {
  const out = [];
  const count = new Map();
  for (const v of videos) {
    for (const slug of slugsIn(v.snippet.description)) {
      const e = entries.get(slug);
      if (!e || e.status !== 'live') continue;
      const have = e.videos ?? [];
      const n = count.get(slug) ?? have.length;
      if (have.some((x) => x.youtube === v.id) || out.some((p) => p.slug === slug && p.video.youtube === v.id) || n >= MAX_PER_GAME) continue;
      const title = clean(v.snippet.title, 120);
      const channel = clean(v.snippet.channelTitle, 80);
      if (!title || !channel) continue;
      count.set(slug, n + 1);
      out.push({ slug, video: { youtube: v.id, title, channel, ...(CHANNEL.test(v.snippet.channelId ?? '') ? { channelId: v.snippet.channelId } : {}), added: today } });
    }
  }
  return out;
}

/** Adds videos to an entry's YAML, preserving comments and key order. */
export function appendVideos(text, videos) {
  const doc = parseDocument(text);
  if (doc.errors.length) throw doc.errors[0];
  if (!isMap(doc.contents)) throw new Error('entry must be a YAML map');
  let seq = doc.get('videos', true);
  if (seq === undefined || (isScalar(seq) && seq.value === null)) {
    const previous = seq;
    seq = doc.createNode([]);
    seq.comment = previous?.comment;
    seq.commentBefore = previous?.commentBefore;
    seq.spaceBefore = previous?.spaceBefore;
    seq.anchor = previous?.anchor;
    doc.set('videos', seq);
  }
  if (!isSeq(seq)) throw new Error('videos must be a YAML sequence');
  for (const video of videos) seq.add(doc.createNode(video));
  // The entries are written with the default width, so the rest of the file comes back byte for byte.
  const out = doc.toString();
  parse(out); // Validate the serialized YAML before the caller writes it.
  return out;
}

export function prBody(props) {
  const rows = props.map(({ slug, video: v }) => `| [${esc(slug)}](https://gamesbyai.win/games/${slug}/) | <img src="https://i.ytimg.com/vi/${v.youtube}/mqdefault.jpg" width="160"> | [${esc(v.title)}](https://www.youtube.com/watch?v=${v.youtube}) | ${esc(v.channel)} |`);
  return [
    'YouTube videos whose description links a listed game\'s page. Before merging, check that each video shows the game being played and suits a general audience; remove any that don\'t.',
    '',
    '| Game | Thumbnail | Video | Channel |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function loadEntries(dir) {
  const out = new Map();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    const text = readFileSync(join(dir, f), 'utf8');
    const e = parse(text);
    if (e?.slug) out.set(e.slug, { ...e, file: join(dir, f), text });
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = (k, v) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    console.log('videos: no YOUTUBE_API_KEY, nothing to do');
    output('count', 0);
  } else {
    const since = new Date(Date.now() - 10 * 24 * 3600_000).toISOString();
    const entries = loadEntries(join(ROOT, 'games'));
    const props = proposals(await findVideos({ key, since }), entries, new Date().toISOString().slice(0, 10));
    const bySlug = Map.groupBy(props, (p) => p.slug);
    for (const [slug, ps] of bySlug) {
      const e = entries.get(slug);
      try {
        writeFileSync(e.file, appendVideos(e.text, ps.map((p) => p.video)));
      } catch (err) {
        console.warn(`videos: skipped ${slug} (${err.message})`);
        props.splice(0, props.length, ...props.filter((p) => p.slug !== slug));
      }
    }
    const i = process.argv.indexOf('--body');
    if (i > 0 && props.length) writeFileSync(process.argv[i + 1], prBody(props));
    console.log(`videos: ${props.length} to add`);
    output('count', props.length);
  }
}
