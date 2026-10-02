#!/usr/bin/env node
// Daily: finds YouTube videos whose description links a listed game's page on gamesbyai.win and adds them to those
// games' `videos` in the working tree; the workflow (videos.yml) turns the change into one PR for review. Candidates
// come from YouTube search and from the recent uploads of the GamesByAI channel and of channels the catalog already
// knows (a listed video's channel, a creator's YouTube link), because search alone misses new channels and URLs in
// descriptions. Whatever the source, a video passes the same rules. Video titles and channel names are the channels'
// own, untrusted text: they are stored as data (control characters removed, length capped to the schema), escaped in
// the PR body and rendered as text on the site, and never written to the log (counts only).
// Usage (CI): YOUTUBE_API_KEY=… node scripts/find-videos.mjs --prs <prs.json> --body <pr-body.md>
// where prs.json is `gh pr list --state all --json number,state,headRefName,isCrossRepository,body,createdAt,closedAt`.
// While one of our videos/* PRs is open the run stops (and warns once it has waited more than two days); the first
// search after it closes reaches back over the days it paused, and earlier PRs' videos are not offered again. Without
// --prs none of that applies.
import { readFileSync, writeFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseDocument, isMap, isScalar, isSeq } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const API = 'https://www.googleapis.com/youtube/v3';
export const MAX_PER_GAME = 4;
/** A video counts when it was published within this many days. */
export const WINDOW_DAYS = 10;
/**
 * Catalog channels read per run, besides the GamesByAI channel. Every run reads all of them: a playlistItems call costs
 * one quota unit (a handle costs one more to resolve), so this cap keeps a run near 1,000 units plus the videos.list
 * calls, far below the 10,000 units a day. Over the cap the most recently added channels are left out, with a warning.
 */
export const MAX_CHANNELS = 500;
/** The run warns when a videos PR of ours has been open longer than this many days: nothing is searched meanwhile. */
export const WAIT_WARN_DAYS = 2;
const DAY = 86_400_000;
// The GamesByAI YouTube channel (https://www.youtube.com/@GamesByAI-win). Its uploads are read on every run, whether or
// not search finds them. It is the only channel named in this file: every other channel comes from the catalog.
export const GAMESBYAI_CHANNEL = 'UCZQ9z0_JDA8PA3qW4B8CMsQ';
const ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE = /^@[A-Za-z0-9._-]{3,30}$/; // as in the catalog schema (creator.youtube)
const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com']);
const isChannel = (v) => typeof v === 'string' && CHANNEL.test(v);

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

/** One YouTube Data API call. Errors carry the HTTP status and never the URL, which holds the key. */
async function get(path, params, { key, fetchImpl }) {
  const res = await fetchImpl(`${API}/${path}?${new URLSearchParams({ ...params, key })}`);
  if (!res.ok) throw Object.assign(new Error(`YouTube ${path} answered ${res.status}`), { status: res.status });
  return res.json();
}

const bump = (stats, name, n = 1) => { stats[name] = (stats[name] ?? 0) + n; };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A channel's uploads playlist: YouTube names it after the channel, with UU in place of UC. */
export const uploadsPlaylist = (channelId) => `UU${channelId.slice(2)}`;

/**
 * The YouTube channel a link points to, or null: `{ id }` for /channel/UC…, `{ handle }` (lowercase, with the @) for
 * /@handle. Only https links on YouTube's own hosts count, without credentials or a port, and nothing may follow the id
 * or handle except one channel tab (/videos, /featured, /shorts or /streams, which creators often paste), a slash, a
 * query or a fragment. Only the captured id or handle is ever used. Anything else is skipped.
 */
export function channelRef(link) {
  if (typeof link !== 'string') return null;
  let u;
  try { u = new URL(link); } catch { return null; }
  if (u.protocol !== 'https:' || !YOUTUBE_HOSTS.has(u.hostname) || u.username || u.password || u.port) return null;
  const id = /^\/channel\/(UC[A-Za-z0-9_-]{22})(?:\/(?:videos|featured|shorts|streams))?\/?$/.exec(u.pathname);
  if (id) return { id: id[1] };
  const handle = /^\/(@[A-Za-z0-9._-]{3,30})(?:\/(?:videos|featured|shorts|streams))?\/?$/.exec(u.pathname);
  return handle ? { handle: handle[1].toLowerCase() } : null;
}

/**
 * The channels the catalog knows, oldest-added first: the channel of each video already listed, each YouTube channel
 * link of a creator and each creator.youtube handle, from live entries only. One ref per channel (`{ id }` or
 * `{ handle }`), dated by the oldest entry that names it. The order is stable: new entries sort last, so over
 * MAX_CHANNELS the newest are the ones left out.
 */
export function channelRefs(entries) {
  const found = new Map();
  const note = (ref, added) => {
    if (!ref) return;
    const k = ref.id ?? ref.handle;
    if (!found.has(k) || added < found.get(k).added) found.set(k, { ...ref, added });
  };
  for (const e of entries.values()) {
    if (e.status !== 'live') continue;
    const added = typeof e.dates?.added === 'string' ? e.dates.added : '9999-12-31';
    for (const v of Array.isArray(e.videos) ? e.videos : []) if (isChannel(v?.channelId)) note({ id: v.channelId }, added);
    for (const link of Array.isArray(e.creator?.links) ? e.creator.links : []) note(channelRef(link), added);
    if (typeof e.creator?.youtube === 'string' && HANDLE.test(e.creator.youtube)) note({ handle: e.creator.youtube.toLowerCase() }, added);
  }
  return [...found.values()].sort((a, b) => cmp(a.added, b.added) || cmp(a.id ?? a.handle, b.id ?? b.handle));
}

/**
 * Channel ids for the refs: ids pass through, and each @handle costs one channels.list call. A handle that matches no
 * channel, or whose channel is gone (404), is skipped; any other API error stops the run.
 */
export async function resolveChannels(refs, { key, fetchImpl = fetch, stats = {} }) {
  const ids = new Set();
  for (const ref of refs) {
    if (ref.id) { ids.add(ref.id); continue; }
    let id;
    try {
      id = (await get('channels', { part: 'id', forHandle: ref.handle }, { key, fetchImpl })).items?.[0]?.id;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    if (isChannel(id)) ids.add(id);
    else bump(stats, 'handlesUnresolved');
  }
  return [...ids];
}

/**
 * The ids of a channel's uploads published since `since`. One playlistItems call reads the first page of the uploads
 * playlist: 50 items, newest first in practice (the API reference promises no order). A channel that publishes more
 * than 50 videos between two runs would be cut off; daily runs and a 10-day window leave plenty of room.
 */
export async function recentUploads(channelId, { key, since, fetchImpl = fetch }) {
  const r = await get('playlistItems', { part: 'contentDetails', playlistId: uploadsPlaylist(channelId), maxResults: '50' }, { key, fetchImpl });
  const from = Date.parse(since);
  const out = [];
  for (const it of r.items ?? []) {
    const { videoId, videoPublishedAt } = it?.contentDetails ?? {};
    if (typeof videoId === 'string' && ID.test(videoId) && Date.parse(videoPublishedAt) >= from) out.push(videoId);
  }
  return out;
}

const published = (v) => Date.parse(v.snippet?.publishedAt) || 0;

/**
 * Recent videos that may link the site, with their full descriptions (neither search results nor playlists carry
 * them). Candidates come from search and from the recent uploads of `channels`, deduplicated and checked 50 at a
 * time, newest first. A channel that is gone (404) is skipped unless it is in `required`; every other API error stops
 * the run, so a bad key or a spent quota is never mistaken for "no videos". `stats` collects counts for the log.
 */
export async function findVideos({ key, since, channels = [], required = [], fetchImpl = fetch, stats = {} }) {
  const ids = new Set();
  for (const q of ['"gamesbyai.win"', 'gamesbyai']) {
    const r = await get('search', { part: 'id', type: 'video', q, order: 'date', maxResults: '50', publishedAfter: since }, { key, fetchImpl });
    for (const it of r.items ?? []) if (ID.test(it.id?.videoId ?? '')) ids.add(it.id.videoId);
  }
  bump(stats, 'searchHits', ids.size);
  for (const channel of new Set(channels)) {
    if (!isChannel(channel)) continue;
    let uploads;
    try {
      uploads = await recentUploads(channel, { key, since, fetchImpl });
    } catch (err) {
      if (err.status !== 404 || required.includes(channel)) throw err;
      bump(stats, 'channelsGone');
      continue;
    }
    bump(stats, 'channelsRead');
    bump(stats, 'uploads', uploads.length);
    for (const id of uploads) ids.add(id);
  }
  bump(stats, 'candidates', ids.size);
  const found = [];
  const list = [...ids];
  for (let i = 0; i < list.length; i += 50) {
    const r = await get('videos', { part: 'snippet', id: list.slice(i, i + 50).join(',') }, { key, fetchImpl });
    found.push(...(r.items ?? []).filter((v) => ID.test(v.id) && v.snippet?.liveBroadcastContent === 'none'));
  }
  bump(stats, 'usable', found.length);
  return found.sort((a, b) => published(b) - published(a));
}

/**
 * The additions: one per (video, listed game it links), skipping duplicates, full games and the videos in `offered`
 * (see offeredIds). Every source goes through these same rules.
 */
export function proposals(videos, entries, today, offered = new Set()) {
  const out = [];
  const count = new Map();
  for (const v of videos) {
    if (offered.has(v.id)) continue;
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

/** A PR from this repo's own videos/* branch. A fork's PR can name its branch anything, so it never counts. */
const isOwnVideosPr = (pr) => pr?.isCrossRepository === false && typeof pr.headRefName === 'string' && pr.headRefName.startsWith('videos/');

const isOpen = (pr) => String(pr.state).toUpperCase() === 'OPEN';
/** Our own open videos/* PRs. While one waits for its review, a new one would only duplicate it. */
const openOwn = (prs) => prs.filter((pr) => isOwnVideosPr(pr) && isOpen(pr));
/** A GitHub timestamp in milliseconds, or NaN when it is missing or was never set (gh prints 0001-01-01T00:00:00Z). */
const at = (s) => { const t = Date.parse(s); return t > 0 ? t : NaN; };

/** The numbers of those PRs. */
export function waitingFor(prs) {
  return openOwn(prs).map((pr) => pr.number);
}

/**
 * The open PRs of ours that have waited longer than WAIT_WARN_DAYS, as `{ number, days }` with whole days. The run
 * searches nothing meanwhile, so a PR left open is worth a warning.
 */
export function longWaits(prs, now) {
  const out = [];
  for (const pr of openOwn(prs)) {
    const days = (now.getTime() - at(pr.createdAt)) / DAY;
    if (days > WAIT_WARN_DAYS) out.push({ number: pr.number, days: Math.floor(days) });
  }
  return out;
}

/**
 * Where this run's window starts: WINDOW_DAYS before `now`, or earlier when a videos PR of ours paused the job. The run
 * searches nothing while such a PR is open, so after a wait longer than the window the videos published in its first
 * days would be lost. Every PR of ours that is open, or was closed inside the window, therefore pulls the start back to
 * the day before it was opened (the search that opened it had covered everything older). A PR closed before the window
 * needs nothing: the run after it already reached back. One with no closing time counts as recent, so a gap is never
 * missed; videos earlier PRs offered are left out by offeredIds either way.
 */
export function searchSince(prs, now) {
  const base = now.getTime() - WINDOW_DAYS * DAY;
  let from = base;
  for (const pr of prs ?? []) {
    if (!isOwnVideosPr(pr)) continue;
    const opened = at(pr.createdAt);
    if (Number.isNaN(opened)) continue;
    if (!isOpen(pr) && at(pr.closedAt) < base) continue;
    from = Math.min(from, opened - DAY);
  }
  return new Date(from).toISOString();
}

// The start of a row of prBody's table; the video id sits in the thumbnail address.
const OFFERED_ROW = /^\| \[[^\]\n]*\]\(https:\/\/gamesbyai\.win\/games\/[a-z0-9-]+\/\) \| <img src="https:\/\/i\.ytimg\.com\/vi\/([A-Za-z0-9_-]{11})\/mqdefault\.jpg" width="160"> \| /;

/**
 * The ids of the videos that earlier PRs from our own videos/* branches, merged or not, already offered for review,
 * read back from the table rows of their bodies (see prBody). A video dropped in review therefore doesn't come back
 * while it is still inside the window. Only the start of a row is matched, so text inside a title can't add ids.
 */
export function offeredIds(prs) {
  const out = new Set();
  for (const pr of prs) {
    if (!isOwnVideosPr(pr)) continue;
    for (const line of String(pr.body ?? '').split(/\r?\n/)) {
      const m = OFFERED_ROW.exec(line);
      if (m) out.add(m[1]);
    }
  }
  return out;
}

/**
 * One run. It stops while a videos PR waits for review (and warns once the wait is longer than WAIT_WARN_DAYS);
 * otherwise it gathers candidates from search and from the uploads of every known channel, writes the additions into the
 * entries under `root` and, if there are any, the PR body into `bodyFile`. The window starts WINDOW_DAYS back, or
 * earlier when such a PR paused the job (see searchSince). `prs` is the list from
 * `gh pr list --json number,state,headRefName,isCrossRepository,body,createdAt,closedAt`. Returns the number of
 * additions. The log gets counts only (a `::warning::` line is a GitHub Actions annotation): video titles and channel
 * names are untrusted text.
 */
export async function run({ key, root = ROOT, prs, bodyFile, fetchImpl = fetch, now = new Date(), log = console.log, warn = console.warn }) {
  if (prs !== undefined && !Array.isArray(prs)) throw new TypeError('prs must be the JSON list from gh pr list');
  const waiting = prs ? waitingFor(prs) : [];
  if (waiting.length) {
    log(`videos: waiting for the review of open pull request${waiting.length > 1 ? 's' : ''} ${waiting.map((n) => `#${Number(n)}`).join(', ')}, so nothing is searched`);
    for (const w of longWaits(prs, now)) {
      log(`::warning::videos: pull request #${Number(w.number)} has been open for more than ${w.days} days, so no videos are searched. Merge or close it; the next search reaches back to the day before it was opened.`);
    }
    return 0;
  }
  const since = searchSince(prs ?? [], now);
  const entries = loadEntries(join(root, 'games'));
  const known = channelRefs(entries);
  const stats = { channelsKnown: known.length };
  const picked = known.slice(0, MAX_CHANNELS);
  if (picked.length < known.length) {
    log(`::warning::videos: the catalog names ${known.length} YouTube channels but only the first ${MAX_CHANNELS} are read (oldest added first), so ${known.length - picked.length} are skipped. Raise MAX_CHANNELS in scripts/find-videos.mjs to read them all.`);
  }
  const channels = [GAMESBYAI_CHANNEL, ...(await resolveChannels(picked, { key, fetchImpl, stats }))];
  const videos = await findVideos({ key, since, channels, required: [GAMESBYAI_CHANNEL], fetchImpl, stats });
  const props = proposals(videos, entries, now.toISOString().slice(0, 10), prs ? offeredIds(prs) : undefined);
  const bySlug = Map.groupBy(props, (p) => p.slug);
  for (const [slug, ps] of bySlug) {
    const e = entries.get(slug);
    try {
      writeFileSync(e.file, appendVideos(e.text, ps.map((p) => p.video)));
    } catch (err) {
      warn(`videos: skipped ${slug} (${err.message})`);
      props.splice(0, props.length, ...props.filter((p) => p.slug !== slug));
    }
  }
  if (bodyFile && props.length) writeFileSync(bodyFile, prBody(props));
  const n = (name) => stats[name] ?? 0;
  log(`videos: search found ${n('searchHits')}; ${n('channelsRead')} channels read (${n('channelsKnown')} known in the catalog, ${n('channelsGone') + n('handlesUnresolved')} not found), ${n('uploads')} uploads in the window; ${n('candidates')} videos checked, ${n('usable')} usable; ${props.length} to add`);
  return props.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = (k, v) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    if (i < 0) return undefined;
    const v = process.argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`);
    return v;
  };
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    console.log('videos: no YOUTUBE_API_KEY, nothing to do');
    output('count', 0);
  } else {
    const prsFile = arg('--prs');
    output('count', await run({ key, prs: prsFile && JSON.parse(readFileSync(prsFile, 'utf8')), bodyFile: arg('--body') }));
  }
}
