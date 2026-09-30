#!/usr/bin/env node
// Lists modified entries whose play URL changed, reading the old YAML from git as data.
// Usage: node scripts/changed-play-urls.mjs <base-ref>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export function playUrlChanged(before, after) {
  return parse(before)?.play?.url !== parse(after)?.play?.url;
}

export function changedPlayUrls(baseRef, { repoDir = '.', execFile = execFileSync } = {}) {
  const git = (...args) => execFile('git', ['-C', repoDir, ...args], { encoding: 'utf8' });
  const files = git('diff', '--name-only', '--diff-filter=M', '-z', baseRef, 'HEAD', '--', 'games/*.yaml').split('\0');
  return files.filter((file) => /^games\/[a-z0-9]+(?:-[a-z0-9]+)*\.yaml$/.test(file))
    .filter((file) => playUrlChanged(git('show', `${baseRef}:${file}`), readFileSync(join(repoDir, file), 'utf8')));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('usage: node scripts/changed-play-urls.mjs <base-ref>');
  for (const file of changedPlayUrls(process.argv[2])) console.log(file);
}
