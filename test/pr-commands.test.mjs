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
