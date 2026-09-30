// A creator's profile link, from an allowlist of social sites. This is a copy for the issue converter: the site's
// src/lib/profiles.ts is the source, and the two must match (the site's tests compare them). Change both together.

/** The sites we accept, in the order the forms name them. */
export const ALLOWED = [
  { kind: 'x', name: 'X' },
  { kind: 'github', name: 'GitHub' },
  { kind: 'itch', name: 'itch.io' },
  { kind: 'youtube', name: 'YouTube' },
  { kind: 'bluesky', name: 'Bluesky' },
  { kind: 'reddit', name: 'Reddit' },
  { kind: 'twitch', name: 'Twitch' },
  { kind: 'tiktok', name: 'TikTok' },
  { kind: 'instagram', name: 'Instagram' },
  { kind: 'linkedin', name: 'LinkedIn' },
  { kind: 'threads', name: 'Threads' },
];

/** "X, GitHub, itch.io, … LinkedIn or Threads", for help text. */
export const allowedList = () => {
  const names = ALLOWED.map((a) => a.name);
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
};

const HOSTS = {
  'x.com': 'x', 'twitter.com': 'x', 'github.com': 'github', 'youtube.com': 'youtube', 'bsky.app': 'bluesky', 'reddit.com': 'reddit',
  'twitch.tv': 'twitch', 'tiktok.com': 'tiktok', 'instagram.com': 'instagram', 'linkedin.com': 'linkedin', 'threads.net': 'threads', 'threads.com': 'threads',
};
// Paths on those sites that look like a username but are a feature page.
const RESERVED = {
  x: new Set(['i', 'home', 'intent', 'share', 'search', 'explore', 'settings', 'messages', 'notifications', 'hashtag', 'compose', 'login', 'signup', 'tos', 'privacy']),
  github: new Set(['orgs', 'settings', 'sponsors', 'marketplace', 'features', 'topics', 'collections', 'explore', 'login', 'about']),
  instagram: new Set(['p', 'reel', 'reels', 'explore', 'stories', 'accounts']),
  twitch: new Set(['directory', 'settings', 'search', 'downloads', 'login', 'signup', 'subscriptions', 'inventory', 'wallet', 'drops', 'turbo', 'jobs', 'prime']),
  itch: new Set(['www', 'static', 'img', 'api']),
};
const free = (kind, name) => !RESERVED[kind]?.has(name.toLowerCase());
const make = (kind, url, handle, label) => ({ kind, url, handle, label });

const ITCH_HOST = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.itch\.io$/;
const BSKY_HANDLE = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BSKY_DID = /^did:(?:plc:[a-z2-7]{24}|web:(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/;

/**
 * A profile page on one of the ALLOWED sites as { kind, url, handle, label }, normalised (https, lowercase host
 * without www. or m., no query, hash or trailing slash; twitter.com becomes x.com), or null for anything else: posts,
 * search or share links, other hosts.
 */
export function parseProfile(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw || raw.length > 300 || !/^https?:\/\//i.test(raw)) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname.replace(/\/+$/, '');
  const segs = path ? path.split('/').slice(1) : [];
  const [a = '', b = ''] = segs;
  const one = segs.length === 1;
  const two = segs.length === 2;

  const itch = ITCH_HOST.exec(host);
  if (itch) return segs.length === 0 && free('itch', itch[1]) ? make('itch', `https://${itch[1]}.itch.io`, itch[1], itch[1]) : null;

  switch (HOSTS[host.replace(/^(?:www|m)\./, '')]) {
    case 'x':
      return one && /^[A-Za-z0-9_]{1,15}$/.test(a) && free('x', a) ? make('x', `https://x.com/${a}`, a, `@${a}`) : null;
    case 'github':
      return one && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(a) && free('github', a) ? make('github', `https://github.com/${a}`, a, a) : null;
    case 'youtube': {
      if (one && /^@[A-Za-z0-9._-]{3,30}$/.test(a)) return make('youtube', `https://www.youtube.com/${a}`, a.slice(1), a);
      // A channel ID names no one: the page shows "YouTube channel".
      if (two && a === 'channel' && /^UC[A-Za-z0-9_-]{22}$/.test(b)) return make('youtube', `https://www.youtube.com/channel/${b}`, b, 'YouTube channel');
      return null;
    }
    case 'bluesky': {
      if (!two || a !== 'profile') return null;
      const h = b.toLowerCase();
      if (BSKY_HANDLE.test(h)) return make('bluesky', `https://bsky.app/profile/${h}`, h, h);
      return BSKY_DID.test(h) ? make('bluesky', `https://bsky.app/profile/${h}`, h, 'Bluesky profile') : null;
    }
    case 'reddit':
      return two && (a === 'user' || a === 'u') && /^[A-Za-z0-9_-]{3,20}$/.test(b) ? make('reddit', `https://reddit.com/user/${b}`, b, b) : null;
    case 'twitch':
      return one && /^[A-Za-z0-9_]{4,25}$/.test(a) && free('twitch', a) ? make('twitch', `https://twitch.tv/${a}`, a, a) : null;
    case 'tiktok':
      return one && /^@[A-Za-z0-9_.]{2,24}$/.test(a) ? make('tiktok', `https://tiktok.com/${a}`, a.slice(1), a) : null;
    case 'instagram':
      return one && /^[A-Za-z0-9_.]{1,30}$/.test(a) && free('instagram', a) ? make('instagram', `https://instagram.com/${a}`, a, `@${a}`) : null;
    case 'linkedin':
      return two && a === 'in' && /^[A-Za-z0-9-]{3,100}$/.test(b) ? make('linkedin', `https://linkedin.com/in/${b}`, b, b) : null;
    case 'threads':
      return one && /^@[A-Za-z0-9_.]{1,30}$/.test(a) ? make('threads', `https://threads.net/${a}`, a.slice(1), a) : null;
    default:
      return null;
  }
}
