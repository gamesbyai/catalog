import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as commands from '../scripts/pr-commands.mjs';
import { parseCommand, dropTargets, plan } from '../scripts/pr-commands.mjs';

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

test('there is no /score: rankings come from player votes and the merge is the approval', () => {
  assert.equal(parseCommand('/score 4 4 3 5', owner), null);
  assert.equal(parseCommand('/score neon-drift 4 4 4 4', owner), null);
  assert.equal('applyScore' in commands, false);
});

test('/reject and /changes carry a short plain reason', () => {
  assert.deepEqual(parseCommand('/reject Not a game, just a landing page', owner), { reject: 'Not a game, just a landing page' });
  assert.deepEqual(parseCommand('/changes Please add the play link\nthanks', owner), { changes: 'Please add the play link thanks' });
  assert.equal(parseCommand('/reject', owner), null);
  assert.equal(parseCommand('/reject <b>x</b>', owner).reject, 'x');
});

test('commands only touch games the PR adds, never a live game on main', () => {
  assert.deepEqual(plan({ drop: ['a', 'live-game'] }, ['a', 'b']), { action: 'drop', files: ['games/a.yaml'] });
  assert.deepEqual(plan({ reject: 'Not a game' }, ['a']), { action: 'reject', text: 'Not a game' });
  assert.deepEqual(plan({ changes: 'Add the play link' }, ['a']), { action: 'changes', text: 'Add the play link' });
  assert.equal(plan({ score: { fun: 3, polish: 3, originality: 3, aiCraft: 3 } }, ['a']), null);
});
