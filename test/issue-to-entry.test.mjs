import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { parseIssue, toEntry, loadContext } from '../scripts/issue-to-entry.mjs';
import { validate } from '../scripts/validate.mjs';

const body = (over = {}) => {
  const f = {
    'Play URL': 'https://sky-hop.example.com/',
    'Repository (optional)': '_No response_',
    'Game title': 'Sky Hop',
    'Creator name': 'Ada',
    'Profile link (optional)': 'https://twitter.com/ada_makes/',
    Genres: 'Platformer, Puzzle',
    Players: 'Single player',
    'How much of the code did AI write?': 'Most of it',
    'AI models used': 'Claude Opus 5.5',
    'AI tools used': 'Claude Code, Cursor',
    'Engine or framework': 'Three.js',
    'How you made it (600 characters max)': 'I described the idea to Claude Code and tuned the jumps by hand.',
    Permission: "- [X] I made this game or have the creator's permission, and I agree to the editorial policy.",
    ...over,
  };
  return Object.entries(f).map(([h, v]) => `### ${h}\n\n${v}`).join('\n\n');
};

function repo(games = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-'));
  cpSync('schema', join(dir, 'schema'), { recursive: true });
  cpSync('taxonomies', join(dir, 'taxonomies'), { recursive: true });
  mkdirSync(join(dir, 'games'));
  for (const [slug, g] of Object.entries(games)) writeFileSync(join(dir, 'games', `${slug}.yaml`), stringify(g));
  return dir;
}

test('a rendered issue form parses into fields; "_No response_" is empty', () => {
  const f = parseIssue(body());
  assert.equal(f['Play URL'], 'https://sky-hop.example.com/');
  assert.equal(f['Repository (optional)'], '');
  assert.equal(f['AI tools used'], 'Claude Code, Cursor');
});

test('a valid submission becomes a live entry (the merge is the approval) that fails validation only on its empty description', () => {
  const dir = repo();
  const r = toEntry(parseIssue(body()), { ...loadContext(dir), today: '2026-09-29', issue: 12 });
  assert.equal(r.slug, 'sky-hop');
  assert.equal(r.entry.status, 'live');
  assert.equal(r.entry.description, '');
  assert.doesNotMatch(r.entry.tagline, /editor/i);
  assert.deepEqual(r.entry.made.models, ['claude-opus-5-5']);
  assert.deepEqual(r.entry.made.tools, ['claude-code', 'cursor']);
  assert.equal(r.entry.tech.engine, 'threejs');
  assert.deepEqual(r.entry.genres, ['platformer', 'puzzle']);
  assert.equal(r.entry.made.aiShare, 'most');
  assert.equal(r.entry.made.evidence, 'creator');
  assert.deepEqual(r.entry.provenance, { foundVia: 'form', submittedBy: '#12' });
  assert.deepEqual(r.entry.creator, { name: 'Ada', handle: 'ada-makes', x: 'ada_makes' });
  writeFileSync(join(dir, 'games', 'sky-hop.yaml'), stringify(r.entry));
  // The intended gate: the review card commits the drafted description; until then validate fails on it alone.
  const problems = validate(dir).problems;
  assert.ok(problems.length > 0);
  assert.ok(problems.every((p) => /description|"then"/.test(p)), problems.join('\n'));
  writeFileSync(join(dir, 'games', 'sky-hop.yaml'), stringify({ ...r.entry, tagline: 'Hop between floating islands before they sink', description: `${'Sky Hop is a platformer. '.repeat(20)}\n\n${'Each island sinks. '.repeat(10)}` }));
  assert.deepEqual(validate(dir).problems, []);
});

test('a game that is already in the catalog is refused, and slugs never collide', () => {
  const dir = repo({ 'sky-hop': { slug: 'sky-hop', play: { url: 'https://other.example.com/' } } });
  const ctx = { ...loadContext(dir), today: '2026-09-29', issue: 13 };
  assert.equal(toEntry(parseIssue(body()), ctx).slug, 'sky-hop-2');
  const dup = repo({ x: { slug: 'x', play: { url: 'https://SKY-HOP.example.com' } } });
  assert.match(toEntry(parseIssue(body()), { ...loadContext(dup), today: '2026-09-29', issue: 14 }).error, /already/);
});

test('unknown models or tools are dropped and noted; missing permission or a bad URL is an error', () => {
  const ctx = { ...loadContext(repo()), today: '2026-09-29', issue: 15 };
  const r = toEntry(parseIssue(body({ 'AI models used': 'Claude Opus 5.5, Mystery Model 9' })), ctx);
  assert.deepEqual(r.entry.made.models, ['claude-opus-5-5']);
  assert.match(r.notes.join(' '), /Mystery Model 9/);
  assert.match(toEntry(parseIssue(body({ Permission: '- [ ] I made this game' })), ctx).error, /permission/);
  assert.match(toEntry(parseIssue(body({ 'Play URL': 'javascript:alert(1)' })), ctx).error, /Play URL/);
  assert.match(toEntry(parseIssue(body({ 'Play URL': 'https://gamesbyai.win/x' })), ctx).error, /Play URL/);
});

test('text fields become plain text and can not smuggle extra form sections', () => {
  const ctx = { ...loadContext(repo()), today: '2026-09-29', issue: 16 };
  const r = toEntry(parseIssue(body({ 'Game title': 'Sky <img src=x onerror=alert(1)> Hop' })), ctx);
  assert.equal(r.entry.title, 'Sky Hop');
  const smuggled = parseIssue(body({ 'Creator name': 'Ada\n\n### Play URL\n\nhttps://evil.example' }));
  assert.equal(smuggled['Play URL'], 'https://sky-hop.example.com/', 'the first section wins');
});

test('the issue form on disk matches the taxonomies (run node scripts/issue-form.mjs after a taxonomy change)', async () => {
  const { renderForm, FORM_PATH } = await import('../scripts/issue-form.mjs');
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(FORM_PATH, 'utf8'), renderForm('.'));
});

test('the issue form makes no editor claims and never says how games are checked', async () => {
  const { issueForm } = await import('../scripts/issue-form.mjs');
  const f = issueForm('.');
  assert.doesNotMatch(f.description, /editor/i);
  assert.doesNotMatch(JSON.stringify(f), /automated|scan|malware/i);
  assert.match(f.description, /reviewed before it goes live/);
});

test('the engine is optional: "Not sure" or an unknown name leaves it out (noted), a known one becomes tech.engine', () => {
  const ctx = { ...loadContext(repo()), today: '2026-09-30', issue: 13 };
  assert.equal(toEntry(parseIssue(body({ 'Engine or framework': 'Not sure' })), ctx).entry.tech.engine, undefined);
  const odd = toEntry(parseIssue(body({ 'Engine or framework': 'MyEngine 9000' })), ctx);
  assert.equal(odd.entry.tech.engine, undefined);
  assert.ok(odd.notes.some((n) => /engine/i.test(n)));
  assert.equal(toEntry(parseIssue(body({ 'Engine or framework': 'Godot' })), ctx).entry.tech.engine, 'godot');
  const { 'Engine or framework': _, ...older } = parseIssue(body());
  assert.equal(toEntry(older, ctx).entry.tech.engine, undefined, 'issues filed before the field existed still convert');
});

test('models, tools or an engine we do not list become a note for the reviewer, never a term in the entry', () => {
  const ctx = { ...loadContext(repo()), today: '2026-09-30', issue: 40 };
  const plain = toEntry(parseIssue(body()), ctx);
  const r = toEntry(parseIssue(body({ 'Other AI models, tools or engine (optional)': 'Nova Coder 2 <b>(https://nova.example/)</b>' })), ctx);
  assert.equal(r.error, undefined);
  assert.ok(r.notes.includes('New term requested: Nova Coder 2 (https://nova.example/)'), r.notes.join('\n'));
  assert.deepEqual(r.entry, plain.entry, 'the entry is the same as without the field');
  assert.doesNotMatch(JSON.stringify(r.entry), /Nova/);
  const long = toEntry(parseIssue(body({ 'Other AI models, tools or engine (optional)': 'n'.repeat(500) })), ctx);
  assert.ok(long.notes.includes(`New term requested: ${'n'.repeat(120)}`), 'cut to 120 characters');
});

test('an empty "Other AI models, tools or engine" adds no note, and issues filed before the field still convert', () => {
  const ctx = { ...loadContext(repo()), today: '2026-09-30', issue: 41 };
  for (const v of ['_No response_', '   ']) {
    const r = toEntry(parseIssue(body({ 'Other AI models, tools or engine (optional)': v })), ctx);
    assert.equal(r.error, undefined, v);
    assert.ok(!r.notes.some((n) => /New term/.test(n)), v);
  }
  const older = parseIssue(body());
  assert.ok(!('Other AI models, tools or engine (optional)' in older), 'the old body has no such heading');
  const r = toEntry(older, ctx);
  assert.equal(r.error, undefined);
  assert.equal(r.slug, 'sky-hop');
  assert.deepEqual(r.notes, []);
});

test('the issue form asks for other models, tools or an engine in one optional field, right after the engine', async () => {
  const { issueForm } = await import('../scripts/issue-form.mjs');
  const items = issueForm('.').body;
  const i = items.findIndex((b) => b.attributes?.label === 'Other AI models, tools or engine (optional)');
  assert.equal(items[i].type, 'input');
  assert.equal(items[i].validations.required, false);
  assert.equal(items[i - 1].attributes.label, 'Engine or framework');
  assert.match(items[i].attributes.description, /missing above, with a link to the maker's page/);
});

test('every label the converter reads exists in the issue form', async () => {
  const { issueForm } = await import('../scripts/issue-form.mjs');
  const labels = issueForm('.').body.filter((b) => b.attributes?.label).map((b) => b.attributes.label);
  // "Creator handle (optional)" is still read, for issues filed before the profile link replaced it.
  for (const l of ['Play URL', 'Repository (optional)', 'Game title', 'Creator name', 'Profile link (optional)', 'Genres', 'Players', 'How much of the code did AI write?', 'AI models used', 'AI tools used', 'Engine or framework', 'Other AI models, tools or engine (optional)', 'How you made it (600 characters max)', 'Permission']) assert.ok(labels.includes(l), l);
  assert.ok(!labels.includes('Creator handle (optional)'));
});

test('the issue form asks for one optional profile link and names every accepted site', async () => {
  const { issueForm } = await import('../scripts/issue-form.mjs');
  const field = issueForm('.').body.find((b) => b.attributes?.label === 'Profile link (optional)');
  assert.equal(field.type, 'input');
  assert.equal(field.validations.required, false);
  assert.match(field.attributes.description, /X, GitHub, itch\.io, YouTube, Bluesky, Reddit, Twitch, TikTok, Instagram, LinkedIn or Threads/);
});

test('the profile link: X and YouTube handles get their own fields, other profiles go in links, and the handle names the creator page', () => {
  const ctx = { ...loadContext(repo()), today: '2026-09-30', issue: 20 };
  const creator = (link) => toEntry(parseIssue(body({ 'Profile link (optional)': link })), ctx).entry.creator;
  assert.deepEqual(creator('https://www.youtube.com/@Ada.Makes'), { name: 'Ada', handle: 'ada-makes', youtube: '@Ada.Makes' });
  assert.deepEqual(creator('https://github.com/ada-makes/'), { name: 'Ada', handle: 'ada-makes', links: ['https://github.com/ada-makes'] });
  assert.deepEqual(creator('https://ada-games.itch.io'), { name: 'Ada', handle: 'ada-games', links: ['https://ada-games.itch.io'] });
  assert.deepEqual(creator('https://bsky.app/profile/ada.bsky.social'), { name: 'Ada', handle: 'ada', links: ['https://bsky.app/profile/ada.bsky.social'] });
  assert.deepEqual(creator('https://www.reddit.com/u/Ada_Makes'), { name: 'Ada', handle: 'ada-makes', links: ['https://reddit.com/user/Ada_Makes'] });
  // A channel ID names no one: the creator page takes the creator's name.
  assert.deepEqual(creator('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv'), { name: 'Ada', handle: 'ada', links: ['https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv'] });
  assert.deepEqual(creator('_No response_'), { name: 'Ada', handle: 'ada' });
});

test('a profile link that is not a profile page on an allowed site is left out with a note, never a failure', () => {
  const ctx = { ...loadContext(repo()), today: '2026-09-30', issue: 21 };
  for (const link of ['https://x.com/ada_makes/status/123', 'https://evil.example.com/ada', 'https://x.com.evil.test/ada', 'javascript:alert(1)', 'ada_makes']) {
    const r = toEntry(parseIssue(body({ 'Profile link (optional)': link })), ctx);
    assert.equal(r.error, undefined, link);
    assert.deepEqual(r.entry.creator, { name: 'Ada', handle: 'ada' }, link);
    assert.ok(r.notes.some((n) => /profile link/.test(n)), link);
  }
});

test('issues filed before the profile link still convert their "Creator handle (optional)"', () => {
  const ctx = { ...loadContext(repo()), today: '2026-09-30', issue: 22 };
  const { 'Profile link (optional)': _, ...older } = parseIssue(body());
  assert.deepEqual(toEntry({ ...older, 'Creator handle (optional)': 'Ada Games' }, ctx).entry.creator, { name: 'Ada', handle: 'ada-games' });
  assert.deepEqual(toEntry(older, ctx).entry.creator, { name: 'Ada', handle: 'ada' });
});

test('an entry with a profile link passes validation once its description is written', () => {
  const dir = repo();
  for (const [i, link] of ['https://x.com/ada_makes', 'https://www.youtube.com/@ada.makes', 'https://ada-games.itch.io'].entries()) {
    const r = toEntry(parseIssue(body({ 'Profile link (optional)': link, 'Play URL': `https://sky-hop-${i}.example.com/` })), { ...loadContext(dir), today: '2026-09-30', issue: 30 + i });
    writeFileSync(join(dir, 'games', `${r.slug}.yaml`), stringify({ ...r.entry, tagline: 'Hop between floating islands before they sink', description: `${'Sky Hop is a platformer. '.repeat(20)}\n\n${'Each island sinks. '.repeat(10)}` }));
  }
  assert.deepEqual(validate(dir).problems, []);
});
