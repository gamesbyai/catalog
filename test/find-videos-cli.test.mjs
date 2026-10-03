// The CLI must finish when run() loads videos-post.mjs, which imports find-videos.mjs back (2026-10-03: a top-level
// await in the CLI made that import wait forever and the job stopped with exit code 13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('find-videos.mjs has no top-level await, so videos-post.mjs can import it during a run', () => {
  const src = readFileSync(fileURLToPath(new URL('../scripts/find-videos.mjs', import.meta.url)), 'utf8');
  const topLevel = src.split('\n').filter((line) => /^\S/.test(line) && /\bawait\b/.test(line) && !/^\s*\/\//.test(line));
  assert.deepEqual(topLevel, []);
});

test('importing videos-post.mjs from inside find-videos.mjs settles', async () => {
  const mod = await import('../scripts/find-videos.mjs');
  const post = await Promise.race([import('../scripts/videos-post.mjs'), new Promise((_, reject) => setTimeout(() => reject(new Error('import did not settle')), 5000))]);
  assert.equal(typeof post.reserveRunQuota, 'function');
  assert.equal(typeof mod.run, 'function');
});
