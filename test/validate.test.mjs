import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate } from '../scripts/validate.mjs';

function repo(games) {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-'));
  cpSync('schema', join(dir, 'schema'), { recursive: true });
  cpSync('taxonomies', join(dir, 'taxonomies'), { recursive: true });
  mkdirSync(join(dir, 'games'));
  for (const [name, body] of Object.entries(games)) writeFileSync(join(dir, 'games', name), body);
  return dir;
}

const draft = `slug: sky-hop
title: Sky Hop
tagline: Hop between floating islands before they sink
description: ""
play: { url: "https://example.com/sky-hop/", platforms: [browser] }
creator: { name: Ada, handle: ada }
made: { models: [claude-sonnet-5-5], tools: [claude-code], aiShare: most, source: "Creator's README" }
tech: { engine: threejs, multiplayer: single }
genres: [platformer]
media: { cover: games/sky-hop/cover }
dates: { added: 2026-09-29, updated: 2026-09-29 }
status: draft
provenance: { foundVia: form }
`;

test('accepts a valid draft', () => {
  assert.deepEqual(validate(repo({ 'sky-hop.yaml': draft })).problems, []);
});

test('rejects unknown taxonomy slugs and a file name that differs from the slug', () => {
  const { problems } = validate(repo({ 'sky.yaml': draft.replace('[claude-sonnet-5-5]', '[claudio]') }));
  assert.ok(problems.some((p) => p.includes('unknown model "claudio"')));
  assert.ok(problems.some((p) => p.includes('must match the file name')));
});

test('a live entry needs a 600-character description, and no editor score or jam rank (rankings come from player votes)', () => {
  const { problems } = validate(repo({ 'sky-hop.yaml': draft.replace('status: draft', 'status: live') }));
  assert.ok(problems.some((p) => p.includes('description')));
  assert.ok(!problems.some((p) => /editor|jam/.test(p)), problems.join('\n'));
  const live = draft.replace('status: draft', 'status: live').replace('description: ""', `description: "${'x'.repeat(620)}"`);
  assert.deepEqual(validate(repo({ 'sky-hop.yaml': live })).problems, []);
});

test('a draft may name only a provider or a tool; with none it needs a jam', () => {
  const providerOnly = draft.replace('models: [claude-sonnet-5-5]', 'models: [], providers: [openai]');
  assert.deepEqual(validate(repo({ 'sky-hop.yaml': providerOnly })).problems, []);
  const toolOnly = draft.replace('models: [claude-sonnet-5-5]', 'models: []');
  assert.deepEqual(validate(repo({ 'sky-hop.yaml': toolOnly })).problems, []);
  const none = toolOnly.replace('tools: [claude-code]', 'tools: []');
  assert.ok(validate(repo({ 'sky-hop.yaml': none })).problems.some((p) => p.includes('model, provider or tool')));
  const jamOnly = none + 'jam: { event: vibe-jam-2026, rank: 3, entries: 945 }\n';
  assert.deepEqual(validate(repo({ 'sky-hop.yaml': jamOnly })).problems, []);
});

test('a live jam entry may leave out the engine', () => {
  const long = 'x'.repeat(620);
  const live = draft.replace('status: draft', 'status: live').replace('description: ""', `description: "${long}"`)
    .replace('tech: { engine: threejs, multiplayer: single }', 'tech: { multiplayer: single }') + 'jam: { event: vibe-jam-2026, rank: 3, entries: 945 }\n';
  assert.deepEqual(validate(repo({ 'sky-hop.yaml': live })).problems, []);
});

test('a jam rank above the number of entries is rejected', () => {
  const bad = draft + 'jam: { event: vibe-jam-2026, rank: 30, entries: 10 }\n';
  assert.ok(validate(repo({ 'sky-hop.yaml': bad })).problems.some((p) => p.includes('jam.rank')));
});

test('one creator gets one page: the same name under two handles is rejected, placeholder names are not', () => {
  const second = (name, handle) => draft.replaceAll('sky-hop', 'sea-hop').replace('creator: { name: Ada, handle: ada }', `creator: { name: ${name}, handle: ${handle} }`);
  const split = validate(repo({ 'sky-hop.yaml': draft, 'sea-hop.yaml': second('ada', 'ada-dev') })).problems;
  assert.ok(split.some((p) => /has two pages, .*\/creators\/ada\//.test(p) && p.includes('/creators/ada-dev/')), split.join('\n'));
  const nameless = (h) => draft.replaceAll('sky-hop', h).replace('creator: { name: Ada, handle: ada }', `creator: { name: Unknown creator, handle: ${h} }`);
  assert.deepEqual(validate(repo({ 'sky-hop.yaml': nameless('sky-hop'), 'sea-hop.yaml': nameless('sea-hop') })).problems, []);
});
