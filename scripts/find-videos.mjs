#!/usr/bin/env node
// Discovery reserves quota, then writes catalog edits and a report posted after PR success.
// YouTube text is data: cleaned for YAML, escaped for the body, and excluded from logs.
import { readFileSync, writeFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parse, parseDocument, isMap, isScalar, isSeq } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const API = 'https://www.googleapis.com/youtube/v3';
const DAY = 86_400_000;
const ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HANDLE = /^@[A-Za-z0-9._-]{3,30}$/;
const SOURCES = new Set(['form', 'manual', 'title', 'site', 'channel']);
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded']);
const ERROR_CODES = new Set(['input', 'catalog', 'network', 'response', 'keyInvalid', 'forbidden', 'rateLimitExceeded', 'quotaExceeded', 'channel', 'post']);
export const MAX_PER_GAME = 4;
export const MAX_ROWS = 60;
export const MAX_BODY = 60_000;
export const MAX_CHANNELS = 2_000;
export const MAX_HANDLES = 100;
export const GAMESBYAI_CHANNEL = 'UCZQ9z0_JDA8PA3qW4B8CMsQ';
const commonTitles = new Set(readFileSync(new URL('./video-common-titles.txt', import.meta.url), 'utf8').split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter((s) => s && !s.startsWith('#')));
const isId = (v) => typeof v === 'string' && ID.test(v);
const isChannel = (v) => typeof v === 'string' && CHANNEL.test(v);
const isSlug = (v) => typeof v === 'string' && v.length <= 200 && SLUG.test(v);
const integer = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
const keys = (v, expected) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === expected.length && expected.every((key) => Object.hasOwn(v, key));
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const dayOf = (now) => now.toISOString().slice(0, 10);
const dayNumber = (day) => Math.floor(Date.parse(day) / DAY);
const validDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && dayOf(new Date(v)) === v;
const ago = (day, n) => new Date(Date.parse(day) - n * DAY).toISOString();
const age = (today, day) => validDay(day) ? dayNumber(today) - dayNumber(day) : Infinity;
export const pairKey = (video, slug) => `${video}:${slug}`;
export const fixedError = (code) => Object.assign(new Error('videos: request failed'), { code: ERROR_CODES.has(code) ? code : 'response' });
export const errorCode = (err) => ERROR_CODES.has(err?.code) ? err.code : 'catalog';
export const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
export const esc = (s) => String(s).replace(/[\\`*_{}[\]()#+!|<>~@&]/g, (c) => `\\${c}`);
export const defang = (s) => String(s).replace(/https:\/\//gi, 'hxxps[:]//').replace(/http:\/\//gi, 'hxxp[:]//').replace(/www\./gi, 'www[.]');
const bodyText = (s, max) => `\`${defang(clean(s, max)).replace(/`/g, "'").replace(/\|/g, '\\|')}\``;

export function slugsIn(text) {
  const out = new Set();
  const links = /(?:^|[\s(<["'])(?:https?:\/\/)?(?:www\.)?gamesbyai\.win\/games\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=[\/\?#)\]>"'.,!\s]|$)/gi;
  for (const m of String(text ?? '').slice(0, 10_000).matchAll(links)) out.add(m[1].toLowerCase());
  return [...out];
}

export function youtubeId(input) {
  if (typeof input !== 'string' || input.length > 300) return null;
  const text = input.trim();
  if (isId(text)) return text;
  if (/[\s\u0000-\u001f\u007f\\]/u.test(text)) return null;
  const raw = text.startsWith('//') ? `https:${text}` : /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  const authority = /^https:\/\/([^/?#]+)/i.exec(raw)?.[1]?.toLowerCase();
  if (!authority || !(YOUTUBE_HOSTS.has(authority) || authority === 'youtu.be')) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || /:\d+(?:\/|$)/.test(text)) return null;
  let id;
  if (u.hostname === 'youtu.be') id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(u.pathname)?.[1];
  else if (YOUTUBE_HOSTS.has(u.hostname)) {
    id = u.pathname === '/watch' && u.searchParams.getAll('v').length === 1 ? u.searchParams.get('v') : /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})\/?$/.exec(u.pathname)?.[1];
  }
  return isId(id) ? id : null;
}

export function internalVideosUrl(notifyUrl) {
  try {
    const u = new URL(notifyUrl);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    return new URL('/api/internal/videos', u.origin).href;
  } catch { return null; }
}

export function pacificDay(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

async function jsonResponse(res, max) {
  if (Number(res.headers?.get('content-length')) > max) throw fixedError('response');
  const reader = res.body?.getReader();
  if (!reader) throw fixedError('response');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); throw fixedError('response'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw fixedError('response'); }
}

export async function youtubeGet(path, params, { key, fetchImpl = fetch, budget, reserveQuota }) {
  const search = path === 'search';
  if (budget && (search ? budget.searchStopped || budget.baseSearches + budget.searches >= budget.searchLimit : budget.unitStopped || budget.baseUnits + budget.units >= 9_000)) return null;
  if (!reserveQuota) throw fixedError('input');
  const allowed = await reserveQuota({ units: search ? 0 : 1, searches: search ? 1 : 0 });
  if (!allowed) { if (budget) budget[search ? 'searchStopped' : 'unitStopped'] = true; return null; }
  if (budget) budget[search ? 'searches' : 'units']++;
  let res;
  try {
    res = await fetchImpl(`${API}/${path}?${new URLSearchParams(params)}`, { headers: { 'X-Goog-Api-Key': key }, signal: AbortSignal.timeout(5_000), redirect: 'error' });
  } catch { throw fixedError('network'); }
  const data = await jsonResponse(res, 2_000_000);
  if (!res.ok) {
    const reason = data?.error?.errors?.[0]?.reason;
    if (budget && QUOTA_REASONS.has(reason)) {
      budget[search ? 'searchStopped' : 'unitStopped'] = true;
      return null;
    }
    throw Object.assign(fixedError(reason), { status: res.status });
  }
  if (!data || !Array.isArray(data.items) || data.items.length > 50) throw fixedError('response');
  return data;
}

/** Reject an entire malformed state rather than use a partial answer. */
export function validateSiteState(s, now = new Date()) {
  const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const list = (v, cap, check) => Array.isArray(v) && v.length <= cap && v.every(check);
  if (!object(s) || !validDay(s.day) || ![0, 1].includes(age(pacificDay(now), s.day)) || !object(s.quota) ||
      !['workerUnits', 'jobUnits'].every((k) => integer(s.quota[k], 10_000)) || !integer(s.quota.jobSearches, 100) ||
      !(s.lastRun === null || validDay(s.lastRun) && age(dayOf(now), s.lastRun) >= 0) ||
      !list(s.queue, 2_000, (r) => object(r) && isId(r.video) && isSlug(r.slug) && SOURCES.has(r.source) && typeof r.seen === 'boolean') ||
      !list(s.signals, 2_000, (r) => object(r) && isSlug(r.slug) && integer(r.days, 14) && validDay(r.last) && age(dayOf(now), r.last) >= 0 && integer(r.yesterday, 100_000_000) && typeof r.median === 'number' && Number.isFinite(r.median) && r.median >= 0 && r.median <= 100_000_000) ||
      !object(s.searched) || Object.keys(s.searched).length > 5_000 || !Object.entries(s.searched).every(([slug, r]) => isSlug(slug) && object(r) && validDay(r.day) && age(dayOf(now), r.day) >= 0 && (r.landing === null || validDay(r.landing) && age(dayOf(now), r.landing) >= 0) && (r.start === null || validDay(r.start) && validDay(r.landing) && r.start <= r.landing)) ||
      !list(s.reviews, 10_000, (r) => Array.isArray(r) && r.length === 3 && isId(r[0]) && isSlug(r[1]) && ['added', 'declined'].includes(r[2])) ||
      !list(s.channels, 5_000, isChannel) || !list(s.played, 20, isSlug)) throw fixedError('input');
  return s;
}

export async function loadSiteState({ notifyUrl, token, fetchImpl = fetch, now = new Date() }) {
  const url = internalVideosUrl(notifyUrl);
  if (!url || !token) return null;
  try {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000), redirect: 'error' });
    if (!res.ok) return null;
    return validateSiteState(await jsonResponse(res, 2_000_000), now);
  } catch { return null; }
}

export const REPORT_ARRAYS = ['offered', 'drop', 'enqueue', 'seen', 'reviews', 'confirmed', 'forget', 'channels', 'channelsGone', 'searched'];
/** Validate the local spool as well as each bounded POST payload. */
export function validateReport(r, now = new Date(), cap = 5_000) {
  const pair = (v) => Array.isArray(v) && v.length === 2 && isId(v[0]) && isSlug(v[1]);
  const check = {
    searched: (v) => keys(v, ['slug', 'landing', 'start']) && isSlug(v.slug) && typeof v.landing === 'boolean' && (v.landing ? validDay(v.start) && v.start <= r.run : v.start === null),
    offered: pair, drop: pair, seen: pair,
    enqueue: (v) => keys(v, ['video', 'slug', 'source']) && isId(v.video) && isSlug(v.slug) && SOURCES.has(v.source),
    reviews: (v) => keys(v, ['video', 'slug', 'state', 'pr']) && isId(v.video) && isSlug(v.slug) && ['added', 'declined'].includes(v.state) && Number.isSafeInteger(v.pr) && v.pr > 0,
    confirmed: isId, forget: isId, channels: isChannel, channelsGone: isChannel,
  };
  const fields = [...REPORT_ARRAYS, 'day', 'run', 'runId', 'checkedAt', 'siteComplete', 'batchId', 'units', 'searches', 'counts'];
  if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some((k) => !fields.includes(k)) ||
      !validDay(r.day) || !validDay(r.run) || !integer(r.checkedAt, now.getTime()) || r.checkedAt < now.getTime() - 30 * DAY ||
      r.day !== pacificDay(new Date(r.checkedAt)) || r.run !== dayOf(new Date(r.checkedAt)) || typeof r.siteComplete !== 'boolean' ||
      typeof r.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(r.runId) ||
      (r.batchId !== undefined && (typeof r.batchId !== 'string' || !/^[a-f0-9]{64}$/.test(r.batchId))) ||
      !integer(r.units, 10_000) || !integer(r.searches, 100) || !REPORT_ARRAYS.every((k) => Array.isArray(r[k]) && r[k].length <= cap && r[k].every(check[k])) ||
      !r.counts || typeof r.counts !== 'object' || Array.isArray(r.counts) || Object.keys(r.counts).length > 20 ||
      !Object.entries(r.counts).every(([k, v]) => /^(?:(?:site|title|channel)(?:Found|Known|Expected)|landing(?:Searches|Found))$/.test(k) && integer(v, 100_000))) throw fixedError('input');
  return r;
}

export function searchCap(value = 5) {
  if (!/^(?:0|[1-9]\d?)$/.test(String(value)) || !integer(Number(value), 90)) throw fixedError('input');
  return Number(value);
}

export function planSearches({ entries, state = null, now = new Date(), manual = false, searches = 5, explained = new Set() }) {
  const explainedGames = new Set(explained);
  const today = dayOf(now);
  const cap = manual ? searchCap(searches) : 90;
  const slots = Math.max(0, Math.min(cap, 100 - (state?.quota.jobSearches ?? 0) - 2 - (manual ? 0 : 8)));
  const live = [...entries.values()].filter((e) => e.status === 'live');
  const out = [];
  const picked = new Set();
  const take = (rows, bucket, max) => {
    let n = 0;
    for (const e of rows) {
      if (out.length >= slots || n >= max) break;
      if (picked.has(e.slug)) continue;
      picked.add(e.slug); n++;
      const last = state?.searched[e.slug];
      const fresh = !last || (state.signals.find((s) => s.slug === e.slug)?.last ?? '') >= last.day;
      out.push({ slug: e.slug, bucket, landing: bucket === 'landings', start: bucket === 'landings' ? fresh ? today : last?.start ?? last?.landing ?? today : null });
    }
  };
  if (!state) {
    live.sort((a, b) => cmp(a.dates?.added ?? '', b.dates?.added ?? '') || cmp(a.slug, b.slug));
    if (live.length) {
      const start = (dayNumber(today) * slots) % live.length;
      take([...live.slice(start), ...live.slice(0, start)], 'rotation', slots);
    }
    return out;
  }
  const searched = (e) => Object.hasOwn(state.searched, e.slug) ? state.searched[e.slug] : undefined;
  for (const e of live) if (e.videos?.length) explainedGames.add(e.slug);
  for (const r of state.queue) explainedGames.add(r.slug);
  const signalMap = new Map(state.signals.map((r) => [r.slug, r]));
  const least = (a, b) => cmp(searched(a)?.day ?? '', searched(b)?.day ?? '') || cmp(a.dates?.added ?? '', b.dates?.added ?? '') || cmp(a.slug, b.slug);
  const landings = live.filter((e) => {
    const signal = signalMap.get(e.slug), last = searched(e);
    if (!signal || age(today, signal.last) > 14 || age(today, last?.landing) < 3) return false;
    const spike = signal.yesterday > 2 * signal.median;
    if (explainedGames.has(e.slug) && age(today, last?.landing) < 7 && !spike) return false;
    const fresh = !last || signal.last >= last.day;
    // Landings are reported the next morning; keep the +7 retry after the +3 retry updates state.
    const start = last?.start ?? last?.landing;
    const follow = !explainedGames.has(e.slug) && validDay(last?.landing) &&
      [3, 7].some((offset) => age(today, start) >= offset && age(last.landing, start) < offset);
    return fresh || follow;
  }).sort((a, b) => Number(explainedGames.has(a.slug)) - Number(explainedGames.has(b.slug)) || signalMap.get(b.slug).days - signalMap.get(a.slug).days || least(a, b));
  take(landings, 'landings', 20);
  take(live.filter((e) => {
    const n = age(today, e.dates?.added);
    return n >= 0 && n <= 21 && ([1, 3, 7, 14, 21].includes(n) || !searched(e));
  }).sort(least), 'new', 10);
  take(state.played.map((slug) => entries.get(slug)).filter((e) => e?.status === 'live' && age(today, searched(e)?.day) >= 7), 'played', 5);
  take(live.sort(least), 'rotation', slots);
  return out;
}

export function searchQuery(entry) {
  const title = clean(entry.title, 120).replace(/["|]/g, '').split(/\s+/).map((s) => s.replace(/^-+/, '')).filter(Boolean).join(' ');
  // The site context is needed even for distinct titles. Common titles also need a game context.
  return `${title} "gamesbyai.win"${commonTitles.has(title.toLowerCase()) ? ' "AI game"' : ''}`.trim();
}

export function titleSince(entry, lastSearched) {
  const added = validDay(entry.dates?.added) ? Date.parse(entry.dates.added) - 30 * DAY : 0;
  return new Date(Math.max(added, validDay(lastSearched) ? Date.parse(lastSearched) - 7 * DAY : added)).toISOString();
}
export const siteSince = (lastRun, now) => validDay(lastRun) ? ago(lastRun, 7) : new Date(now.getTime() - 30 * DAY).toISOString();

export const uploadsPlaylist = (channelId) => `UU${channelId.slice(2)}`;
export function channelRef(link) {
  if (typeof link !== 'string') return null;
  let u;
  try { u = new URL(link); } catch { return null; }
  if (u.protocol !== 'https:' || !YOUTUBE_HOSTS.has(u.hostname) || u.username || u.password || u.port || /:\d+(?:\/|$)/.test(link)) return null;
  const id = /^\/channel\/(UC[A-Za-z0-9_-]{22})(?:\/(?:videos|featured|shorts|streams))?\/?$/.exec(u.pathname);
  if (id) return { id: id[1] };
  const handle = /^\/(@[A-Za-z0-9._-]{3,30})(?:\/(?:videos|featured|shorts|streams))?\/?$/.exec(u.pathname);
  return handle ? { handle: handle[1].toLowerCase() } : null;
}
export function channelRefs(entries) {
  const found = new Map();
  const note = (ref, added) => {
    if (!ref) return;
    const key = ref.id ?? ref.handle;
    if (!found.has(key) || added < found.get(key).added) found.set(key, { ...ref, added });
  };
  for (const e of entries.values()) {
    if (e.status !== 'live') continue;
    const added = e.dates?.added ?? '9999-12-31';
    for (const v of e.videos ?? []) if (isChannel(v.channelId)) note({ id: v.channelId }, added);
    for (const link of e.creator?.links ?? []) note(channelRef(link), added);
    if (HANDLE.test(e.creator?.youtube ?? '')) note({ handle: e.creator.youtube.toLowerCase() }, added);
  }
  return [...found.values()].sort((a, b) => cmp(a.added, b.added) || cmp(a.id ?? a.handle, b.id ?? b.handle));
}

/** All candidate sources use this status and link gate. */
export function usable(video, entries) {
  if (!video || !isId(video.id)) return { reason: 'gone', slugs: [] };
  const slugs = slugsIn(video.snippet?.description).filter((slug) => entries.get(slug)?.status === 'live');
  let reason = null;
  if (video.status?.privacyStatus !== 'public' || video.status?.uploadStatus !== 'processed') reason = 'not-public';
  else if (video.snippet?.liveBroadcastContent !== 'none') reason = 'live';
  else if (video.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted') reason = 'age-restricted';
  else if (!slugs.length) reason = 'link-removed';
  else if (slugs.length > 3) reason = 'many-games';
  else if (!clean(video.snippet?.title, 120) || !clean(video.snippet?.channelTitle, 80)) reason = 'not-public';
  return { reason, slugs };
}
const storedVideo = (v, today) => ({ youtube: v.id, title: clean(v.snippet.title, 120), channel: clean(v.snippet.channelTitle, 80), ...(isChannel(v.snippet.channelId) ? { channelId: v.snippet.channelId } : {}), added: today });

/** Adds videos to YAML while preserving comments and key order. */
export function appendVideos(text, videos) {
  const doc = parseDocument(text);
  if (doc.errors.length || !isMap(doc.contents)) throw fixedError('catalog');
  let seq = doc.get('videos', true);
  if (seq === undefined || isScalar(seq) && seq.value === null) {
    const previous = seq;
    seq = doc.createNode([]);
    for (const key of ['comment', 'commentBefore', 'spaceBefore', 'anchor']) seq[key] = previous?.[key];
    doc.set('videos', seq);
  }
  if (!isSeq(seq)) throw fixedError('catalog');
  for (const video of videos) seq.add(doc.createNode(video));
  const out = doc.toString(); parse(out); return out;
}

function editVideos(text, changes) {
  const doc = parseDocument(text);
  if (doc.errors.length || !isMap(doc.contents) || !isSeq(doc.get('videos', true))) throw fixedError('catalog');
  const seq = doc.get('videos', true);
  for (const c of changes) {
    const index = seq.items.findIndex((node) => isMap(node) && node.get('youtube') === c.youtube);
    if (index < 0) throw fixedError('catalog');
    if (c.kind === 'Removed') seq.items.splice(index, 1);
    else {
      for (const key of ['title', 'channel', 'channelId']) {
        if (c.video[key] !== undefined) seq.items[index].set(key, c.video[key]);
        else seq.items[index].delete(key);
      }
    }
  }
  if (!seq.items.length) doc.delete('videos');
  const out = doc.toString(); parse(out); return out;
}

export function prBody(props, { changes = [], many = [] } = {}) {
  const foundBy = { form: 'site form', manual: 'site form', title: 'title search', site: 'site search', channel: 'channel' };
  const lines = ["YouTube videos whose description links a listed game's page. Each video is reviewed before merging; videos that do not show the game being played or suit a general audience are removed from the branch."];
  if (props.length) lines.push('', '## Added', '', '| Game | Video | Title | Channel | Found by |', '| --- | --- | --- | --- | --- |', ...props.map(({ slug, video: v, source }) => `| [${slug}](https://gamesbyai.win/games/${slug}/) | [${v.youtube}](https://www.youtube.com/watch?v=${v.youtube}) | ${bodyText(v.title, 120)} | ${bodyText(v.channel, 80)} | ${foundBy[source] ?? 'site search'} |`));
  for (const kind of ['Changed', 'Removed']) {
    const rows = changes.filter((c) => c.kind === kind);
    if (rows.length) lines.push('', `## ${kind}`, '', ...rows.map((c) => `- ${c.slug}: ${c.youtube} (${c.reason})`));
  }
  if (many.length) lines.push('', '## Many games', '', ...many.map(({ video, n }) => `- Many games: [${video}](https://www.youtube.com/watch?v=${video}) (${n} listed games)`));
  return lines.join('\n');
}

const isOwnVideosPr = (pr) => pr?.isCrossRepository === false && typeof pr.headRefName === 'string' && pr.headRefName.startsWith('videos/');
export const waitingFor = (prs) => prs.filter((p) => isOwnVideosPr(p) && String(p.state).toUpperCase() === 'OPEN').map((p) => p.number);
const OFFERED_OLD = /^\| \[[^\]\n]*\]\(https:\/\/gamesbyai\.win\/games\/([a-z0-9]+(?:-[a-z0-9]+)*)\/\) \| <img src="https:\/\/i\.ytimg\.com\/vi\/([A-Za-z0-9_-]{11})\/mqdefault\.jpg" width="160"> \| /;
const OFFERED_NEW = /^\| \[[^\]\n]*\]\(https:\/\/gamesbyai\.win\/games\/([a-z0-9]+(?:-[a-z0-9]+)*)\/\) \| \[([A-Za-z0-9_-]{11})\]\(https:\/\/www\.youtube\.com\/watch\?v=\2\) \| /;
const MANY = /^- Many games: \[([A-Za-z0-9_-]{11})\]\(https:\/\/www\.youtube\.com\/watch\?v=\1\) \(\d+ listed games\)$/;
function bodyPairs(body) {
  const out = new Map();
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const row = OFFERED_NEW.exec(line) ?? OFFERED_OLD.exec(line);
    if (row) out.set(pairKey(row[2], row[1]), [row[2], row[1]]);
  }
  return [...out.values()];
}
export function offeredPairs(prs) {
  return new Set(prs.filter(isOwnVideosPr).flatMap((p) => bodyPairs(p.body).map(([v, s]) => pairKey(v, s))));
}
export function offeredVideos(prs) {
  return new Set(prs.filter(isOwnVideosPr).flatMap((p) => String(p.body ?? '').split(/\r?\n/).flatMap((line) => {
    const match = MANY.exec(line); return match ? [match[1]] : [];
  })));
}
export function reviewOutcomes(prs, entries, now) {
  const out = new Map();
  for (const p of [...prs].filter(isOwnVideosPr).sort((a, b) => cmp(a.closedAt ?? '', b.closedAt ?? ''))) {
    if (String(p.state).toUpperCase() === 'OPEN' || !Number.isSafeInteger(p.number) || p.number < 1) continue;
    const closed = Date.parse(p.closedAt);
    if (!Number.isFinite(closed) || closed <= 0 || now.getTime() - closed > 30 * DAY || closed > now.getTime()) continue;
    for (const [video, slug] of bodyPairs(p.body)) {
      const merged = String(p.state).toUpperCase() === 'MERGED' || Date.parse(p.mergedAt) > 0;
      const state = merged && entries.get(slug)?.videos?.some((v) => v.youtube === video) ? 'added' : 'declined';
      const key = pairKey(video, slug);
      if (out.get(key)?.state !== 'added') out.set(key, { video, slug, state, pr: p.number });
    }
  }
  return [...out.values()];
}

function loadEntries(dir) {
  const out = new Map();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
    const text = readFileSync(join(dir, f), 'utf8');
    const e = parse(text);
    if (e?.slug) out.set(e.slug, { ...e, file: join(dir, f), text });
  }
  return out;
}

/** Quota is reserved before calls. Discovery mutations remain in the local report until PR success. */
export async function run({ key, root = ROOT, prs = [], bodyFile, reportFile, fetchImpl = fetch, now = new Date(), log = console.log, siteState, notifyUrl, token, manual = false, searches = 5, reserveQuota, runId = randomUUID() }) {
  if (!Array.isArray(prs)) throw fixedError('input');
  searchCap(searches);
  const entries = loadEntries(join(root, 'games'));
  const today = dayOf(now);
  const prOpen = waitingFor(prs).length > 0;
  let state = null;
  if (siteState !== undefined) { try { state = validateSiteState(siteState, now); } catch { /* Unavailable state uses the same fallback as a failed GET. */ } }
  else state = await loadSiteState({ notifyUrl, token, fetchImpl, now });
  if (!state) log('videos: site state unavailable');
  if (!state) { log(`videos: open ${waitingFor(prs).length}; searched 0`); return 0; }
  const manualQueuePairs = new Set((state?.queue ?? []).filter((r) => r.source === 'manual').map((r) => pairKey(r.video, r.slug)));
  const report = { day: pacificDay(now), run: today, runId, checkedAt: now.getTime(), siteComplete: false, units: 0, searches: 0, searched: [], offered: [], enqueue: [], drop: [], seen: [], reviews: reviewOutcomes(prs, entries, now).filter((r) => !manualQueuePairs.has(pairKey(r.video, r.slug))), confirmed: [], forget: [], channels: [], channelsGone: [], counts: {} };
  const quota = state?.day === report.day ? state.quota : { workerUnits: 0, jobUnits: 0, jobSearches: 0 };
  const budget = { units: 0, searches: 0, baseUnits: quota.workerUnits + quota.jobUnits, baseSearches: quota.jobSearches, searchLimit: manual ? 100 : 92 };
  if (!reserveQuota) {
    const { reserveRunQuota } = await import('./videos-post.mjs');
    reserveQuota = reserveRunQuota({ notifyUrl, token, fetchImpl, runId, searchLimit: budget.searchLimit });
  }
  const ctx = { key, fetchImpl, budget, reserveQuota };
  const cache = new Map();
  const candidates = new Map();
  const many = new Map();
  const explained = new Set();
  const offered = offeredPairs(prs);
  const excludedVideos = offeredVideos(prs);
  for (const k of offered) explained.add(k.split(':')[1]);
  const declined = new Set((state?.reviews ?? []).filter((r) => r[2] === 'declined' && !manualQueuePairs.has(pairKey(r[0], r[1]))).map(([v, s]) => pairKey(v, s)));
  for (const r of report.reviews) if (r.state === 'declined') declined.add(pairKey(r.video, r.slug));
  const queued = new Map((state?.queue ?? []).map((r, i) => [pairKey(r.video, r.slug), { ...r, index: i }]));
  const positiveIds = new Set();
  for (const e of entries.values()) for (const v of e.videos ?? []) positiveIds.add(v.youtube);
  const sourceHits = { site: new Set(), title: new Map(), channel: new Set() };
  const scopes = { site: null, title: new Map(), channel: new Map() };
  let landingFound = 0;
  let checked = 0, channelChecks = 0;
  const usableIds = new Set();
  const check = async (ids) => {
    const pending = [...new Set(ids.filter(isId))].filter((id) => !cache.has(id));
    for (let i = 0; i < pending.length; i += 50) {
      const batch = pending.slice(i, i + 50);
      const r = await youtubeGet('videos', { part: 'snippet,status,contentDetails', id: batch.join(','), maxResults: '50' }, ctx);
      if (!r) break;
      const returned = new Map(r.items.filter((v) => batch.includes(v.id)).map((v) => [v.id, v]));
      for (const id of batch) {
        const v = returned.get(id) ?? null;
        cache.set(id, v);
        if (isChannel(v?.snippet?.channelId) && slugsIn(v.snippet.description).some((slug) => entries.get(slug)?.status === 'live')) report.channels.push(v.snippet.channelId);
      }
      checked += batch.length;
    }
  };
  const note = (id, source, landing = false) => {
    const v = cache.get(id);
    if (!v) return;
    const result = usable(v, entries);
    if (isChannel(v.snippet?.channelId) && result.slugs.length) report.channels.push(v.snippet.channelId);
    if (result.reason === 'many-games') {
      if (!excludedVideos.has(id) && !result.slugs.every((slug) => offered.has(pairKey(id, slug)))) many.set(id, { video: id, n: result.slugs.length });
      return;
    }
    if (result.reason) return;
    usableIds.add(id);
    for (const slug of result.slugs) {
      const k = pairKey(id, slug), q = queued.get(k);
      const priority = q && ['form', 'manual'].includes(q.source) ? 0 : landing ? 1 : 2;
      const row = { slug, video: storedVideo(v, today), source: q?.source ?? source, priority, order: q?.index ?? Infinity };
      const previous = candidates.get(k);
      if (!previous || priority < previous.priority) candidates.set(k, row);
    }
  };

  // Queue, channel uploads, then refresh. Each discovery group is checked before moving on.
  await check((state?.queue ?? []).map((r) => r.video));
  for (const r of state?.queue ?? []) note(r.video, r.source);
  const refs = channelRefs(entries);
  const channels = new Set([GAMESBYAI_CHANNEL, ...(state?.channels ?? []), ...refs.filter((r) => r.id).map((r) => r.id)]);
  let handles = 0;
  for (const ref of refs.filter((r) => r.handle)) {
    if (handles >= MAX_HANDLES || channels.size >= MAX_CHANNELS) break;
    handles++;
    try {
      const r = await youtubeGet('channels', { part: 'id', forHandle: ref.handle }, ctx);
      if (!r) break;
      if (isChannel(r.items[0]?.id)) channels.add(r.items[0].id);
    } catch (err) { if (err.status !== 404) throw err; }
  }
  let pendingUploads = [];
  const flushUploads = async () => {
    if (!pendingUploads.length) return;
    await check(pendingUploads);
    for (const id of pendingUploads) note(id, 'channel');
    pendingUploads = [];
  };
  for (const channel of [...channels].slice(0, MAX_CHANNELS)) {
    if (budget.unitStopped || budget.baseUnits + budget.units >= 9_000) break;
    let r;
    try { r = await youtubeGet('playlistItems', { part: 'snippet,contentDetails', playlistId: uploadsPlaylist(channel), maxResults: '50' }, ctx); }
    catch (err) {
      if (err.status !== 404) throw err;
      if (channel === GAMESBYAI_CHANNEL) throw fixedError('channel');
      report.channelsGone.push(channel); continue;
    }
    if (!r) break;
    channelChecks++;
    report.channels.push(channel);
    const dates = r.items.map((it) => Date.parse(it.contentDetails?.videoPublishedAt)).filter(Number.isFinite);
    scopes.channel.set(channel, r.items.length === 50 && dates.length === 50 ? Math.min(...dates) : 0);
    for (const it of r.items) {
      const id = it.contentDetails?.videoId;
      if (!isId(id) || !slugsIn(it.snippet?.description).some((slug) => entries.get(slug)?.status === 'live')) continue;
      sourceHits.channel.add(id);
      if (channel === GAMESBYAI_CHANNEL) positiveIds.add(id);
      for (const slug of slugsIn(it.snippet.description)) explained.add(slug);
      if (!cache.has(id) && !pendingUploads.includes(id)) pendingUploads.push(id);
      if (pendingUploads.length >= 50) await flushUploads();
      if (cache.has(id)) note(id, 'channel');
    }
  }
  await flushUploads();
  const reviewIds = new Set([...(state?.reviews ?? []).map((r) => r[0]), ...report.reviews.map((r) => r.video)]);
  const yamlIds = [...new Set([...entries.values()].flatMap((e) => (e.videos ?? []).map((v) => v.youtube)))];
  await check([...yamlIds, ...reviewIds]);
  for (const id of reviewIds) if (cache.has(id)) report[cache.get(id) ? 'confirmed' : 'forget'].push(id);
  report.reviews = report.reviews.filter((r) => cache.get(r.video));
  let changes = [];
  for (const e of entries.values()) for (const old of e.videos ?? []) {
    if (!cache.has(old.youtube)) continue;
    const v = cache.get(old.youtube), result = usable(v, entries);
    const reason = result.reason && result.reason !== 'many-games' ? result.reason : !result.slugs.includes(e.slug) ? 'link-removed' : null;
    if (reason) changes.push({ kind: 'Removed', slug: e.slug, youtube: old.youtube, reason });
    else {
      const next = storedVideo(v, old.added);
      if (old.title !== next.title || old.channel !== next.channel || old.channelId !== next.channelId) changes.push({ kind: 'Changed', slug: e.slug, youtube: old.youtube, reason: old.title !== next.title ? 'title' : 'channel', video: next });
    }
  }

  const planState = state && { ...state, quota };
  const plan = planSearches({ entries, state: planState, now, manual, searches, explained });
  const siteWindow = siteSince(state?.lastRun, now);
  const requests = [{ q: '"gamesbyai.win"', since: siteWindow, source: 'site' }, { q: 'gamesbyai', since: siteWindow, source: 'site' }, ...plan.map((p) => ({ ...p, q: searchQuery(entries.get(p.slug)), since: titleSince(entries.get(p.slug), state?.searched[p.slug]?.day), source: 'title' }))];
  const bucketCounts = { landings: 0, new: 0, played: 0, rotation: 0 };
  let completedSite = 0;
  for (const request of requests) {
    if (budget.unitStopped || budget.baseUnits + budget.units >= 9_000) break;
    const r = await youtubeGet('search', { part: 'id', type: 'video', q: request.q, order: 'relevance', maxResults: '50', publishedAfter: request.since }, ctx);
    if (!r) break;
    const ids = r.items.map((it) => it.id?.videoId).filter(isId);
    if (request.source === 'site') { scopes.site = request.since; for (const id of ids) sourceHits.site.add(id); }
    else {
      bucketCounts[request.bucket]++;
      scopes.title.set(request.slug, request.since); sourceHits.title.set(request.slug, new Set(ids));
    }
    await check(ids);
    if (ids.every((id) => cache.has(id))) {
      if (request.source === 'title') report.searched.push({ slug: request.slug, landing: request.landing, start: request.start });
      else completedSite++;
    }
    for (const id of ids) note(id, request.source, request.landing);
    if (request.landing && ids.some((id) => {
      const result = usable(cache.get(id), entries);
      return !result.reason && result.slugs.some((slug) => !entries.get(slug).videos?.some((v) => v.youtube === id) && !offered.has(pairKey(id, slug)) && !declined.has(pairKey(id, slug)) && !queued.has(pairKey(id, slug)));
    })) landingFound++;
  }

  // Measure returned known positives inside each source's searched scope and window.
  for (const source of ['site', 'title', 'channel']) {
    const found = new Set(), known = new Set();
    for (const id of positiveIds) {
      const v = cache.get(id);
      if (!v) continue;
      const published = Date.parse(v.snippet?.publishedAt);
      let inScope = false, hit = false;
      if (source === 'site') { inScope = scopes.site !== null && published >= Date.parse(scopes.site); hit = sourceHits.site.has(id); }
      if (source === 'channel') { inScope = scopes.channel.has(v.snippet?.channelId) && published >= scopes.channel.get(v.snippet.channelId); hit = sourceHits.channel.has(id); }
      if (source === 'title') for (const slug of slugsIn(v.snippet.description)) {
        if (scopes.title.has(slug) && published >= Date.parse(scopes.title.get(slug))) { inScope = true; hit ||= sourceHits.title.get(slug).has(id); }
      }
      if (inScope) { known.add(id); if (hit) found.add(id); }
    }
    const hits = source === 'title' ? new Set([...sourceHits.title.values()].flatMap((ids) => [...ids])) : sourceHits[source];
    report.counts[`${source}Found`] = [...hits].filter((id) => {
      const result = usable(cache.get(id), entries);
      return !result.reason && result.slugs.some((slug) => !entries.get(slug).videos?.some((v) => v.youtube === id) && !offered.has(pairKey(id, slug)) && !declined.has(pairKey(id, slug)) && !queued.has(pairKey(id, slug)));
    }).length;
    report.counts[`${source}Known`] = found.size;
    report.counts[`${source}Expected`] = known.size;
  }
  report.counts.landingSearches = bucketCounts.landings;
  report.counts.landingFound = landingFound;
  report.siteComplete = completedSite === 2;

  const drops = new Set(), seen = new Set(), rows = [];
  const counts = new Map([...entries.values()].map((e) => [e.slug, (e.videos ?? []).length]));
  if (!prOpen) for (const c of changes) if (c.kind === 'Removed') counts.set(c.slug, counts.get(c.slug) - 1);
  const rejectPair = (id, slug) => {
    const e = entries.get(slug), k = pairKey(id, slug);
    if (!e || e.status !== 'live' || e.videos?.some((v) => v.youtube === id) ||
        (!manualQueuePairs.has(k) && (offered.has(k) || excludedVideos.has(id) || declined.has(k)))) return 'final';
    if (!cache.has(id)) return 'temporary';
    const result = usable(cache.get(id), entries);
    if (['not-public', 'live', 'many-games'].includes(result.reason)) return 'temporary';
    if (result.reason || !result.slugs.includes(slug)) return 'final';
    return null;
  };
  for (const r of queued.values()) {
    const k = pairKey(r.video, r.slug), rejection = rejectPair(r.video, r.slug);
    if (rejection === 'final') drops.add(k);
    else if (rejection === 'temporary') seen.add(k);
  }
  const sorted = [...candidates.values()].sort((a, b) => a.priority - b.priority || a.order - b.order || cmp(a.slug, b.slug) || cmp(a.video.youtube, b.video.youtube));
  const overflow = (p) => {
    const k = pairKey(p.video.youtube, p.slug);
    if (queued.has(k)) seen.add(k);
    else report.enqueue.push({ video: p.video.youtube, slug: p.slug, source: p.source });
  };
  for (const p of sorted) {
    if (rejectPair(p.video.youtube, p.slug)) continue;
    if (prOpen || rows.length >= MAX_ROWS || counts.get(p.slug) >= MAX_PER_GAME) { overflow(p); continue; }
    rows.push(p); counts.set(p.slug, counts.get(p.slug) + 1);
  }
  let manyRows = [...many.values()];
  if (!prOpen) {
    while (Buffer.byteLength(prBody(rows, { changes, many: manyRows })) > MAX_BODY) {
      if (rows.length) overflow(rows.pop());
      else if (manyRows.length) manyRows.pop();
      else changes.pop();
    }
    const texts = new Map();
    for (const e of entries.values()) {
      const edits = changes.filter((c) => c.slug === e.slug);
      const additions = rows.filter((p) => p.slug === e.slug).map((p) => p.video);
      if (!edits.length && !additions.length) continue;
      let text = edits.length ? editVideos(e.text, edits) : e.text;
      if (additions.length) text = appendVideos(text, additions);
      texts.set(e.file, text);
    }
    const body = prBody(rows, { changes, many: manyRows });
    if (bodyFile) writeFileSync(bodyFile, body);
    for (const [file, text] of texts) writeFileSync(file, text);
    report.offered = rows.map((p) => [p.video.youtube, p.slug]);
  }
  const splitPair = (key) => key.split(':');
  report.drop = [...drops].map(splitPair);
  report.seen = [...seen].filter((k) => !report.offered.some(([v, s]) => pairKey(v, s) === k)).map(splitPair);
  for (const name of ['channels', 'channelsGone', 'confirmed', 'forget']) report[name] = [...new Set(report[name])];
  report.units = budget.units; report.searches = budget.searches;
  if (state && reportFile) {
    validateReport(report, now, 1_000_000);
    writeFileSync(reportFile, JSON.stringify(report));
  }
  log(`videos: landings ${bucketCounts.landings}; new ${bucketCounts.new}; played ${bucketCounts.played}; rotation ${bucketCounts.rotation}; channels ${channelChecks}; channels skipped ${Math.max(0, channels.size - MAX_CHANNELS)}; handles skipped ${Math.max(0, refs.filter((r) => r.handle).length - handles)}; checked ${checked}; usable ${usableIds.size}; proposed ${rows.length}; enqueued ${report.enqueue.length}; units ${budget.units}; searches ${budget.searches}`);
  if (budget.searchStopped) log('videos: quota stop (search)');
  if (budget.unitStopped || budget.baseUnits + budget.units >= 9_000) log('videos: quota stop (units)');
  return prOpen ? 0 : rows.length + changes.length + manyRows.length;
}

export async function main({ argv = process.argv, env = process.env, log = console.log } = {}) {
  const output = (count) => { if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `count=${count}\n`); };
  try {
    const arg = (name) => {
      const i = argv.indexOf(name);
      if (i < 0) return undefined;
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw fixedError('input');
      return argv[i + 1];
    };
    const searches = env.SEARCHES === '' || env.SEARCHES === undefined ? 5 : env.SEARCHES;
    searchCap(searches);
    if (!env.YOUTUBE_API_KEY) { log('videos: checked 0; proposed 0'); output(0); return 0; }
    const prs = arg('--prs');
    const count = await run({ key: env.YOUTUBE_API_KEY, prs: prs ? JSON.parse(readFileSync(prs, 'utf8')) : [], bodyFile: arg('--body'), reportFile: arg('--report'), notifyUrl: env.NOTIFY_URL, token: env.INTERNAL_VIDEOS_TOKEN, manual: env.EVENT_NAME === 'workflow_dispatch', searches, log });
    output(count); return 0;
  } catch (err) { log(`videos: run failed (${errorCode(err)})`); return 1; }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
