import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProfile, ALLOWED, allowedList } from '../scripts/profiles.mjs';

// input → [kind, normalised url, handle, label]
const ACCEPTED = [
  ['https://x.com/demo_creator', 'x', 'https://x.com/demo_creator', 'demo_creator', '@demo_creator'],
  ['http://twitter.com/Demo_Creator/', 'x', 'https://x.com/Demo_Creator', 'Demo_Creator', '@Demo_Creator'],
  ['https://www.x.com/demo?s=20#top', 'x', 'https://x.com/demo', 'demo', '@demo'],
  ['HTTPS://GITHUB.COM/demo-creator', 'github', 'https://github.com/demo-creator', 'demo-creator', 'demo-creator'],
  ['https://demo-creator.itch.io/', 'itch', 'https://demo-creator.itch.io', 'demo-creator', 'demo-creator'],
  ['https://m.youtube.com/@demo_creator?si=abc', 'youtube', 'https://www.youtube.com/@demo_creator', 'demo_creator', '@demo_creator'],
  ['https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv', 'youtube', 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv', 'UCabcdefghijklmnopqrstuv', 'YouTube channel'],
  ['https://bsky.app/profile/Demo.bsky.social', 'bluesky', 'https://bsky.app/profile/demo.bsky.social', 'demo.bsky.social', 'demo.bsky.social'],
  ['https://bsky.app/profile/did:plc:abcdefghijklmnopqrstuvwx', 'bluesky', 'https://bsky.app/profile/did:plc:abcdefghijklmnopqrstuvwx', 'did:plc:abcdefghijklmnopqrstuvwx', 'Bluesky profile'],
  ['https://reddit.com/u/demo-creator', 'reddit', 'https://reddit.com/user/demo-creator', 'demo-creator', 'demo-creator'],
  ['https://www.twitch.tv/demo_creator', 'twitch', 'https://twitch.tv/demo_creator', 'demo_creator', 'demo_creator'],
  ['https://www.tiktok.com/@demo.creator', 'tiktok', 'https://tiktok.com/@demo.creator', 'demo.creator', '@demo.creator'],
  ['https://www.instagram.com/demo.creator/', 'instagram', 'https://instagram.com/demo.creator', 'demo.creator', '@demo.creator'],
  ['https://www.linkedin.com/in/demo-creator/', 'linkedin', 'https://linkedin.com/in/demo-creator', 'demo-creator', 'demo-creator'],
  ['https://www.threads.net/@demo_creator', 'threads', 'https://threads.net/@demo_creator', 'demo_creator', '@demo_creator'],
];

const REJECTED = [
  '', 'demo_creator', 'x.com/demo_creator', 'javascript:alert(1)', 'ftp://x.com/demo',
  'https://x.com/demo/status/1234567890', 'https://x.com/intent/follow?screen_name=demo', 'https://x.com/share?url=a', 'https://x.com/search?q=demo',
  'https://github.com/demo/repo', 'https://github.com/orgs', 'https://demo.itch.io/some-game', 'https://www.itch.io',
  'https://www.youtube.com/watch?v=abc123', 'https://youtu.be/abc123', 'https://www.youtube.com/@demo/videos',
  'https://bsky.app/profile/demo.bsky.social/post/abc', 'https://www.reddit.com/r/games', 'https://www.twitch.tv/directory',
  'https://www.tiktok.com/@demo/video/123', 'https://www.instagram.com/p/abc123', 'https://www.linkedin.com/company/demo', 'https://www.threads.net/demo',
  'https://x.com.evil.test/demo', 'https://evilx.com/demo', 'https://x.com./demo', 'https://x.com@evil.test/demo', 'https://user:pass@x.com/demo',
  'https://x.com:8443/demo', `https://x.com/${'a'.repeat(16)}`, `https://github.com/${'a'.repeat(40)}`, 'https://github.com/-demo',
];

test('every allowed site accepts its profile URL, normalised', () => {
  for (const [input, kind, url, handle, label] of ACCEPTED) assert.deepEqual(parseProfile(input), { kind, url, handle, label }, input);
  const kinds = new Set(ACCEPTED.map(([, k]) => k));
  for (const a of ALLOWED) assert.ok(kinds.has(a.kind), `a test case for ${a.kind}`);
});

test('posts, search, share and intent links, other schemes, lookalike hosts, userinfo, ports and overlong names are refused', () => {
  for (const input of REJECTED) assert.equal(parseProfile(input), null, input);
  assert.equal(parseProfile(undefined), null);
});

test('the help text names every site', () => {
  assert.equal(allowedList(), 'X, GitHub, itch.io, YouTube, Bluesky, Reddit, Twitch, TikTok, Instagram, LinkedIn or Threads');
});
