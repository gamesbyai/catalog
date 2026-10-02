import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import {
  slugsIn, proposals, appendVideos, prBody, clean, findVideos, MAX_PER_GAME, GAMESBYAI_CHANNEL, MAX_CHANNELS, WINDOW_DAYS, WAIT_WARN_DAYS,
  channelRef, channelRefs, resolveChannels, recentUploads, uploadsPlaylist, waitingFor, longWaits, searchSince, offeredIds, run,
} from '../scripts/find-videos.mjs';

const video = (id, description, extra = {}) => ({ id, snippet: { title: `Playing ${id}`, channelTitle: 'Some Channel', channelId: 'UC' + 'a'.repeat(22), description, liveBroadcastContent: 'none', ...extra } });
const entry = (slug, extra = {}) => [slug, { slug, status: 'live', ...extra }];

test('slugsIn: game page links on gamesbyai.win only', () => {
  assert.deepEqual(slugsIn('Play it: https://gamesbyai.win/games/sky-hop/ and www.gamesbyai.win/games/Moon-Run\nhttps://gamesbyai.win/games/sky-hop'), ['sky-hop', 'moon-run']);
  assert.deepEqual(slugsIn('https://notgamesbyai.win/games/sky-hop/ https://gamesbyai.win/top/ gamesbyai.win'), []);
});

test('proposals: listed live games only, no duplicates, at most four per game', () => {
  const entries = new Map([
    entry('sky-hop'),
    entry('full', { videos: Array.from({ length: MAX_PER_GAME }, (_, i) => ({ youtube: `full000000${i}` })) }),
    entry('gone', { status: 'removed' }),
    entry('has-it', { videos: [{ youtube: 'dupdupdup01' }] }),
  ]);
  const vids = [
    video('aaaaaaaaaaa', 'https://gamesbyai.win/games/sky-hop/ https://gamesbyai.win/games/full/ https://gamesbyai.win/games/gone/ https://gamesbyai.win/games/unknown/'),
    video('dupdupdup01', 'https://gamesbyai.win/games/has-it/'),
    video('bbbbbbbbbbb', 'https://gamesbyai.win/games/sky-hop/', { title: '  Sky\u0000Hop ‮ run  ' }),
  ];
  const p = proposals(vids, entries, '2026-10-05');
  assert.deepEqual(p.map((x) => [x.slug, x.video.youtube]), [['sky-hop', 'aaaaaaaaaaa'], ['sky-hop', 'bbbbbbbbbbb']]);
  assert.equal(p[1].video.title, 'Sky Hop run', 'control and direction characters removed');
  assert.deepEqual(p[0].video, { youtube: 'aaaaaaaaaaa', title: 'Playing aaaaaaaaaaa', channel: 'Some Channel', channelId: 'UC' + 'a'.repeat(22), added: '2026-10-05' });
});

test('appendVideos adds a block or extends the last one, and the result parses', () => {
  const v = { youtube: 'aaaaaaaaaaa', title: 'A "quoted": title # not a comment', channel: 'Chan: nel', added: '2026-10-05' };
  const one = appendVideos('slug: sky-hop\nstatus: live\n', [v]);
  assert.deepEqual(parse(one).videos, [v]);
  const two = appendVideos(one, [{ ...v, youtube: 'bbbbbbbbbbb' }]);
  assert.equal(parse(two).videos.length, 2);
  assert.equal(parse(two).status, 'live');
  const middle = appendVideos('videos:\n  - youtube: x\nstatus: live\n', [v]);
  assert.deepEqual(parse(middle).videos, [{ youtube: 'x' }, v]);
  assert.deepEqual(Object.keys(parse(middle)), ['videos', 'status']);
});

for (const initial of ['videos: []', 'videos: # Keep videos', 'videos: [] # Keep videos']) {
  test(`appendVideos updates ${initial} without duplicate keys and preserves comments and order`, () => {
    const v = { youtube: 'aaaaaaaaaaa', title: 'A "quoted": title # not a comment', channel: 'Channel', added: '2026-10-05' };
    const text = `# Entry comment\nslug: sky-hop\n${initial}\nstatus: live # Keep status\n`;
    const out = appendVideos(text, [v]);
    assert.deepEqual(parse(out), { slug: 'sky-hop', videos: [v], status: 'live' });
    assert.deepEqual(Object.keys(parse(out)), ['slug', 'videos', 'status']);
    assert.equal(out.match(/^videos:/gm).length, 1);
    assert.match(out, /# Entry comment/);
    assert.match(out, /# Keep status/);
    if (initial.includes('#')) assert.match(out, /# Keep videos/);
  });
}

test('appendVideos preserves existing video comments and safely quotes new video text', () => {
  const text = 'slug: sky-hop\nvideos:\n  # Existing video\n  - youtube: bbbbbbbbbbb # Keep ID\n    title: Original\n    channel: Channel\n    added: 2026-10-04\nstatus: live\n';
  const v = { youtube: 'aaaaaaaaaaa', title: 'title\nvideos: []', channel: '# Channel: [name]', added: '2026-10-05' };
  const out = appendVideos(text, [v]);
  assert.deepEqual(parse(out).videos, [{ youtube: 'bbbbbbbbbbb', title: 'Original', channel: 'Channel', added: '2026-10-04' }, v]);
  assert.match(out, /# Existing video/);
  assert.match(out, /# Keep ID/);
  assert.equal(out.match(/^videos:/gm).length, 1);
});

test('appendVideos leaves the rest of a real entry byte for byte', () => {
  // Entries are written by yaml's stringify, which folds long text at 80 columns.
  const text = stringify({ slug: 'sky-hop', tagline: 'A long tagline that runs well past eighty characters, so the writer folds it onto a second line.', description: `${'A paragraph long enough to fold. '.repeat(6)}\n\nA second paragraph.\n`, status: 'live' });
  const v = { youtube: 'aaaaaaaaaaa', title: 'Title', channel: 'Channel', added: '2026-10-05' };
  const out = appendVideos(text, [v]);
  assert.ok(out.startsWith(text), 'folded text keeps its line breaks');
  assert.deepEqual(parse(out).videos, [v]);
});

test('appendVideos refuses invalid YAML and a non-sequence videos value', () => {
  const v = { youtube: 'aaaaaaaaaaa', title: 'Title', channel: 'Channel', added: '2026-10-05' };
  for (const text of ['slug: sky-hop\nvideos: []\nvideos: []\n', 'videos: [\n', 'videos: {}\n', 'videos: text\n', '- sky-hop\n']) {
    assert.throws(() => appendVideos(text, [v]));
  }
});

test('the PR body escapes video text', () => {
  const body = prBody([{ slug: 'sky-hop', video: { youtube: 'aaaaaaaaaaa', title: '[click](javascript:alert(1)) <img src=x> @someone', channel: '**bold**', added: '2026-10-05' } }]);
  assert.doesNotMatch(body, /\]\(javascript:|(?<!\\)<img src=x|(?<!\\)@someone|(?<!\\)\*\*bold/);
  assert.match(body, /https:\/\/i\.ytimg\.com\/vi\/aaaaaaaaaaa\/mqdefault\.jpg/);
});

test('findVideos searches twice, then fetches full descriptions; upcoming streams and odd IDs are dropped', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname.split('/').pop());
    if (u.pathname.endsWith('/search')) return Response.json({ items: [{ id: { videoId: 'aaaaaaaaaaa' } }, { id: { videoId: 'bad id' } }] });
    return Response.json({ items: [video('aaaaaaaaaaa', 'x'), video('ccccccccccc', 'y', { liveBroadcastContent: 'upcoming' })] });
  };
  const v = await findVideos({ key: 'k', since: '2026-09-25T00:00:00Z', fetchImpl });
  assert.deepEqual(calls, ['search', 'search', 'videos']);
  assert.deepEqual(v.map((x) => x.id), ['aaaaaaaaaaa']);
  assert.equal(clean('a\n\tb', 10), 'a b');
});

// Channel sources: the uploads of known channels are read next to the search, because search misses new channels and
// URLs in descriptions.

const chan = (c) => 'UC' + c.repeat(22);
const vid = (c) => c.repeat(11);
const upload = (videoId, videoPublishedAt) => ({ contentDetails: { videoId, videoPublishedAt } });
const SINCE = '2026-09-22T00:00:00.000Z';

/** A fake YouTube Data API. It records every call; `fail` maps a path, or `path:playlistId|handle`, to an HTTP status. */
function fakeYouTube({ search = [], uploads = {}, handles = {}, details = [], fail = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const path = u.pathname.split('/').pop();
    const p = Object.fromEntries(u.searchParams);
    calls.push({ path, ...p });
    const status = fail[path] ?? fail[`${path}:${p.playlistId ?? p.forHandle}`];
    if (status) return new Response('{}', { status });
    if (path === 'search') return Response.json({ items: search.map((videoId) => ({ id: { videoId } })) });
    if (path === 'playlistItems') return Response.json({ items: uploads[p.playlistId] ?? [] });
    if (path === 'channels') return Response.json(handles[p.forHandle] ? { items: [{ id: handles[p.forHandle] }] } : { pageInfo: { totalResults: 0 } });
    if (path === 'videos') return Response.json({ items: details.filter((v) => p.id.split(',').includes(v.id)) });
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, calls };
}

// Temporary directories the tests make; removed when the file's tests are done.
const tempDirs = [];
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

/** A temporary catalog root with the given games/<name> files. */
function catalog(files) {
  const root = mkdtempSync(join(tmpdir(), 'find-videos-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'games'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, 'games', name), text);
  return root;
}
const gameYaml = (slug, extra = '') => `# ${slug}\nslug: ${slug}\nstatus: live\ndates:\n  added: 2026-09-30\n${extra}`;
const readGame = (root, slug) => readFileSync(join(root, 'games', `${slug}.yaml`), 'utf8');

test('the GamesByAI channel is a channel id, and its uploads playlist is the id with UU for UC', () => {
  assert.match(GAMESBYAI_CHANNEL, /^UC[A-Za-z0-9_-]{22}$/);
  assert.equal(uploadsPlaylist(GAMESBYAI_CHANNEL), `UU${GAMESBYAI_CHANNEL.slice(2)}`);
  assert.equal(uploadsPlaylist(chan('a')), 'UU' + 'a'.repeat(22));
});

test('channelRef takes only https YouTube channel ids and @handles', () => {
  const id = chan('a');
  const good = [
    [`https://www.youtube.com/channel/${id}`, { id }],
    [`https://www.youtube.com/channel/${id}/`, { id }],
    [`https://youtube.com/channel/${id}?sub_confirmation=1#top`, { id }],
    [`https://m.youtube.com/channel/${id}`, { id }],
    ['https://www.youtube.com/@Some.Handle_1', { handle: '@some.handle_1' }],
    ['https://youtube.com/@ada/', { handle: '@ada' }],
    ['https://www.youtube.com/@ada?si=abc123', { handle: '@ada' }],
    // Creators often paste the link of a channel tab.
    ['https://www.youtube.com/@Maker/videos', { handle: '@maker' }],
    ['https://www.youtube.com/@maker/featured/', { handle: '@maker' }],
    ['https://m.youtube.com/@maker/shorts', { handle: '@maker' }],
    ['https://youtube.com/@maker/streams?view=2#top', { handle: '@maker' }],
    [`https://www.youtube.com/channel/${id}/videos`, { id }],
    [`https://www.youtube.com/channel/${id}/featured/`, { id }],
    [`https://www.youtube.com/channel/${id}/shorts?sub_confirmation=1`, { id }],
    [`https://www.youtube.com/channel/${id}/streams`, { id }],
  ];
  for (const [link, want] of good) assert.deepEqual(channelRef(link), want, link);
  const bad = [
    'http://www.youtube.com/@ada', 'https://www.youtube.com.evil.example/@ada', 'https://evilyoutube.com/@ada',
    'https://www.youtube.com@evil.example/@ada', 'https://user:pass@www.youtube.com/@ada', 'https://www.youtube.com:8443/@ada',
    'https://www.youtube.com/c/Ada', 'https://www.youtube.com/user/ada', 'https://www.youtube.com/@ad',
    `https://www.youtube.com/@${'a'.repeat(31)}`, 'https://www.youtube.com/@%E3%83%A6%E3%83%BC',
    'https://www.youtube.com/channel/UC123', `https://www.youtube.com/channel/${id}x`,
    // Only the four tabs, and only one: nothing else after the handle or the id.
    'https://www.youtube.com/@ada/videos/extra', 'https://www.youtube.com/@ada/videos/shorts', 'https://www.youtube.com/@ada/video',
    'https://www.youtube.com/@ada/Videos', 'https://www.youtube.com/@ada/playlists', 'https://www.youtube.com/@ada//videos', 'https://www.youtube.com/@ada/videosx',
    `https://www.youtube.com/channel/${id}/videos/x`, `https://www.youtube.com/channel/${id}/other`, `https://www.youtube.com/channel/${id}/videos/shorts`,
    `https://www.youtube.com/channel/uc${'a'.repeat(22)}`, `https://youtu.be/${vid('a')}`, `https://www.youtube.com/watch?v=${vid('a')}`,
    'https://example.com/@ada', 'javascript:alert(1)', 'not a url', '', undefined, null, 42, {}, ['https://www.youtube.com/@ada'],
  ];
  for (const link of bad) assert.equal(channelRef(link), null, String(link));
});

test('channelRefs: live entries only; listed videos, creator channel links and creator.youtube; one per channel; oldest-added first', () => {
  const live = (slug, extra) => [slug, { slug, status: 'live', ...extra }];
  const entries = new Map([
    live('a', {
      dates: { added: '2026-09-30' },
      videos: [{ youtube: vid('a'), channelId: chan('a') }, { youtube: vid('b'), channelId: 'bad' }, { youtube: vid('c') }],
      creator: { links: ['https://example.com/', 'https://www.youtube.com/@Zed', `https://www.youtube.com/channel/${chan('b')}`, 'https://www.youtube.com/c/legacy'] },
    }),
    live('b', { dates: { added: '2026-09-29' }, creator: { youtube: '@zed', links: [`https://www.youtube.com/channel/${chan('a')}`] } }),
    ['c', { slug: 'c', status: 'removed', dates: { added: '2026-01-01' }, videos: [{ channelId: chan('z') }], creator: { youtube: '@gone' } }],
    ['d', { slug: 'd', status: 'draft', creator: { links: ['https://www.youtube.com/@draftonly'] } }],
    live('e', { creator: { youtube: 'not-a-handle', links: 'https://www.youtube.com/@notalist' }, videos: 'nope' }),
  ]);
  assert.deepEqual(channelRefs(entries), [
    { handle: '@zed', added: '2026-09-29' },
    { id: chan('a'), added: '2026-09-29' },
    { id: chan('b'), added: '2026-09-30' },
  ]);
});

// Catalogs that name many YouTube channels in a few files. Each group is [date added, channel numbers]: one live game
// per group, with a creator link per channel. The channels sort by the date added, then by number.
const chanN = (i) => 'UC' + String(i).padStart(22, '0');
const nums = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);
const channelCatalog = (groups) => catalog(Object.fromEntries(groups.map(([added, numbers], g) => [
  `game-${g}.yaml`,
  `slug: game-${g}\nstatus: live\ndates:\n  added: ${added}\ncreator:\n  links:\n${numbers.map((n) => `    - https://www.youtube.com/channel/${chanN(n)}\n`).join('')}`,
])));
const playlistsRead = (api) => api.calls.filter((c) => c.path === 'playlistItems').map((c) => c.playlistId);
const ourPr = (number, state, createdAt, extra = {}) => ({ number, state, headRefName: 'videos/2026-10-01', isCrossRepository: false, body: '', createdAt, ...extra });

test('run reads every known channel on every run that searches, whatever days the job waited in between', async () => {
  // 100 channels is twice the old per-run slice. The job searches on days 1, 3 and 5 and waits on days 2, 4 and 6, when
  // a PR is open: a calendar-day rotation would read the same half of the channels each time.
  const root = channelCatalog([['2026-09-01', nums(0, 60)], ['2026-09-02', nums(60, 100)]]);
  const everything = [uploadsPlaylist(GAMESBYAI_CHANNEL), ...nums(0, 100).map((i) => uploadsPlaylist(chanN(i)))].sort();
  const open = [ourPr(5, 'OPEN', '2026-10-01T06:30:00Z')];
  let searches = 0;
  for (let day = 1; day <= 6; day++) {
    const api = fakeYouTube();
    const searching = day % 2 === 1;
    await run({ key: 'k', root, prs: searching ? [] : open, fetchImpl: api.fetchImpl, now: new Date(Date.UTC(2026, 9, day, 6, 23)), log: () => {} });
    if (searching) {
      searches += 1;
      assert.deepEqual(playlistsRead(api).sort(), everything, `day ${day}: all 100 channels and the GamesByAI channel`);
    } else {
      assert.equal(api.calls.length, 0, `day ${day}: waiting, nothing is called`);
    }
  }
  assert.equal(searches, 3);
});

test('run reads at most MAX_CHANNELS catalog channels, oldest added first, and warns with counts only when some are left out', async () => {
  const over = 20;
  // The newer group comes first in the file names and has the lower channel numbers, so only the dates added can put
  // the older channels first.
  const older = ['2026-01-01', nums(over, MAX_CHANNELS + over)];
  const newer = ['2026-06-01', nums(0, over)];
  const api = fakeYouTube();
  const logs = [];
  await run({ key: 'k', root: channelCatalog([newer, older]), prs: [], fetchImpl: api.fetchImpl, now: new Date('2026-10-02T06:23:00Z'), log: (m) => logs.push(m) });
  const read = playlistsRead(api);
  assert.equal(read.length, MAX_CHANNELS + 1, 'the GamesByAI channel and the first MAX_CHANNELS');
  assert.ok(nums(over, MAX_CHANNELS + over).every((i) => read.includes(uploadsPlaylist(chanN(i)))), 'every older channel is read');
  assert.ok(nums(0, over).every((i) => !read.includes(uploadsPlaylist(chanN(i)))), 'the newest are the ones left out');
  const warnings = logs.filter((m) => m.startsWith('::warning::'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], new RegExp(`names ${MAX_CHANNELS + over} YouTube channels but only the first ${MAX_CHANNELS} are read .*so ${over} are skipped`));
  assert.match(logs.join('\n'), new RegExp(`${MAX_CHANNELS + 1} channels read \\(${MAX_CHANNELS + over} known in the catalog`), 'the GamesByAI channel counts as read');
  // Exactly at the cap nothing is left out, so there is nothing to warn about.
  const atCap = fakeYouTube();
  const quiet = [];
  await run({ key: 'k', root: channelCatalog([older]), prs: [], fetchImpl: atCap.fetchImpl, now: new Date('2026-10-02T06:23:00Z'), log: (m) => quiet.push(m) });
  assert.equal(playlistsRead(atCap).length, MAX_CHANNELS + 1);
  assert.deepEqual(quiet.filter((m) => m.includes('::warning::')), []);
});

test('resolveChannels: ids pass through, each handle costs one lookup, missing or gone handles are skipped, other errors stop the run', async () => {
  const api = fakeYouTube({ handles: { '@one': chan('1'), '@dup': chan('d'), '@odd': 'not-an-id' }, fail: { 'channels:@gone': 404 } });
  const stats = {};
  const refs = [{ id: chan('d') }, { handle: '@one' }, { handle: '@dup' }, { handle: '@nobody' }, { handle: '@gone' }, { handle: '@odd' }];
  assert.deepEqual(await resolveChannels(refs, { key: 'k', fetchImpl: api.fetchImpl, stats }), [chan('d'), chan('1')]);
  assert.deepEqual(api.calls.map((c) => [c.path, c.part, c.forHandle]), ['@one', '@dup', '@nobody', '@gone', '@odd'].map((h) => ['channels', 'id', h]));
  assert.equal(stats.handlesUnresolved, 3);
  await assert.rejects(resolveChannels([{ handle: '@x' }], { key: 'k', fetchImpl: fakeYouTube({ fail: { channels: 403 } }).fetchImpl }), /channels answered 403/);
});

test('recentUploads reads the uploads playlist and keeps the videos published inside the window', async () => {
  const api = fakeYouTube({
    uploads: {
      [uploadsPlaylist(chan('a'))]: [
        upload(vid('a'), '2026-10-01T16:11:58Z'),
        upload(vid('b'), '2026-09-22T00:00:00Z'), // exactly at the start of the window: in
        upload(vid('c'), '2026-09-21T23:59:59Z'), // a second before: out
        upload(vid('d'), undefined),
        upload(vid('e'), 'yesterday'),
        upload('short', '2026-10-01T00:00:00Z'),
        upload(['x'], '2026-10-01T00:00:00Z'),
      ],
    },
  });
  assert.deepEqual(await recentUploads(chan('a'), { key: 'k', since: SINCE, fetchImpl: api.fetchImpl }), [vid('a'), vid('b')]);
  assert.deepEqual(api.calls, [{ path: 'playlistItems', part: 'contentDetails', playlistId: 'UU' + 'a'.repeat(22), maxResults: '50', key: 'k' }]);
});

test('findVideos also reads channel uploads, so a video the search missed is found', async () => {
  const api = fakeYouTube({
    uploads: { [uploadsPlaylist(GAMESBYAI_CHANNEL)]: [upload(vid('j'), '2026-10-01T16:11:58Z'), upload(vid('o'), '2026-08-01T00:00:00Z')] },
    details: [video(vid('j'), 'Play https://gamesbyai.win/games/jelly-pond/ now'), video(vid('o'), 'old')],
  });
  const stats = {};
  const found = await findVideos({ key: 'k', since: SINCE, channels: [GAMESBYAI_CHANNEL], fetchImpl: api.fetchImpl, stats });
  assert.deepEqual(api.calls.map((c) => c.path), ['search', 'search', 'playlistItems', 'videos']);
  assert.deepEqual(found.map((v) => v.id), [vid('j')]);
  assert.deepEqual(stats, { searchHits: 0, channelsRead: 1, uploads: 1, candidates: 1, usable: 1 });
  assert.equal(api.calls[3].id, vid('j'));
  assert.equal('maxResults' in api.calls[3], false, 'videos.list does not take maxResults together with id');
  // The usual rules still decide what is proposed.
  const p = proposals(found, new Map([entry('jelly-pond')]), '2026-10-02');
  assert.deepEqual(p.map((x) => [x.slug, x.video.youtube]), [['jelly-pond', vid('j')]]);
});

test('findVideos: one candidate list across sources, checked 50 ids at a time, newest first', async () => {
  const id = (i) => `v${String(i).padStart(10, '0')}`;
  const range = (a, b) => Array.from({ length: b - a }, (_, i) => id(a + i));
  const at = '2026-10-01T00:00:00Z';
  const api = fakeYouTube({
    search: range(0, 50),
    uploads: {
      [uploadsPlaylist(chan('a'))]: range(25, 75).map((v) => upload(v, at)),
      [uploadsPlaylist(chan('b'))]: range(60, 110).map((v) => upload(v, at)),
    },
    details: range(0, 110).map((v, n) => video(v, 'x', { publishedAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString() })),
  });
  const stats = {};
  const found = await findVideos({ key: 'k', since: SINCE, channels: [chan('a'), chan('b'), chan('a')], fetchImpl: api.fetchImpl, stats });
  const asked = api.calls.filter((c) => c.path === 'videos').map((c) => c.id.split(','));
  assert.deepEqual(asked.map((ids) => ids.length), [50, 50, 10]);
  assert.equal(new Set(asked.flat()).size, 110, 'every candidate once, however many sources named it');
  assert.equal(api.calls.filter((c) => c.path === 'playlistItems').length, 2, 'a channel named twice is read once');
  assert.deepEqual(stats, { searchHits: 50, channelsRead: 2, uploads: 100, candidates: 110, usable: 110 });
  assert.equal(found.length, 110);
  assert.deepEqual([found[0].id, found.at(-1).id], [id(109), id(0)]);
});

test('findVideos: a gone channel is skipped, but the GamesByAI channel and every other API error stop the run', async () => {
  const gone = chan('g');
  const ok = chan('a');
  const api = (fail) => fakeYouTube({ fail, uploads: { [uploadsPlaylist(ok)]: [upload(vid('a'), '2026-10-01T00:00:00Z')] }, details: [video(vid('a'), 'x')] });
  const base = { key: 'k', since: SINCE, channels: [gone, ok], required: [GAMESBYAI_CHANNEL] };
  const stats = {};
  const found = await findVideos({ ...base, fetchImpl: api({ [`playlistItems:${uploadsPlaylist(gone)}`]: 404 }).fetchImpl, stats });
  assert.deepEqual(found.map((v) => v.id), [vid('a')]);
  assert.deepEqual([stats.channelsGone, stats.channelsRead], [1, 1]);
  await assert.rejects(findVideos({ ...base, channels: [GAMESBYAI_CHANNEL], fetchImpl: api({ playlistItems: 404 }).fetchImpl }), /playlistItems answered 404/);
  await assert.rejects(findVideos({ ...base, fetchImpl: api({ [`playlistItems:${uploadsPlaylist(gone)}`]: 500 }).fetchImpl }), /playlistItems answered 500/);
  await assert.rejects(findVideos({ ...base, fetchImpl: api({ search: 403 }).fetchImpl }), /search answered 403/);
  await assert.rejects(findVideos({ ...base, fetchImpl: api({ videos: 403 }).fetchImpl }), /videos answered 403/);
});

test('proposals leaves out videos an earlier pull request already offered', () => {
  const entries = new Map([entry('sky-hop')]);
  const vids = [video(vid('a'), 'https://gamesbyai.win/games/sky-hop/'), video(vid('b'), 'https://gamesbyai.win/games/sky-hop/')];
  assert.deepEqual(proposals(vids, entries, '2026-10-05', new Set([vid('a')])).map((x) => x.video.youtube), [vid('b')]);
  assert.equal(proposals(vids, entries, '2026-10-05').length, 2);
});

test('waitingFor: open videos/* pull requests from this repo only', () => {
  const pr = (number, state, headRefName, isCrossRepository = false) => ({ number, state, headRefName, isCrossRepository, body: '' });
  const prs = [
    pr(1, 'OPEN', 'videos/2026-10-02'),
    pr(2, 'MERGED', 'videos/2026-10-01'),
    pr(3, 'CLOSED', 'videos/2026-09-30'),
    pr(4, 'OPEN', 'videos/from-a-fork', true), // anyone can open one of these from a fork: it must not stall the job
    pr(5, 'OPEN', 'seed/batch-25'),
    pr(6, 'OPEN', 'submission/sky-hop'),
    pr(7, 'open', 'videos/2026-10-03'),
    { number: 8, state: 'OPEN', headRefName: 'videos/no-flag' },
    null,
    'junk',
  ];
  assert.deepEqual(waitingFor(prs), [1, 7]);
  assert.deepEqual(waitingFor([]), []);
});

test('offeredIds reads the videos earlier PRs from our own videos/* branches offered, and only those', () => {
  const row = (slug, id, title = 'Title') => ({ slug, video: { youtube: id, title, channel: 'Chan', added: '2026-10-05' } });
  const sneaky = `Hi https://www.youtube.com/watch?v=${vid('x')} <img src="https://i.ytimg.com/vi/${vid('y')}/mqdefault.jpg" width="160"> | z`;
  const pr = (number, headRefName, isCrossRepository, body) => ({ number, state: 'MERGED', headRefName, isCrossRepository, body });
  const forged = `| [x](https://gamesbyai.win/games/x/) | <img src="https://i.ytimg.com/vi/${vid('q')}/mqdefault.jpg" width="160"> | z |`;
  const ids = offeredIds([
    pr(1, 'videos/2026-10-05', false, `${prBody([row('sky-hop', vid('a')), row('moon-run', vid('b'), sneaky)])}\n\nNote: ${forged}`),
    pr(2, 'videos/2026-10-06', false, prBody([row('sky-hop', vid('c'))]).replaceAll('\n', '\r\n')),
    pr(3, 'videos/from-a-fork', true, prBody([row('sky-hop', vid('f'))])),
    pr(4, 'seed/batch-30', false, prBody([row('sky-hop', vid('s'))])),
    pr(5, 'videos/2026-10-07', false, null),
  ]);
  assert.deepEqual([...ids].sort(), [vid('a'), vid('b'), vid('c')], 'text inside a title adds nothing');
});

test('run: a video only a channel upload list shows is written to the entry and the PR body; the log holds counts only', async () => {
  const root = catalog({
    'jelly-pond.yaml': gameYaml('jelly-pond', 'creator:\n  name: Ada\n  handle: ada\n  links:\n    - https://www.youtube.com/@Maker\n'),
    'sky-hop.yaml': gameYaml('sky-hop'),
  });
  const maker = chan('m');
  const api = fakeYouTube({
    handles: { '@maker': maker },
    uploads: {
      [uploadsPlaylist(GAMESBYAI_CHANNEL)]: [upload(vid('j'), '2026-10-01T16:11:58Z')],
      [uploadsPlaylist(maker)]: [upload(vid('k'), '2026-09-30T00:00:00Z')],
    },
    details: [
      video(vid('j'), 'Play it\nhttps://gamesbyai.win/games/jelly-pond/', { title: 'Jelly **pond** [click](x)', channelTitle: 'Some Channel', channelId: GAMESBYAI_CHANNEL }),
      video(vid('k'), 'No link here'),
    ],
  });
  const logs = [];
  const bodyFile = join(root, 'body.md');
  const count = await run({ key: 'k', root, prs: [], bodyFile, fetchImpl: api.fetchImpl, now: new Date('2026-10-02T06:23:00Z'), log: (m) => logs.push(m), warn: (m) => logs.push(m) });
  assert.equal(count, 1);
  assert.deepEqual(api.calls.map((c) => c.path), ['channels', 'search', 'search', 'playlistItems', 'playlistItems', 'videos']);
  const text = readGame(root, 'jelly-pond');
  assert.match(text, /^# jelly-pond\n/, 'the rest of the entry is left alone');
  assert.deepEqual(parse(text).videos, [{ youtube: vid('j'), title: 'Jelly **pond** [click](x)', channel: 'Some Channel', channelId: GAMESBYAI_CHANNEL, added: '2026-10-02' }]);
  assert.equal(parse(readGame(root, 'sky-hop')).videos, undefined);
  const body = readFileSync(bodyFile, 'utf8');
  assert.match(body, new RegExp(`watch\\?v=${vid('j')}`));
  assert.doesNotMatch(body, /\*\*pond|\]\(x\)/, 'video text is escaped in the body');
  const log = logs.join('\n');
  assert.match(log, /2 channels read \(1 known in the catalog, 0 not found\), 2 uploads in the window; 2 videos checked, 2 usable; 1 to add/);
  assert.doesNotMatch(log, /pond|click|Some Channel/, 'no video text in the log');
});

test('run waits while a videos PR from this repo is open: no API call, nothing written', async () => {
  const root = catalog({ 'jelly-pond.yaml': gameYaml('jelly-pond') });
  const before = readGame(root, 'jelly-pond');
  const api = fakeYouTube();
  const logs = [];
  const open = [{ number: 12, state: 'OPEN', headRefName: 'videos/2026-10-01', isCrossRepository: false, body: '' }];
  assert.equal(await run({ key: 'k', root, prs: open, fetchImpl: api.fetchImpl, log: (m) => logs.push(m) }), 0);
  assert.equal(api.calls.length, 0);
  assert.match(logs.join('\n'), /waiting for the review of open pull request #12, so nothing is searched/);
  assert.equal(readGame(root, 'jelly-pond'), before);
  // A fork's PR on a videos/ branch and a merged PR do not hold the job back.
  const free = [
    { number: 13, state: 'OPEN', headRefName: 'videos/x', isCrossRepository: true, body: '' },
    { number: 14, state: 'MERGED', headRefName: 'videos/y', isCrossRepository: false, body: '' },
  ];
  assert.equal(await run({ key: 'k', root, prs: free, fetchImpl: api.fetchImpl, now: new Date('2026-10-02T06:23:00Z'), log: () => {} }), 0);
  assert.deepEqual(api.calls.map((c) => c.path), ['search', 'search', 'playlistItems']);
  await assert.rejects(run({ key: 'k', root, prs: { not: 'a list' }, fetchImpl: api.fetchImpl }), TypeError);
});

test('run does not offer a video again that an earlier PR offered, dropped in review or not', async () => {
  const root = catalog({ 'jelly-pond.yaml': gameYaml('jelly-pond') });
  const api = fakeYouTube({
    uploads: { [uploadsPlaylist(GAMESBYAI_CHANNEL)]: [upload(vid('a'), '2026-10-01T00:00:00Z'), upload(vid('b'), '2026-10-01T00:00:00Z')] },
    details: [video(vid('a'), 'https://gamesbyai.win/games/jelly-pond/'), video(vid('b'), 'https://gamesbyai.win/games/jelly-pond/')],
  });
  const earlier = {
    number: 20, state: 'MERGED', headRefName: 'videos/2026-10-01', isCrossRepository: false,
    body: prBody([{ slug: 'jelly-pond', video: { youtube: vid('a'), title: 'T', channel: 'C', added: '2026-10-01' } }]),
  };
  assert.equal(await run({ key: 'k', root, prs: [earlier], fetchImpl: api.fetchImpl, now: new Date('2026-10-02T06:23:00Z'), log: () => {} }), 1);
  assert.deepEqual(parse(readGame(root, 'jelly-pond')).videos.map((v) => v.youtube), [vid('b')]);
});

test('searchSince: WINDOW_DAYS back, or further back when a PR of ours paused the job', () => {
  const now = new Date('2026-10-20T06:23:00Z');
  const ago = (days) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const pr = (state, openedDaysAgo, closedDaysAgo, extra = {}) => ourPr(1, state, ago(openedDaysAgo), { closedAt: closedDaysAgo === undefined ? null : ago(closedDaysAgo), ...extra });
  assert.equal(WINDOW_DAYS, 10);
  assert.equal(searchSince([], now), ago(WINDOW_DAYS), 'no PRs');
  assert.equal(searchSince([pr('OPEN', 3)], now), ago(WINDOW_DAYS), 'a short wait is inside the window already');
  assert.equal(searchSince([pr('OPEN', 9)], now), ago(WINDOW_DAYS), 'the day before it was opened is the start of the window');
  assert.equal(searchSince([pr('OPEN', 12)], now), ago(13), 'open for 12 days: back to the day before it was opened');
  assert.equal(searchSince([pr('MERGED', 20, 2)], now), ago(21), 'closed inside the window: this run must still reach back');
  assert.equal(searchSince([pr('CLOSED', 20, 2)], now), ago(21), 'closed without merging counts the same');
  assert.equal(searchSince([pr('MERGED', 20, 10)], now), ago(21), 'closed exactly at the start of the window still counts');
  assert.equal(searchSince([pr('MERGED', 20, 11)], now), ago(WINDOW_DAYS), 'closed before the window: the run after it already reached back');
  assert.equal(searchSince([pr('MERGED', 200, 150)], now), ago(WINDOW_DAYS), 'an old PR does not stretch the window for ever');
  assert.equal(searchSince([pr('MERGED', 20, undefined)], now), ago(21), 'an unknown closing time counts as recent, so no gap is missed');
  assert.equal(searchSince([pr('MERGED', 20, undefined, { closedAt: '0001-01-01T00:00:00Z' })], now), ago(21), 'gh prints this for a time that was never set');
  assert.equal(searchSince([pr('MERGED', 20, 2), pr('MERGED', 40, 12), pr('MERGED', 30, 5)], now), ago(31), 'the earliest start among the PRs that count');
  const ignored = [
    pr('OPEN', 30, undefined, { isCrossRepository: true }), pr('OPEN', 30, undefined, { headRefName: 'seed/batch-31' }), pr('OPEN', 30, undefined, { createdAt: 'soon' }),
    pr('OPEN', 30, undefined, { createdAt: undefined }), pr('OPEN', 30, undefined, { createdAt: '0001-01-01T00:00:00Z' }), null, 'junk',
  ];
  assert.equal(searchSince(ignored, now), ago(WINDOW_DAYS), 'forks, other branches and PRs without a usable date change nothing');
  assert.equal(searchSince(undefined, now), ago(WINDOW_DAYS), 'no PR list');
});

test('longWaits: open PRs of ours older than two days, in whole days', () => {
  const now = new Date('2026-10-20T06:23:00Z');
  const ago = (hours) => new Date(now.getTime() - hours * 3600_000).toISOString();
  assert.equal(WAIT_WARN_DAYS, 2);
  assert.deepEqual(longWaits([
    ourPr(1, 'OPEN', ago(47)), ourPr(2, 'OPEN', ago(48)), ourPr(3, 'OPEN', ago(49)), ourPr(4, 'OPEN', ago(24 * 12 + 5)),
    ourPr(5, 'MERGED', ago(24 * 30)), ourPr(6, 'OPEN', ago(24 * 30), { isCrossRepository: true }), ourPr(7, 'OPEN', undefined), ourPr(8, 'OPEN', 'soon'),
    ourPr(9, 'OPEN', ago(-5)), null, 'junk',
  ], now), [{ number: 3, days: 2 }, { number: 4, days: 12 }]);
  assert.deepEqual(longWaits([], now), []);
});

test('run warns once an open videos PR has waited more than two days, and still searches nothing', async () => {
  const root = catalog({ 'jelly-pond.yaml': gameYaml('jelly-pond') });
  const api = fakeYouTube();
  const now = new Date('2026-10-05T06:23:00Z');
  const wait = async (prs) => {
    const logs = [];
    assert.equal(await run({ key: 'k', root, prs, fetchImpl: api.fetchImpl, now, log: (m) => logs.push(m) }), 0);
    return logs;
  };
  let logs = await wait([ourPr(12, 'OPEN', '2026-10-04T06:30:00Z')]);
  assert.equal(logs.length, 1, 'one day old: only the waiting line');
  assert.match(logs[0], /^videos: waiting for the review of open pull request #12, so nothing is searched$/);
  logs = await wait([ourPr(12, 'OPEN', '2026-10-01T06:30:00Z', { title: '::warning::injected', body: '::error::injected' })]);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /waiting for the review of open pull request #12/);
  assert.equal(logs[1], '::warning::videos: pull request #12 has been open for more than 3 days, so no videos are searched. Merge or close it; the next search reaches back to the day before it was opened.');
  assert.doesNotMatch(logs.join('\n'), /injected/, 'nothing from the PR text reaches the log');
  logs = await wait([ourPr(12, 'OPEN', '2026-10-01T06:30:00Z'), ourPr(13, 'OPEN', '2026-09-20T06:30:00Z'), ourPr(14, 'OPEN', '2026-10-05T00:00:00Z')]);
  assert.deepEqual(logs.filter((m) => m.startsWith('::warning::')).map((m) => /#(\d+) has been open for more than (\d+) days/.exec(m).slice(1)), [['12', '3'], ['13', '14']]);
  assert.equal(api.calls.length, 0, 'nothing is searched in any of these runs');
  // A PR that is not ours, or no longer open, neither holds the job back nor warns.
  logs = [];
  await run({ key: 'k', root, prs: [ourPr(15, 'OPEN', '2026-09-01T06:30:00Z', { isCrossRepository: true }), ourPr(16, 'MERGED', '2026-09-01T06:30:00Z', { closedAt: '2026-09-02T06:30:00Z' })], fetchImpl: api.fetchImpl, now, log: (m) => logs.push(m) });
  assert.deepEqual(logs.filter((m) => m.includes('::warning::')), []);
});

test('the script as the workflow runs it: an open PR in a gh-shaped file stops the run before any API call, the annotation is on stdout, count=0 is written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'find-videos-cli-'));
  tempDirs.push(dir);
  const prs = join(dir, 'prs.json');
  const output = join(dir, 'output');
  // As `gh pr list --state all --json …` prints it: an open PR has no closing time (gh shows the zero time).
  writeFileSync(prs, JSON.stringify([
    { number: 12, state: 'OPEN', headRefName: 'videos/2026-10-01', isCrossRepository: false, body: 'x', createdAt: '2020-01-01T00:00:00Z', closedAt: '0001-01-01T00:00:00Z' },
  ]));
  const script = fileURLToPath(new URL('../scripts/find-videos.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, '--prs', prs, '--body', join(dir, 'body.md')], {
    env: { ...process.env, YOUTUBE_API_KEY: 'not-a-real-key', GITHUB_OUTPUT: output }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.ok(lines.includes('videos: waiting for the review of open pull request #12, so nothing is searched'));
  assert.ok(lines.some((l) => /^::warning::videos: pull request #12 has been open for more than \d+ days, /.test(l)), 'a workflow command at the start of a stdout line');
  assert.equal(readFileSync(output, 'utf8'), 'count=0\n');
});

test('run reaches back over the days an open videos PR paused the job, so a long wait loses no video', async () => {
  // The PR was opened on 2026-10-01 and merged on the morning of 2026-10-13: 12 days in which nothing was searched.
  const now = new Date('2026-10-13T06:23:00Z');
  const link = 'https://gamesbyai.win/games/jelly-pond/';
  const uploads = {
    [uploadsPlaylist(GAMESBYAI_CHANNEL)]: [
      upload(vid('b'), '2026-10-12T00:00:00Z'), // inside the usual 10 days
      upload(vid('a'), '2026-10-02T12:00:00Z'), // published two days into the wait: outside the usual 10 days
      upload(vid('c'), '2026-10-01T12:00:00Z'), // offered by the PR itself
      upload(vid('d'), '2026-09-29T12:00:00Z'), // before the day the PR was opened
    ],
  };
  const details = ['a', 'b', 'c', 'd'].map((c) => video(vid(c), link));
  const offered = prBody([{ slug: 'jelly-pond', video: { youtube: vid('c'), title: 'T', channel: 'C', added: '2026-10-01' } }]);
  const merged = ourPr(30, 'MERGED', '2026-10-01T06:30:00Z', { closedAt: '2026-10-13T05:00:00Z', body: offered });
  const go = async (prs) => {
    const root = catalog({ 'jelly-pond.yaml': gameYaml('jelly-pond') });
    const api = fakeYouTube({ uploads, details });
    await run({ key: 'k', root, prs, fetchImpl: api.fetchImpl, now, log: () => {} });
    return { api, added: (parse(readGame(root, 'jelly-pond')).videos ?? []).map((v) => v.youtube).sort() };
  };
  const afterWait = await go([merged]);
  assert.deepEqual(afterWait.added, [vid('a'), vid('b')], 'the video from the wait is found; the PR\'s own video is not offered again');
  assert.equal(afterWait.api.calls.find((c) => c.path === 'search').publishedAfter, '2026-09-30T06:30:00.000Z', 'search starts the day before the PR was opened');
  const usual = await go([]);
  assert.deepEqual(usual.added, [vid('b')], 'without the wait only the usual 10 days are read, and the wait\'s video is lost');
  assert.equal(usual.api.calls.find((c) => c.path === 'search').publishedAfter, '2026-10-03T06:23:00.000Z');
  // Once the PR was closed before the window began, the run after it has long covered the wait.
  const settled = await go([{ ...merged, closedAt: '2026-10-02T05:00:00Z' }]);
  assert.deepEqual(settled.added, [vid('b')]);
});

test('videos.yml: daily, read-only PR access, the PR list handed to the script, the PR opened with the App token', () => {
  const wf = parse(readFileSync(new URL('../.github/workflows/videos.yml', import.meta.url), 'utf8'));
  assert.match(wf.on.schedule[0].cron, /^\d{1,2} \d{1,2} \* \* \*$/, 'daily');
  assert.ok('workflow_dispatch' in wf.on, 'can still be started by hand');
  assert.deepEqual(wf.permissions, { contents: 'read', 'pull-requests': 'read' });
  const steps = wf.jobs.find.steps;
  const list = steps.findIndex((s) => /gh pr list/.test(s.run ?? ''));
  const find = steps.findIndex((s) => /scripts\/find-videos\.mjs/.test(s.run ?? ''));
  assert.ok(list >= 0 && list < find, 'the PR list is written before the script reads it');
  assert.match(steps[list].run, /--state all/);
  const fields = /--json (\S+)/.exec(steps[list].run)?.[1].split(',') ?? [];
  for (const f of ['number', 'state', 'headRefName', 'isCrossRepository', 'body', 'createdAt', 'closedAt']) assert.ok(fields.includes(f), `gh pr list asks for ${f}`);
  assert.equal(steps[list].env.GH_TOKEN, '${{ github.token }}');
  assert.match(steps[find].run, /--prs "\$RUNNER_TEMP\/prs\.json"/);
  assert.equal(steps[find].env.GH_TOKEN, undefined, 'the script step does not see the GitHub token');
  const open = steps.find((s) => /gh pr create/.test(s.run ?? ''));
  assert.match(open.env.GH_TOKEN, /steps\.app\.outputs\.token/);
  assert.match(open.if, /steps\.find\.outputs\.count != '0'/);
});
