#!/usr/bin/env node
// Turns a "Submit a game" issue (GitHub's rendered issue form) into a catalog entry with status: live (merging the PR is
// the approval). Its description stays empty until the review adds one, so the validate check
// fails until then: that is the intended gate. Everything in the issue is untrusted text: it is parsed as data,
// reduced to plain text, mapped onto taxonomy slugs, and never executed.
// Usage (CI): ISSUE_BODY=… ISSUE_NUMBER=… node scripts/issue-to-entry.mjs → prints JSON { slug, yaml, notes } or { error }.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { parseProfile, allowedList } from './profiles.mjs';

/** `### Label\n\nvalue` sections → { Label: value }. The first section with a label wins. */
export function parseIssue(body) {
  const out = {};
  const parts = String(body ?? '').replace(/\r\n?/g, '\n').split(/^### (.+)$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const label = parts[i].trim();
    if (label in out) continue;
    const value = parts[i + 1].trim();
    out[label] = value === '_No response_' ? '' : value;
  }
  return out;
}

const line = (s, max) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const block = (s, max) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const kebab = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
const norm = (u) => String(u ?? '').trim().toLowerCase().replace(/\/+$/, '');

/** https, a public host name (no IPs, ports, credentials, punycode or trailing dot), and not our own site. */
function safePlayUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    return null;
  }
  const h = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !h.includes('.') || h.endsWith('.')) return null;
  if (/^[\d.]+$/.test(h) || h.includes(':') || h.split('.').some((p) => p.startsWith('xn--'))) return null;
  if (h === 'gamesbyai.win' || h.endsWith('.gamesbyai.win')) return null;
  return u.href;
}

/** Taxonomy name → slug maps, the play URLs and slugs already in the catalog. */
export function loadContext(dir = '.') {
  const names = (kind) => new Map(parse(readFileSync(join(dir, 'taxonomies', `${kind}.yaml`), 'utf8')).terms.map((t) => [t.name.toLowerCase(), t.slug]));
  const gamesDir = join(dir, 'games');
  const games = existsSync(gamesDir) ? readdirSync(gamesDir).filter((f) => f.endsWith('.yaml')).map((f) => parse(readFileSync(join(gamesDir, f), 'utf8')) ?? {}) : [];
  return {
    names: { models: names('models'), tools: names('tools'), genres: names('genres'), engines: names('engines') },
    playUrls: new Set(games.map((g) => norm(g.play?.url))),
    slugs: new Set(games.map((g) => g.slug)),
  };
}

/** The creator page slug from a profile's username. A YouTube channel ID or a Bluesky DID names no one: no slug. */
const handleFrom = (p) => (!p || p.url.includes('/channel/') || p.handle.startsWith('did:') ? '' : kebab(p.handle.replace(/\.bsky\.social$/, '')));

/** The creator block: X and YouTube handles go in their own fields, any other profile in links. */
function creatorOf(f, creatorName, issue, notes) {
  const raw = line(f['Profile link (optional)'], 300);
  const profile = raw ? parseProfile(raw) : null;
  if (raw && !profile) notes.push(`The profile link was not a profile page on ${allowedList()}, so it was left out.`);
  // Issues filed before the profile link existed have "Creator handle (optional)" instead.
  const handle = handleFrom(profile) || kebab(line(f['Creator handle (optional)'], 40)) || kebab(creatorName) || `creator-${issue}`;
  const creator = { name: creatorName, handle };
  if (profile?.kind === 'x') creator.x = profile.handle;
  else if (profile?.kind === 'youtube' && profile.label.startsWith('@')) creator.youtube = profile.label;
  else if (profile) creator.links = [profile.url];
  return creator;
}

const PLAYERS = { 'single player': 'single', 'local multiplayer': 'local', 'online multiplayer': 'online' };
const SHARE = { 'all of it': 'all', 'most of it': 'most', 'some of it': 'some' };

export function toEntry(f, { names, playUrls, slugs, today, issue }) {
  const notes = [];
  const playUrl = safePlayUrl(f['Play URL']);
  if (!playUrl) return { error: 'The Play URL must be a public https link to where the game runs (not gamesbyai.win).' };
  if (playUrls.has(norm(playUrl))) return { error: 'This game is already in the catalog or waiting for review.' };
  if (!/^- \[x\]/im.test(f.Permission ?? '')) return { error: 'The permission box must be ticked.' };
  const title = line(f['Game title'], 80);
  if (title.length < 2) return { error: 'The game needs a title.' };
  const creatorName = line(f['Creator name'], 80);
  if (!creatorName) return { error: 'The creator needs a name.' };
  const repoRaw = line(f['Repository (optional)'], 200);
  const repo = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/?$/.test(repoRaw) ? repoRaw : undefined;
  if (repoRaw && !repo) notes.push('The repository link was not a GitHub repository URL, so it was left out.');
  const pick = (kind, raw) => {
    const out = [];
    for (const name of String(raw ?? '').split(',').map((s) => line(s, 80)).filter((s) => s && s.toLowerCase() !== 'not sure')) {
      const slug = names[kind].get(name.toLowerCase());
      if (slug) out.push(slug);
      else notes.push(`Unknown ${kind.slice(0, -1)} "${name}" was left out.`);
    }
    return [...new Set(out)];
  };
  // One engine at most; issues filed before the field existed simply have none.
  const engine = pick('engines', f['Engine or framework'])[0];
  const genres = pick('genres', f.Genres).slice(0, 3);
  if (!genres.length) return { error: 'Pick at least one genre.' };
  let slug = kebab(title) || `game-${issue}`;
  if (!/[a-z]/.test(slug)) slug = `game-${slug}`;
  const base = slug;
  for (let i = 2; slugs.has(slug); i++) slug = `${base}-${i}`;

  const entry = {
    slug,
    title,
    tagline: 'Submitted by its creator; the description is added during review.',
    description: '',
    // The consent box (since 2026-09-30) also allows our player; older issues give no such permission.
    play: { url: playUrl, platforms: ['browser'], ...(/may show it in its player/i.test(f.Permission ?? '') ? { embedPermission: { by: 'submission', date: today } } : {}) },
    ...(repo ? { repo } : {}),
    creator: creatorOf(f, creatorName, issue, notes),
    made: {
      models: pick('models', f['AI models used']),
      tools: pick('tools', f['AI tools used']),
      aiShare: SHARE[line(f['How much of the code did AI write?'], 40).toLowerCase()] ?? 'unknown',
      source: `Creator's submission (issue #${issue})`,
      evidence: 'creator',
      notes: block(f['How you made it (600 characters max)'], 600) || undefined,
    },
    tech: { ...(engine ? { engine } : {}), multiplayer: PLAYERS[line(f.Players, 40).toLowerCase()] ?? 'single' },
    genres,
    media: { cover: `games/${slug}/cover`, screenshots: [`games/${slug}/shot-1`, `games/${slug}/shot-2`] },
    dates: { added: today, updated: today },
    status: 'live',
    provenance: { foundVia: 'form', submittedBy: `#${issue}` },
  };
  if (!entry.made.notes) delete entry.made.notes;
  // Models, tools or an engine the form doesn't list: a note for the reviewer (Recipe G), never a term in the entry.
  // Issues filed before the field existed simply have none.
  const otherTerms = line(f['Other AI models, tools or engine (optional)'], 120);
  if (otherTerms) notes.push(`New term requested: ${otherTerms}`);
  return { slug, entry, notes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const issue = Number(process.env.ISSUE_NUMBER);
  const r = toEntry(parseIssue(process.env.ISSUE_BODY), { ...loadContext('.'), today: new Date().toISOString().slice(0, 10), issue });
  console.log(JSON.stringify(r.error ? { error: r.error } : { slug: r.slug, yaml: stringify(r.entry), notes: r.notes }));
}
