#!/usr/bin/env node
// Review commands on seed and submission PRs. Only the catalog owner's comments count, and only slugs that exist in
// the PR can be removed. Usage (in CI): COMMENT_BODY=… COMMENT_AUTHOR=… OWNERS=a,b node scripts/pr-commands.mjs <pr-dir>
// Prints the files to remove, one per line; prints nothing when there is no valid command.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `/drop a b` from an owner → { drop: ['a', 'b'] }; anything else → null. Logins compare exactly. */
export function parseCommand(body, { author, owners }) {
  if (!owners.includes(author)) return null;
  const m = /^\/drop\s+([\s\S]+)$/.exec(body.trim());
  if (!m) return null;
  const drop = [...new Set(m[1].split(/[\s,]+/).filter((s) => SLUG.test(s)))];
  return drop.length ? { drop } : null;
}

export function dropTargets(slugs, existing) {
  const have = new Set(existing);
  return { remove: slugs.filter((s) => have.has(s)), unknown: slugs.filter((s) => !have.has(s)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  const cmd = parseCommand(process.env.COMMENT_BODY ?? '', { author: process.env.COMMENT_AUTHOR ?? '', owners: (process.env.OWNERS ?? '').split(',').filter(Boolean) });
  if (cmd) {
    const existing = readdirSync(join(dir, 'games')).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5));
    for (const s of dropTargets(cmd.drop, existing).remove) console.log(`games/${s}.yaml`);
  }
}
