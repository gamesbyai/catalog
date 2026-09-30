import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify } from 'yaml';
import { slugsIn, proposals, appendVideos, prBody, clean, findVideos, MAX_PER_GAME } from '../scripts/find-videos.mjs';

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
