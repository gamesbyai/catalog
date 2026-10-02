import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import {
  slugsIn, youtubeId, appendVideos, prBody, clean, MAX_PER_GAME, MAX_ROWS, MAX_BODY,
  GAMESBYAI_CHANNEL, MAX_CHANNELS, MAX_HANDLES, channelRef, channelRefs, uploadsPlaylist,
  waitingFor, offeredPairs, pairKey, reviewOutcomes, planSearches, searchQuery, searchCap,
  titleSince, siteSince, usable, validateSiteState, loadSiteState, pacificDay,
  internalVideosUrl, youtubeGet, main, run, validateReport, REPORT_ARRAYS,
} from '../scripts/find-videos.mjs';
import { postReport, reportBatches, sealReport, recoverReport, reserveRunQuota } from '../scripts/videos-post.mjs';

const NOW = new Date('2026-10-02T09:17:00Z');
const vid = (c) => c.repeat(11);
const chan = (c) => 'UC' + c.repeat(22);
const idN = (i) => String(i).padStart(11, '0');
const channelN = (i) => 'UC' + String(i).padStart(22, '0');
const link = (slug) => `https://gamesbyai.win/games/${slug}/`;
const video = (id, description, extra = {}) => ({ id,
  status: { privacyStatus: 'public', uploadStatus: 'processed' }, contentDetails: {},
  snippet: { title: 'A video', channelTitle: 'A channel', channelId: chan('a'), description,
    liveBroadcastContent: 'none', publishedAt: '2026-10-01T00:00:00Z', ...extra },
});
const row = (slug, id, extra = {}) => ({ slug, source: 'site', video: { youtube: id, title: 'Title', channel: 'Channel', added: '2026-10-02', ...extra } });
const entry = (slug, extra = {}) => [slug, { slug, title: slug, status: 'live', dates: { added: '2026-01-01' }, ...extra }];
const state = (extra = {}) => ({ day: '2026-10-02', quota: { workerUnits: 0, jobUnits: 0, jobSearches: 0 }, lastRun: null,
  queue: [], signals: [], reviews: [], channels: [], played: [], ...extra,
  searched: Object.fromEntries(Object.entries(extra.searched ?? {}).map(([slug, s]) => [slug, { start: null, ...s }])) });
const pr = (number, extra = {}) => ({ number, state: 'OPEN', headRefName: 'videos/2026-10-01-1', isCrossRepository: false, body: '', ...extra });
const tempDirs = [];
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

test('Many games exclusions stay video-level across a large catalog', () => {
  const entries = new Map(Array.from({ length: 1000 }, (_, i) => entry(`game-${i}`)));
  const prs = Array.from({ length: 4 }, (_, i) => pr(i + 1, { state: 'CLOSED', closedAt: NOW.toISOString(),
    body: prBody([row('game-0', vid('z'))], { many: Array.from({ length: 300 }, (_, n) => ({ video: idN(i * 300 + n), n: 4 })) }) }));
  assert.equal(reviewOutcomes(prs, entries, NOW).length, 1);
  assert.equal(offeredPairs(prs, entries.keys()).size, 1);
});

test('title completion waits for all result IDs to be verified', async () => {
  const api = fakeYouTube({ search: (p) => p.q.startsWith('game ') ? [vid('a')] : [],
    fail: ({ path }) => path === 'videos' ? { reason: 'quotaExceeded' } : null });
  const result = await dryRun([entry('game')], api, { searches: 1 });
  assert.deepEqual(result.report.searched, []);
});

test('unchecked and confirmed-missing review outcomes are never upserted', async () => {
  const prs = [pr(1, { state: 'CLOSED', closedAt: NOW.toISOString(), body: prBody([row('game', vid('a'))]) })];
  for (const limited of [true, false]) {
    const result = await dryRun([entry('game')], fakeYouTube(), { prs,
      siteState: state({ quota: { workerUnits: 0, jobUnits: limited ? 9000 : 0, jobSearches: 0 } }) });
    assert.deepEqual(result.report.reviews, []);
    assert.deepEqual(result.report.forget, limited ? [] : [vid('a')]);
  }
});

test('delayed landing runs retain the first search through +3 and +7 reports', async () => {
  const s = state({ signals: [{ slug: 'game', days: 1, last: '2026-09-25', yesterday: 0, median: 1 }] });
  for (const day of ['2026-09-29', '2026-10-02', '2026-10-06']) {
    const now = new Date(`${day}T09:17:00Z`); s.day = pacificDay(now);
    const result = await dryRun([entry('game')], fakeYouTube(), { now, siteState: s, searches: 1 });
    assert.equal(result.report.searched[0]?.landing, true, day);
    for (const r of result.report.searched) s.searched[r.slug] = { day, landing: day, start: r.start };
  }
});

test('split reports delete all obsolete pairs before using their queue capacity', async () => {
  const { report } = await dryRun([], fakeYouTube());
  report.drop = Array.from({ length: 2000 }, (_, i) => [idN(i), 'game']);
  report.enqueue = Array.from({ length: 5001 }, (_, i) => ({ video: idN(i + 2000), slug: `game-${'x'.repeat(180)}`, source: 'site' }));
  const apply = (batches) => {
    const queue = new Set(report.drop.map(([v, s]) => pairKey(v, s)));
    for (const b of batches) {
      for (const [v, s] of [...b.offered, ...b.drop]) queue.delete(pairKey(v, s));
      for (const r of b.enqueue) if (queue.size < 2000) queue.add(pairKey(r.video, r.slug));
    }
    return [...queue];
  };
  assert.deepEqual(apply(reportBatches(report, NOW)), apply([report]));
});

test('failed calls reserve quota first and never create a discovery report', async () => {
  const root = catalog([entry('game')]), reportFile = join(root, 'report.json'), reservations = [];
  const api = fakeYouTube({ fail: () => ({ reason: 'keyInvalid' }) });
  await assert.rejects(run({ key: 'test-key', root, reportFile, siteState: state(), now: NOW,
    fetchImpl: api.fetchImpl, reserveQuota: async (r) => { reservations.push(r); return true; }, log: () => {} }));
  assert.equal(reservations.length, 1);
  assert.equal(existsSync(reportFile), false);
});

test('transient report failure retries stable batches and next-run recovery keeps the full spool', async () => {
  const r = await dryRun([], fakeYouTube());
  r.report.confirmed = Array.from({ length: 5001 }, (_, i) => idN(i));
  writeFileSync(r.reportFile, JSON.stringify(r.report));
  let calls = 0; const ids = [];
  await assert.rejects(postReport({ reportFile: r.reportFile, notifyUrl: 'https://example.test', token: 'token', now: NOW,
    log: () => {}, sleep: async () => {}, fetchImpl: async (_url, options) => {
      calls++; ids.push(JSON.parse(options.body).batchId);
      return calls === 1 ? Response.json({ overflow: 0 }) : new Response('', { status: 503 });
    } }));
  assert.equal(calls, 4);
  assert.equal(new Set(ids.slice(1)).size, 1);
  assert.match(ids[0], /^[a-f0-9]{64}$/);
  const recovered = [];
  await postReport({ reportFile: r.reportFile, notifyUrl: 'https://example.test', token: 'token', now: new Date(NOW.getTime() + 3 * 864e5),
    log: () => {}, fetchImpl: async (_url, options) => { recovered.push(JSON.parse(options.body).batchId); return Response.json({ overflow: 0 }); } });
  assert.deepEqual(recovered, [ids[0], ids[1]]);
});
function catalog(entries) {
  const root = mkdtempSync(join(tmpdir(), 'find-videos-'));
  tempDirs.push(root); mkdirSync(join(root, 'games'));
  for (const [slug, e] of entries) writeFileSync(join(root, 'games', `${slug}.yaml`), `# Keep entry\n${stringify(e)}`);
  return root;
}
const readGame = (root, slug) => readFileSync(join(root, 'games', `${slug}.yaml`), 'utf8');
function fakeYouTube({ details = [], uploads = {}, handles = {}, search = [], fail, site } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const u = new URL(url), path = u.pathname.split('/').pop(), params = Object.fromEntries(u.searchParams);
    calls.push({ host: u.host, path, ...params, options });
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    if (u.host !== 'www.googleapis.com') {
      assert.equal(u.origin, site?.origin); return Response.json(site.state);
    }
    assert.equal(u.pathname.startsWith('/youtube/v3/'), true);
    assert.equal(params.key, undefined); assert.equal(options.headers['X-Goog-Api-Key'], 'test-key');
    const error = fail?.({ path, ...params, index: calls.length });
    if (error) return Response.json({ error: { errors: [{ reason: error.reason ?? 'other' }] } }, { status: error.status ?? 403 });
    if (path === 'channels') return Response.json({ items: handles[params.forHandle] ? [{ id: handles[params.forHandle] }] : [] });
    if (path === 'playlistItems') return Response.json({ items: uploads[params.playlistId] ?? [] });
    if (path === 'search') return Response.json({ items: (typeof search === 'function' ? search(params) : search).map((videoId) => ({ id: { videoId } })) });
    if (path === 'videos') return Response.json({ items: details.filter((v) => params.id.split(',').includes(v.id)) });
    assert.fail('unexpected method');
  };
  return { calls, fetchImpl };
}
const upload = (v) => ({ snippet: { description: v.snippet.description }, contentDetails: { videoId: v.id, videoPublishedAt: v.snippet.publishedAt } });
async function dryRun(entries, api, extra = {}) {
  const root = catalog(entries), logs = [], bodyFile = join(root, 'body.md'), reportFile = join(root, 'report.json');
  const count = await run({ key: 'test-key', root, prs: [], bodyFile, reportFile, fetchImpl: api.fetchImpl, now: NOW,
    siteState: state(), manual: true, searches: 0, reserveQuota: async () => true, log: (s) => logs.push(s), ...extra });
  return { root, logs, count, bodyFile, reportFile, report: existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null };
}

test('shared cases enforce game link boundaries and YouTube URL forms', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/video-links-cases.json', import.meta.url), 'utf8'));
  for (const [text, expected] of cases.slugsIn) assert.deepEqual(slugsIn(text), expected, text);
  for (const [text, expected] of cases.youtubeId) assert.equal(youtubeId(text), expected, text);
  assert.equal(youtubeId(null), null);
});

test('clean and appendVideos preserve structure, comments, key order and surrounding content', () => {
  assert.equal(clean('a\n\tb\u202ec', 10), 'a b c');
  const v = row('x', vid('a')).video;
  for (const initial of ['', 'videos: []\n', 'videos: # Keep videos\n', 'videos: [] # Keep videos\n']) {
    const text = appendVideos(`# Entry\nslug: x\n${initial}status: live # Keep status\n`, [v]);
    assert.deepEqual(parse(text).videos, [v]);
    assert.match(text, /# Entry/); assert.match(text, /# Keep status/);
    if (initial.includes('#')) assert.match(text, /# Keep videos/);
    assert.equal(text.match(/^videos:/gm).length, 1);
    assert.equal(parse(appendVideos(text, [row('x', vid('b')).video])).videos.length, 2);
  }
  const original = stringify({ slug: 'x', description: 'A paragraph that folds across lines. '.repeat(8), status: 'live' });
  assert.ok(appendVideos(original, [v]).startsWith(original));
  for (const text of ['videos: {}\n', 'videos: text\n', 'videos: [\n', 'videos: []\nvideos: []\n', '- x\n']) assert.throws(() => appendVideos(text, [v]));
});

test('channel links and refs remain restricted, deduplicated and oldest first', () => {
  assert.deepEqual(channelRef('https://www.youtube.com/@Maker/videos'), { handle: '@maker' });
  assert.deepEqual(channelRef(`https://m.youtube.com/channel/${chan('a')}/shorts`), { id: chan('a') });
  for (const url of ['http://youtube.com/@maker', 'https://youtube.com.evil.example/@maker', 'https://user@youtube.com/@maker', 'https://youtube.com:443/@maker', 'https://youtube.com/@maker/videos/extra']) assert.equal(channelRef(url), null);
  const entries = new Map([entry('a', { creator: { youtube: '@Maker', links: [`https://youtube.com/channel/${chan('b')}`] } }),
    entry('b', { dates: { added: '2025-01-01' }, creator: { youtube: '@maker' }, videos: [{ youtube: vid('a'), channelId: chan('a') }] }),
    entry('draft', { status: 'draft', creator: { youtube: '@draft' } })]);
  assert.deepEqual(channelRefs(entries), [{ handle: '@maker', added: '2025-01-01' }, { id: chan('a'), added: '2025-01-01' }, { id: chan('b'), added: '2026-01-01' }]);
});

test('query cleaning, context terms, search caps and first/later windows', () => {
  assert.equal(searchCap('0'), 0); assert.equal(searchCap(90), 90);
  for (const value of [-1, 91, 1.5, '', '05', '5x']) assert.throws(() => searchCap(value));
  assert.equal(searchQuery({ title: '"Sky" | -Hop --Now' }), 'Sky Hop Now "gamesbyai.win"');
  assert.equal(searchQuery({ title: 'Snake' }), 'Snake "gamesbyai.win" "AI game"');
  assert.equal(titleSince({ dates: { added: '2026-09-30' } }), '2026-08-31T00:00:00.000Z');
  assert.equal(titleSince({ dates: { added: '2026-09-30' } }, '2026-10-01'), '2026-09-24T00:00:00.000Z');
  assert.equal(siteSince('2026-10-01', NOW), '2026-09-24T00:00:00.000Z');
  assert.equal(siteSince(null, NOW), '2026-09-02T09:17:00.000Z');
});

test('plan bucket order/caps, pair dedupe, ledger slots and no-state rotation', () => {
  const entries = new Map(Array.from({ length: 140 }, (_, i) => entry(`game-${i}`, { dates: { added: i >= 30 && i < 50 ? '2026-10-01' : '2026-01-01' } })));
  const s = state({ signals: Array.from({ length: 30 }, (_, i) => ({ slug: `game-${i}`, days: 2, last: '2026-10-01', yesterday: 1, median: 1 })), played: Array.from({ length: 10 }, (_, i) => `game-${i + 50}`) });
  const plan = planSearches({ entries, state: s, now: NOW });
  assert.equal(plan.length, 90); assert.equal(new Set(plan.map((p) => p.slug)).size, 90);
  assert.deepEqual(['landings', 'new', 'played', 'rotation'].map((b) => plan.filter((p) => p.bucket === b).length), [20, 10, 5, 55]);
  assert.ok(plan.slice(0, 20).every((p) => p.landing));
  for (const [spent, expected] of [[80, 10], [99, 0]]) assert.equal(planSearches({ entries, state: state({ quota: { workerUnits: 0, jobUnits: 0, jobSearches: spent } }), now: NOW }).length, expected);
  assert.equal(planSearches({ entries, state: s, now: NOW, manual: true, searches: 5 }).length, 5);
  const rotation = planSearches({ entries, now: NOW, manual: true, searches: 5 });
  const sorted = [...entries.values()].sort((a, b) => a.dates.added.localeCompare(b.dates.added) || a.slug.localeCompare(b.slug));
  const start = (Math.floor(NOW.getTime() / 86_400_000) * 5) % entries.size;
  assert.deepEqual(rotation.map((p) => p.slug), [...sorted.slice(start), ...sorted.slice(0, start)].slice(0, 5).map((e) => e.slug));
});

test('landing plan: same-day ordering, spacing, +3/+7, explained weekly, spikes and distinct days', () => {
  const entries = new Map(['fresh', 'rank', 'spike', 'explained', 'spaced', 'retry3', 'retry7'].map((s) => entry(s)));
  for (const s of ['spike', 'explained']) entries.get(s).videos = [row(s, vid('a')).video];
  const signal = (slug, extra = {}) => ({ slug, days: 1, last: '2026-10-01', yesterday: 1, median: 1, ...extra });
  const s = state({ signals: [signal('fresh'), signal('rank', { days: 5 }), signal('spike', { yesterday: 3 }), signal('explained'), signal('spaced'), signal('retry3', { last: '2026-09-28' }), signal('retry7', { last: '2026-09-24' })], searched: {
    fresh: { day: '2026-10-01', landing: null }, spike: { day: '2026-09-28', landing: '2026-09-28' }, explained: { day: '2026-09-28', landing: '2026-09-28' },
    spaced: { day: '2026-10-01', landing: '2026-10-01' }, retry3: { day: '2026-09-29', landing: '2026-09-29' }, retry7: { day: '2026-09-28', landing: '2026-09-28' } } });
  const landings = planSearches({ entries, state: s, now: NOW }).filter((p) => p.landing).map((p) => p.slug);
  assert.equal(landings[0], 'rank');
  for (const slug of ['fresh', 'spike', 'retry3', 'retry7']) assert.ok(landings.includes(slug), slug);
  for (const slug of ['explained', 'spaced']) assert.ok(!landings.includes(slug), slug);
  s.searched.explained.landing = '2026-09-25';
  assert.ok(planSearches({ entries, state: s, now: NOW }).some((p) => p.slug === 'explained' && p.landing));
});

test('new game ages, played weekly, never searched first and rotation age ties', () => {
  const entries = new Map([1, 2, 3, 7, 14, 21, 22].map((n) => entry(`age-${n}`, { dates: { added: new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10) } })));
  const searched = Object.fromEntries([...entries.keys()].map((s) => [s, { day: '2026-09-30', landing: null }]));
  assert.deepEqual(planSearches({ entries, state: state({ searched }), now: NOW }).filter((p) => p.bucket === 'new').map((p) => p.slug).sort(), ['age-1', 'age-14', 'age-21', 'age-3', 'age-7']);
  delete searched['age-2'];
  assert.ok(planSearches({ entries, state: state({ searched }), now: NOW }).some((p) => p.slug === 'age-2' && p.bucket === 'new'));
  const old = new Map([entry('never', { dates: { added: '2026-02-01' } }), entry('old'), entry('recent')]);
  const plan = planSearches({ entries: old, state: state({ searched: { old: { day: '2026-09-01', landing: null }, recent: { day: '2026-10-01', landing: null } }, played: ['recent', 'old'] }), now: NOW });
  assert.equal(plan[0].slug, 'old'); assert.equal(plan[0].bucket, 'played'); assert.equal(plan[1].slug, 'never');
  const explained = new Set();
  planSearches({ entries: new Map([entry('listed', { videos: [row('listed', vid('a')).video] })]), state: state(), now: NOW, explained });
  assert.equal(explained.size, 0, 'planning does not mutate its inputs');
});

test('usable publication/status/link gate excludes restricted, draft and many-game candidates', () => {
  const entries = new Map(['a', 'b', 'c', 'd'].map((s) => entry(s))); entries.set('draft', { status: 'draft' });
  const v = video(vid('a'), link('a'));
  assert.equal(usable(v, entries).reason, null);
  for (const privacyStatus of ['private', 'unlisted']) assert.equal(usable({ ...v, status: { privacyStatus, uploadStatus: 'processed' } }, entries).reason, 'not-public');
  assert.equal(usable({ ...v, status: { privacyStatus: 'public', uploadStatus: 'uploaded' } }, entries).reason, 'not-public');
  for (const liveBroadcastContent of ['live', 'upcoming']) assert.equal(usable(video(v.id, link('a'), { liveBroadcastContent }), entries).reason, 'live');
  assert.equal(usable({ ...v, contentDetails: { contentRating: { ytRating: 'ytAgeRestricted' } } }, entries).reason, 'age-restricted');
  for (const description of ['', link('draft')]) assert.equal(usable(video(v.id, description), entries).reason, 'link-removed');
  assert.equal(usable(video(v.id, ['a', 'b', 'c', 'd'].map(link).join(' ')), entries).reason, 'many-games');
});

test('body has defanged escaped text, ID links, Found by, and compatible offered pair parsing', () => {
  const body = prBody([row('a', vid('a'), { title: 'https://example.com www.example.com <b> @channel | **title**', channel: 'http://example.com' })], { many: [{ video: vid('m'), n: 4 }] });
  assert.match(body, /Found by/); assert.match(body, /hxxps/); assert.match(body, /www\\\[\.\\\]/);
  assert.doesNotMatch(body, /<img|https:\/\/example\.com|http:\/\/example\.com|(?<!\\)@channel|(?<!\\)\*\*title/);
  const old = `| [b](${link('b')}) | <img src="https://i.ytimg.com/vi/${vid('b')}/mqdefault.jpg" width="160"> | title | channel |`;
  const pairs = offeredPairs([pr(1, { body: `${body}\r\n${old}\nNote: ${old}\n${prBody([row('c', vid('c'))]).replace(`[${vid('c')}]`, `[${vid('d')}]`)}` }), pr(2, { isCrossRepository: true, body: prBody([row('z', vid('z'))]) })], ['a', 'b']);
  assert.deepEqual([...pairs].sort(), [pairKey(vid('a'), 'a'), pairKey(vid('b'), 'b')].sort());
  assert.deepEqual(waitingFor([pr(1), pr(2, { state: 'MERGED' }), pr(3, { isCrossRepository: true })]), [1]);
});

test('closed PR review outcomes compare pairs against main and ignore old/fork PRs', () => {
  const entries = new Map([entry('a', { videos: [row('a', vid('a')).video] }), entry('b')]);
  const body = prBody([row('a', vid('a')), row('b', vid('a'))]);
  const prs = [pr(1, { state: 'MERGED', body, closedAt: '2026-10-01T10:00:00Z' }), pr(2, { state: 'CLOSED', body: prBody([row('a', vid('b'))]), closedAt: '2026-10-01T10:00:00Z' }), pr(3, { state: 'CLOSED', body, closedAt: '2026-08-01T10:00:00Z' }), pr(4, { state: 'CLOSED', body, isCrossRepository: true, closedAt: '2026-10-01T10:00:00Z' })];
  assert.deepEqual(reviewOutcomes(prs, entries, NOW), [{ video: vid('a'), slug: 'a', state: 'added', pr: 1 }, { video: vid('a'), slug: 'b', state: 'declined', pr: 1 }, { video: vid('b'), slug: 'a', state: 'declined', pr: 2 }]);
});

test('offline dry run writes YAML, body/report and checks queue/uploads/refresh before relevance searches', async () => {
  const q = video(vid('q'), link('queue'));
  const u = video(vid('u'), link('upload'), { title: 'Play **this**', channelId: GAMESBYAI_CHANNEL });
  const s = video(vid('s'), link('stored'), { title: 'Title', channelTitle: 'Channel', channelId: undefined });
  const f = video(vid('f'), link('found'));
  const api = fakeYouTube({ details: [q, u, s, f], uploads: { [uploadsPlaylist(GAMESBYAI_CHANNEL)]: [upload(u)] }, search: [f.id] });
  const r = await dryRun([entry('queue'), entry('upload'), entry('stored', { videos: [row('stored', s.id).video] }), entry('found')], api,
    { siteState: state({ queue: [{ video: q.id, slug: 'queue', source: 'form', seen: false }] }), searches: 1 });
  assert.equal(r.count, 3);
  for (const [slug, v] of [['queue', q], ['upload', u], ['found', f]]) assert.equal(parse(readGame(r.root, slug)).videos[0].youtube, v.id);
  assert.match(readGame(r.root, 'queue'), /# Keep entry/); assert.match(readFileSync(r.bodyFile, 'utf8'), /site form/);
  assert.deepEqual(api.calls.map((c) => c.path), ['videos', 'playlistItems', 'videos', 'videos', 'search', 'videos', 'search', 'search']);
  assert.equal(r.report.units, 5); assert.equal(r.report.searches, 3); assert.equal(r.report.offered.length, 3);
  assert.deepEqual(Object.keys(r.report), ['day', 'run', 'runId', 'checkedAt', 'siteComplete', 'units', 'searches', 'searched', 'offered', 'enqueue', 'drop', 'seen', 'reviews', 'confirmed', 'forget', 'channels', 'channelsGone', 'counts']);
  assert.ok(api.calls.filter((c) => c.path === 'search').every((c) => c.order === 'relevance' && c.maxResults === '50'));
  assert.equal(api.calls.some((c) => c.options.method === 'POST'), false);
  assert.doesNotMatch(r.logs.join('\n'), /\bqueue\b|upload|stored|found|https:|googleapis|Play|A channel/);
});

test('open PR queues checked finds with state, and safely stops without state', async () => {
  const v = video(vid('a'), link('game')), api = fakeYouTube({ search: [v.id], details: [v] });
  const r = await dryRun([entry('game')], api, { prs: [pr(1)] });
  assert.equal(r.count, 0); assert.equal(parse(readGame(r.root, 'game')).videos, undefined); assert.equal(existsSync(r.bodyFile), false);
  assert.deepEqual(r.report.enqueue, [{ video: v.id, slug: 'game', source: 'site' }]);
  const stopped = fakeYouTube(), noState = await dryRun([entry('game')], stopped, { prs: [pr(1)], siteState: null });
  assert.equal(stopped.calls.length, 0); assert.equal(noState.report, null);
});

test('dedupe is per pair, so an offered video can still be proposed for another game', async () => {
  const v = video(vid('a'), `${link('a')} ${link('b')}`);
  const r = await dryRun([entry('a'), entry('b')], fakeYouTube({ search: [v.id], details: [v] }), { prs: [pr(1, { state: 'CLOSED', closedAt: '2026-10-01T10:00:00Z', body: prBody([row('a', v.id)]) })] });
  assert.equal(r.count, 1); assert.deepEqual(r.report.offered, [[v.id, 'b']]);
});

test('queue outcomes distinguish final, temporary, full, declined, gone and offered', async () => {
  const entries = [entry('game', { videos: Array.from({ length: 4 }, (_, i) => row('game', idN(i)).video) }), entry('open')];
  const details = entries[0][1].videos.map((v) => video(v.youtube, link('game'), { title: 'Title', channelTitle: 'Channel', channelId: undefined }));
  details.push(video(vid('t'), link('open'), { liveBroadcastContent: 'upcoming' }), video(vid('f'), link('game')), video(vid('r'), ''), video(vid('d'), link('open')), video(vid('u'), link('open')));
  const queue = ['t', 'f', 'r', 'd', 'u', 'g'].map((c) => ({ video: vid(c), slug: c === 'f' ? 'game' : 'open', source: 'form', seen: false }));
  const r = await dryRun(entries, fakeYouTube({ details }), { siteState: state({ queue, reviews: [[vid('d'), 'open', 'declined']] }) });
  assert.deepEqual(r.report.offered, [[vid('u'), 'open']]);
  assert.deepEqual(r.report.seen.sort(), [[vid('f'), 'game'], [vid('t'), 'open']].sort());
  assert.deepEqual(r.report.drop.sort(), [[vid('d'), 'open'], [vid('g'), 'open'], [vid('r'), 'open']].sort());
});

test('row and per-game caps preserve overflow, form order and body length', async () => {
  const entries = Array.from({ length: 70 }, (_, i) => entry(`game-${i}`));
  const details = entries.map(([slug], i) => video(idN(i), link(slug), { title: '<'.repeat(120), channelTitle: '<'.repeat(80) }));
  const queue = details.map((v, i) => ({ video: v.id, slug: `game-${i}`, source: 'form', seen: false }));
  const r = await dryRun(entries, fakeYouTube({ details }), { siteState: state({ queue }) });
  assert.equal(r.count, MAX_ROWS); assert.equal(r.report.offered.length, 60); assert.equal(r.report.seen.length, 10);
  assert.deepEqual(r.report.offered[0], [idN(0), 'game-0']); assert.ok(Buffer.byteLength(readFileSync(r.bodyFile, 'utf8')) <= MAX_BODY);
  const five = Array.from({ length: 5 }, (_, i) => video(idN(i), link('one')));
  const limited = await dryRun([entry('one')], fakeYouTube({ details: five, search: five.map((v) => v.id) }));
  assert.equal(limited.count, MAX_PER_GAME); assert.equal(limited.report.enqueue.length, 1);
});

test('oversized refresh body defers edits; many-game candidates create a body-only PR', async () => {
  const entries = Array.from({ length: 900 }, (_, i) => entry(`game-${'long-'.repeat(8)}${i}`, { videos: [row('x', idN(i)).video] }));
  const r = await dryRun(entries, fakeYouTube());
  assert.ok(r.count > 0 && r.count < entries.length); assert.ok(Buffer.byteLength(readFileSync(r.bodyFile, 'utf8')) <= MAX_BODY);
  assert.ok(entries.some(([slug]) => parse(readGame(r.root, slug)).videos));
  const v = video(vid('m'), ['a', 'b', 'c', 'd'].map(link).join(' '));
  const many = await dryRun(['a', 'b', 'c', 'd'].map((s) => entry(s)), fakeYouTube({ search: [v.id], details: [v] }));
  assert.equal(many.count, 1); assert.match(readFileSync(many.bodyFile, 'utf8'), /Many games:/); assert.equal(many.report.offered.length, 0);
  for (const s of ['a', 'b', 'c', 'd']) assert.equal(parse(readGame(many.root, s)).videos, undefined);
});

test('refresh cleans metadata, removes links, confirms/forgets IDs and handles gone channels', async () => {
  const entries = [entry('a', { videos: [row('a', vid('a')).video, row('a', vid('b')).video] })];
  const v = video(vid('a'), link('a'), { title: 'New\u0000title', channelTitle: 'New channel' });
  const api = fakeYouTube({ details: [v], fail: (p) => p.path === 'playlistItems' && p.playlistId === uploadsPlaylist(chan('g')) ? { status: 404 } : null });
  const r = await dryRun(entries, api, { siteState: state({ reviews: [[vid('a'), 'a', 'added'], [vid('b'), 'a', 'declined']], channels: [chan('g')] }) });
  assert.equal(r.count, 2);
  assert.deepEqual(parse(readGame(r.root, 'a')).videos, [{ ...row('a', vid('a')).video, title: 'New title', channel: 'New channel', channelId: chan('a') }]);
  assert.match(readFileSync(r.bodyFile, 'utf8'), /## Changed/); assert.match(readFileSync(r.bodyFile, 'utf8'), /## Removed/);
  assert.deepEqual(r.report.confirmed, [vid('a')]); assert.deepEqual(r.report.forget, [vid('b')]); assert.deepEqual(r.report.channelsGone, [chan('g')]);
  await assert.rejects(dryRun(entries, fakeYouTube({ fail: (p) => p.path === 'playlistItems' ? { status: 404 } : null })), (e) => e.code === 'channel');
});

test('quota errors preserve checked finds and stop only their bucket; invalid key fails', async () => {
  const v = video(vid('a'), link('game')); let n = 0;
  const api = fakeYouTube({ details: [v], uploads: { [uploadsPlaylist(GAMESBYAI_CHANNEL)]: [upload(v)] }, fail: (p) => p.path === 'search' && ++n === 1 ? { reason: 'quotaExceeded' } : null });
  const r = await dryRun([entry('game')], api);
  assert.equal(r.count, 1); assert.equal(r.report.searches, 1); assert.match(r.logs.join('\n'), /quota stop \(search\)/);
  const units = fakeYouTube({ details: [v], fail: (p) => p.path === 'playlistItems' ? { reason: 'dailyLimitExceeded' } : null });
  const stopped = await dryRun([entry('game')], units, { siteState: state({ queue: [{ video: v.id, slug: 'game', source: 'form', seen: false }] }) });
  assert.equal(stopped.count, 1); assert.equal(stopped.report.searches, 0); assert.equal(units.calls.at(-1).path, 'playlistItems');
  assert.match(stopped.logs.join('\n'), /quota stop \(units\)/);
  await assert.rejects(dryRun([entry('game')], fakeYouTube({ fail: () => ({ reason: 'keyInvalid' }) })), (e) => e.code === 'keyInvalid');
});

test('unit safety ceiling and spent search ledger prevent further spending', async () => {
  const api = fakeYouTube();
  const r = await dryRun([entry('game')], api, { siteState: state({ quota: { workerUnits: 5000, jobUnits: 3999, jobSearches: 100 } }) });
  assert.equal(r.report.units, 1); assert.equal(r.report.searches, 0); assert.equal(api.calls.length, 1);
  const noSearch = await dryRun([entry('game')], fakeYouTube(), { siteState: state({ quota: { workerUnits: 0, jobUnits: 0, jobSearches: 100 } }) });
  assert.equal(noSearch.report.searches, 0);
});

test('playlist descriptions filter candidates without a date cutoff; channel/handle reads are capped', async () => {
  const v = video(vid('a'), link('game'), { publishedAt: '2025-01-01T00:00:00Z' });
  const r = await dryRun([entry('game')], fakeYouTube({ details: [v], uploads: { [uploadsPlaylist(GAMESBYAI_CHANNEL)]: [upload(v)] } }));
  assert.equal(r.count, 1);
  const refs = Array.from({ length: MAX_HANDLES + 5 }, (_, i) => `https://youtube.com/@maker${i}`), api = fakeYouTube();
  await dryRun([entry('game', { creator: { links: refs } })], api, { siteState: state({ channels: Array.from({ length: MAX_CHANNELS + 5 }, (_, i) => channelN(i)) }) });
  assert.equal(api.calls.filter((c) => c.path === 'playlistItems').length, MAX_CHANNELS);
  const handles = fakeYouTube(); await dryRun([entry('game', { creator: { links: refs } })], handles);
  assert.equal(handles.calls.filter((c) => c.path === 'channels').length, MAX_HANDLES);
  const details = Array.from({ length: 2_500 }, (_, i) => video(idN(i), link('game')));
  const uploads = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [uploadsPlaylist(channelN(i)), details.slice(i * 50, (i + 1) * 50).map(upload)]));
  const all = await dryRun([entry('game')], fakeYouTube({ details, uploads }), { siteState: state({ channels: Array.from({ length: 50 }, (_, i) => channelN(i)) }) });
  assert.equal(all.report.units, 101, '51 playlist reads and 50 candidate batches');
  assert.equal(all.report.enqueue.length, 2_496, 'filtered matches beyond forty batches are retained');
});

test('state validation, GET authentication, Pacific day, size/error fallback and absent report', async () => {
  assert.equal(validateSiteState(state(), NOW).day, '2026-10-02');
  assert.equal(validateSiteState(state({ signals: [{ slug: 'game', days: 2, last: '2026-10-01', yesterday: 4, median: 1.5 }] }), NOW).signals[0].median, 1.5);
  const invalid = [state({ day: '2026-02-30' }), state({ queue: [{ video: 'bad', slug: 'x', source: 'form', seen: false }] }), state({ signals: [{ slug: 'x', days: 15, last: '2026-10-01', yesterday: 0, median: 0 }] }), state({ reviews: [[vid('a'), 'bad_slug', 'declined']] }), state({ channels: ['bad'] }), state({ played: Array(21).fill('game') }), state({ searched: { game: { day: '2026-10-03', landing: null } } }), state({ quota: { workerUnits: 0, jobUnits: 0, jobSearches: 101 } }), state({ queue: Array(2001).fill({ video: vid('a'), slug: 'x', source: 'form', seen: false }) })];
  for (const s of invalid) assert.throws(() => validateSiteState(s, NOW));
  assert.equal(pacificDay(new Date('2026-10-02T06:00:00Z')), '2026-10-01'); assert.equal(internalVideosUrl('http://example.test'), null);
  assert.equal(await loadSiteState({ now: NOW, fetchImpl: () => assert.fail('no request') }), null);
  assert.equal(await loadSiteState({ now: NOW, notifyUrl: 'https://example.test/path', token: 'token', fetchImpl: async () => new Response('{}', { status: 500 }) }), null);
  const api = fakeYouTube({ site: { origin: 'https://example.test', state: state() } });
  assert.equal((await loadSiteState({ notifyUrl: 'https://example.test/unused', token: 'token', now: NOW, fetchImpl: api.fetchImpl })).day, '2026-10-02');
  assert.equal(api.calls[0].options.headers.Authorization, 'Bearer token');
  const fallback = await dryRun([entry('game')], fakeYouTube(), { siteState: invalid[0] });
  assert.equal(fallback.report, null); assert.match(fallback.logs.join('\n'), /site state unavailable/);
  assert.equal(await loadSiteState({ notifyUrl: 'https://example.test', token: 'token', now: NOW, fetchImpl: async () => new Response('x'.repeat(2_000_001)) }), null);
});

test('recall counts known positives inside each source scope and window', async () => {
  const v = video(vid('a'), link('game'), { channelId: GAMESBYAI_CHANNEL });
  const r = await dryRun([entry('game', { videos: [{ ...row('game', v.id).video, channelId: GAMESBYAI_CHANNEL, title: v.snippet.title, channel: v.snippet.channelTitle }] })], fakeYouTube({ details: [v], search: [v.id], uploads: { [uploadsPlaylist(GAMESBYAI_CHANNEL)]: [upload(v)] } }), { searches: 1 });
  assert.deepEqual(r.report.counts, { siteFound: 0, siteKnown: 1, siteExpected: 1, titleFound: 0, titleKnown: 1, titleExpected: 1, channelFound: 0, channelKnown: 1, channelExpected: 1, landingSearches: 0, landingFound: 0 });
  const missed = await dryRun([entry('game', { videos: [{ ...row('game', v.id).video, channelId: GAMESBYAI_CHANNEL, title: v.snippet.title, channel: v.snippet.channelTitle }] })], fakeYouTube({ details: [v] }), { searches: 1 });
  assert.equal(missed.report.counts.siteKnown, 0); assert.equal(missed.report.counts.siteExpected, 1);
  const fresh = video(vid('b'), link('game'));
  const found = await dryRun([entry('game')], fakeYouTube({ details: [fresh], search: [fresh.id] }), { searches: 1,
    siteState: state({ signals: [{ slug: 'game', days: 1, last: '2026-10-01', yesterday: 1, median: 0.5 }] }) });
  assert.equal(found.report.counts.siteFound, 1); assert.equal(found.report.counts.titleFound, 1);
  assert.equal(found.report.counts.landingSearches, 1); assert.equal(found.report.counts.landingFound, 1);
});

test('API and CLI failures never log raw exception details; CLI writes count=0 when safely stopped', async () => {
  await assert.rejects(youtubeGet('videos', { part: 'snippet', id: vid('a') }, { key: 'test-key', reserveQuota: async () => true, fetchImpl: async () => { throw new Error('private detail'); } }), (e) => e.code === 'network' && !e.message.includes('private'));
  const logs = []; assert.equal(await main({ argv: ['node', 'script'], env: { SEARCHES: '91' }, log: (s) => logs.push(s) }), 1);
  assert.deepEqual(logs, ['videos: run failed (input)']);
  const root = catalog([]), file = join(root, 'prs.json'), output = join(root, 'output'); writeFileSync(file, JSON.stringify([pr(1)]));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/find-videos.mjs', import.meta.url)), '--prs', file], {
    env: { ...process.env, YOUTUBE_API_KEY: 'test-key', NOTIFY_URL: '', INTERNAL_VIDEOS_TOKEN: '', GITHUB_OUTPUT: output, SEARCHES: '' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(output, 'utf8'), 'count=0\n');
  assert.doesNotMatch(result.stdout, /https:|#1|googleapis|gamesbyai\.win|test-key/);
});

test('postReport uses configured origin and token header, skips absent runs, and sanitizes failures', async () => {
  const r = await dryRun([entry('game')], fakeYouTube()), calls = [], logs = [];
  const result = await postReport({ reportFile: r.reportFile, notifyUrl: 'https://example.test/ignored', token: 'test-token', now: NOW, log: (s) => logs.push(s), fetchImpl: async (url, options) => {
    calls.push({ url, options }); return Response.json({ overflow: 2 });
  } });
  assert.equal(result.posted, true); assert.equal(result.overflow, 2);
  assert.equal(calls[0].url, internalVideosUrl('https://example.test')); assert.equal(calls[0].options.headers.authorization, 'Bearer test-token'); assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].options.body), reportBatches(r.report, NOW)[0]); assert.doesNotMatch(logs.join('\n'), /example|test-token|game/);
  const skip = () => assert.fail('must not post');
  assert.equal((await postReport({ reportFile: r.reportFile, fetchImpl: skip, log: () => {} })).posted, false);
  assert.equal((await postReport({ reportFile: join(r.root, 'missing'), notifyUrl: 'https://example.test', token: 'token', fetchImpl: skip, log: () => {} })).posted, false);
  await assert.rejects(postReport({ reportFile: r.reportFile, notifyUrl: 'https://example.test', token: 'token', now: NOW, fetchImpl: async () => { throw new Error('private detail'); }, log: () => {} }), (e) => !e.message.includes('private'));
});

test('large reports split within POST byte/array caps, preserve all rows and count quota once', async () => {
  const r = await dryRun([], fakeYouTube());
  r.report.units = 200; r.report.searches = 92;
  r.report.confirmed = Array.from({ length: 10_000 }, (_, i) => idN(i));
  r.report.reviews = Array.from({ length: 7_000 }, (_, i) => ({ video: idN(i), slug: `game-${'long-'.repeat(8)}${i}`, state: 'declined', pr: 1 }));
  const batches = reportBatches(r.report, NOW);
  assert.ok(batches.length >= 3);
  for (const batch of batches) {
    validateReport(batch, NOW);
    assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 512 * 1024);
    for (const key of REPORT_ARRAYS) assert.ok(batch[key].length <= 5_000);
  }
  for (const key of REPORT_ARRAYS) assert.deepEqual(batches.flatMap((b) => b[key]), r.report[key]);
  assert.equal(batches.reduce((sum, b) => sum + b.units, 0), 200);
  assert.equal(batches.reduce((sum, b) => sum + b.searches, 0), 92);
  writeFileSync(r.reportFile, JSON.stringify(r.report));
  let posted = 0;
  await postReport({ reportFile: r.reportFile, notifyUrl: 'https://example.test', token: 'token', now: NOW, log: () => {}, fetchImpl: async (_url, options) => {
    validateReport(JSON.parse(options.body), NOW); posted++; return Response.json({ overflow: 0 });
  } });
  assert.equal(posted, batches.length);
  r.report.enqueue = [{ video: 'bad', slug: 'game', source: 'site' }];
  writeFileSync(r.reportFile, JSON.stringify(r.report));
  await assert.rejects(postReport({ reportFile: r.reportFile, notifyUrl: 'https://example.test', token: 'token', now: NOW, log: () => {}, fetchImpl: () => assert.fail('invalid report must not post') }), (e) => e.code === 'input');
});

test('landing retries use recorded searches after a delayed first search; Many games handles iterators', () => {
  const entries = new Map([entry('game')]);
  const s = state({ signals: [{ slug: 'game', days: 1, last: '2026-09-25', yesterday: 0, median: 1 }], searched: { game: { day: '2026-09-29', landing: '2026-09-29' } } });
  assert.ok(planSearches({ entries, state: s, now: NOW }).some((p) => p.landing), '+3 after the recorded search');
  const one = prBody([], { many: [{ video: vid('a'), n: 4 }, { video: vid('b'), n: 4 }] });
  const two = prBody([], { many: [{ video: vid('c'), n: 4 }] });
  const pairs = offeredPairs([pr(1, { body: one }), pr(2, { body: two })], entries.keys());
  assert.deepEqual([...pairs], []);
});

test('unit ceiling preserves the queue on unchecked batches and scheduled/manual ledger reserves apply', async () => {
  const api = fakeYouTube();
  const r = await dryRun([entry('game')], api, { siteState: state({ quota: { workerUnits: 5_000, jobUnits: 4_000, jobSearches: 0 }, queue: [{ video: vid('a'), slug: 'game', source: 'form', seen: false }] }) });
  assert.equal(api.calls.length, 0); assert.deepEqual(r.report.seen, [[vid('a'), 'game']]); assert.deepEqual(r.report.drop, []);
  const entries = Array.from({ length: 100 }, (_, i) => entry(`game-${i}`));
  for (const [manual, expected] of [[false, 84], [true, 92]]) {
    const run = await dryRun(entries, fakeYouTube(), { manual, searches: 90, siteState: state({ quota: { workerUnits: 0, jobUnits: 0, jobSearches: 8 } }) });
    assert.equal(run.report.searches, expected);
  }
});

test('workflow scopes credentials, passes inputs through env, and posts only after PR success', () => {
  const wf = parse(readFileSync(new URL('../.github/workflows/videos.yml', import.meta.url), 'utf8'));
  assert.equal(wf.on.schedule[0].cron, '17 9 * * *'); assert.equal(String(wf.on.workflow_dispatch.inputs.searches.default), '5'); assert.deepEqual(wf.permissions, { contents: 'read', 'pull-requests': 'read', actions: 'read' });
  const steps = wf.jobs.find.steps, list = steps.findIndex((s) => /gh pr list/.test(s.run ?? '')), find = steps.findIndex((s) => /scripts\/find-videos\.mjs/.test(s.run ?? '')), open = steps.findIndex((s) => /gh pr create/.test(s.run ?? '')), post = steps.findIndex((s) => s.name === 'Record video discovery report');
  assert.ok(list < find && find < open && open < post); assert.equal(steps[post].if, 'success()');
  for (const field of ['number', 'state', 'headRefName', 'isCrossRepository', 'body', 'closedAt', 'mergedAt']) assert.ok(steps[list].run.includes(field));
  assert.equal(steps[find].env.GH_TOKEN, undefined); assert.ok(steps[find].env.SEARCHES.includes('inputs.searches')); assert.ok(steps[find].env.INTERNAL_VIDEOS_TOKEN); assert.ok(steps[post].env.INTERNAL_VIDEOS_TOKEN);
  assert.equal(steps.find((s) => /npm ci/.test(s.run ?? '')).env, undefined);
  const app = steps.find((s) => s.id === 'app'); assert.equal(app.with['permission-contents'], 'write'); assert.equal(app.with['permission-pull-requests'], 'write');
  assert.match(steps[open].run, /videos\/\$day-\$GITHUB_RUN_ID/); assert.match(steps[open].run, /60000/); assert.match(steps[open].env.GH_TOKEN, /steps\.app\.outputs\.token/);
  for (const step of steps) assert.doesNotMatch(step.run ?? '', /\$\{\{/);
  const recover = steps.findIndex((s) => s.run?.includes('--recover'));
  const seal = steps.findIndex((s) => s.run?.includes('--seal'));
  const persist = steps.findIndex((s) => s.uses === 'actions/upload-artifact@v4');
  assert.ok(recover < find && open < seal && seal < persist && persist < post);
  assert.match(steps[persist].with.path, /report\.enc$/);
});

test('durable recovery encrypts private state and resumes stable batches after process loss', async () => {
  const r = await dryRun([], fakeYouTube());
  const recoveryFile = join(r.root, 'outbox', 'report.enc');
  sealReport({ reportFile: r.reportFile, recoveryFile, token: 'test-token', now: NOW });
  assert.equal(readFileSync(recoveryFile).includes(Buffer.from(r.report.runId)), false);
  const expected = reportBatches(r.report, NOW).map((b) => b.batchId), ids = [];
  rmSync(r.reportFile);
  const options = { recoveryFile, token: 'test-token', notifyUrl: 'https://example.test', now: new Date(NOW.getTime() + 3 * 864e5), log: () => {},
    fetchImpl: async (_url, init) => { ids.push(JSON.parse(init.body).batchId); return Response.json({ overflow: 0 }); } };
  assert.equal((await recoverReport(options)).posted, true);
  assert.deepEqual(ids, expected);
  await assert.rejects(recoverReport({ ...options, token: 'wrong' }));
  const corrupted = readFileSync(recoveryFile); corrupted[corrupted.length - 1] ^= 1; writeFileSync(recoveryFile, corrupted);
  await assert.rejects(recoverReport(options));
});

test('reservation response loss retries the same identity before each charged call', async () => {
  const ids = [], calls = [];
  let lost = true;
  const reserveQuota = reserveRunQuota({ runId: 'run-test', now: NOW, notifyUrl: 'https://example.test', token: 'test-token', sleep: async () => {},
    fetchImpl: async (_url, init) => { ids.push(JSON.parse(init.body).id); if (lost) { lost = false; throw new Error('lost'); } return Response.json({ reserved: true }); } });
  await youtubeGet('videos', {}, { key: 'test-key', reserveQuota, fetchImpl: async () => { calls.push('youtube'); return Response.json({ items: [] }); } });
  assert.deepEqual(ids, ['run-test:0', 'run-test:0']); assert.equal(calls.length, 1);
  await assert.rejects(youtubeGet('videos', {}, { key: 'test-key', fetchImpl: () => assert.fail('unreserved call') }));
});
