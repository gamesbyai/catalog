import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
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
  assert.throws(() => appendVideos('videos:\n  - youtube: x\nstatus: live\n', [v]), /last key/);
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
