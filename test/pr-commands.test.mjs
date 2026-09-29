import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, dropTargets } from '../scripts/pr-commands.mjs';

const owner = { author: 'MansGullberg', owners: ['MansGullberg'] };

test('/drop lists slugs from the owner', () => {
  assert.deepEqual(parseCommand('/drop neon-drift tiny-skies', owner), { drop: ['neon-drift', 'tiny-skies'] });
  assert.deepEqual(parseCommand('/drop  neon-drift,\ntiny-skies ', owner), { drop: ['neon-drift', 'tiny-skies'] });
});

test('comments from anyone else are ignored', () => {
  assert.equal(parseCommand('/drop neon-drift', { author: 'someone', owners: ['MansGullberg'] }), null);
  assert.equal(parseCommand('/drop neon-drift', { author: 'mansgullberg', owners: ['MansGullberg'] }), null);
});

test('other comments and malformed slugs are ignored', () => {
  assert.equal(parseCommand('looks good', owner), null);
  assert.equal(parseCommand('please /drop neon-drift', owner), null);
  assert.deepEqual(parseCommand('/drop ../../etc/passwd neon-drift Games', owner), { drop: ['neon-drift'] });
  assert.equal(parseCommand('/drop', owner), null);
});

test('only slugs that exist in the PR are dropped', () => {
  assert.deepEqual(dropTargets(['neon-drift', 'nope'], ['neon-drift', 'tiny-skies']), { remove: ['neon-drift'], unknown: ['nope'] });
});

test('/score with four 1–5 numbers, optionally for one slug in a batch', () => {
  assert.deepEqual(parseCommand('/score 4 4 3 5', owner), { score: { fun: 4, polish: 4, originality: 3, aiCraft: 5 } });
  assert.deepEqual(parseCommand('/score neon-drift 4 4 4 4', owner), { score: { slug: 'neon-drift', fun: 4, polish: 4, originality: 4, aiCraft: 4 } });
  assert.equal(parseCommand('/score 6 1 1 1', owner), null);
  assert.equal(parseCommand('/score 4 4 4', owner), null);
  assert.equal(parseCommand('/score 4 4 4 4', { author: 'someone', owners: ['MansGullberg'] }), null);
});

test('/reject and /changes carry a short plain reason', () => {
  assert.deepEqual(parseCommand('/reject Not a game, just a landing page', owner), { reject: 'Not a game, just a landing page' });
  assert.deepEqual(parseCommand('/changes Please add the play link\nthanks', owner), { changes: 'Please add the play link thanks' });
  assert.equal(parseCommand('/reject', owner), null);
  assert.equal(parseCommand('/reject <b>x</b>', owner).reject, 'x');
});

test('applyScore publishes the entry: score, review date and status live, keeping everything else', async () => {
  const { applyScore } = await import('../scripts/pr-commands.mjs');
  const before = '# keep me\nslug: sky-hop\ntitle: Sky Hop\nstatus: draft\nmade:\n  aiShare: most\n';
  const after = applyScore(before, { fun: 4, polish: 3, originality: 5, aiCraft: 4 }, '2026-09-30');
  assert.match(after, /# keep me/);
  assert.match(after, /status: live/);
  assert.match(after, /editor:\n  score:\n    fun: 4\n    polish: 3\n    originality: 5\n    aiCraft: 4\n  reviewedAt: 2026-09-30/);
  assert.match(after, /aiShare: most/);
});

test('commands only touch games the PR adds, never a live game on main', async () => {
  const { plan } = await import('../scripts/pr-commands.mjs');
  const read = () => 'slug: a\nstatus: draft\n';
  assert.deepEqual(plan({ drop: ['a', 'live-game'] }, ['a', 'b'], read, '2026-09-30'), { action: 'drop', files: ['games/a.yaml'] });
  assert.equal(plan({ score: { slug: 'live-game', fun: 3, polish: 3, originality: 3, aiCraft: 3 } }, ['a', 'b'], read, '2026-09-30').action, 'error');
  assert.equal(plan({ score: { fun: 3, polish: 3, originality: 3, aiCraft: 3 } }, ['a', 'b'], read, '2026-09-30').action, 'error');
  const one = plan({ score: { fun: 3, polish: 3, originality: 3, aiCraft: 3 } }, ['a'], read, '2026-09-30');
  assert.equal(one.file, 'games/a.yaml');
  assert.match(one.content, /status: live/);
});
