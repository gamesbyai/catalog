#!/usr/bin/env node
// Review commands on seed and submission PRs. Only the catalog owner's comments count, and they only touch games the
// PR itself adds (never a game already live on main).
//   /drop <slug> [<slug> …]           remove games from the PR
//   /score [<slug>] <fun> <polish> <originality> <aiCraft>   each 1–5; sets the editor score and status: live
//   /reject <reason>                  close the PR and tell the creator
//   /changes <note>                   ask the creator for changes
// Usage (in CI): COMMENT_BODY=… COMMENT_AUTHOR=… OWNERS=a,b PR_SLUGS="a b" node scripts/pr-commands.mjs <pr-dir>
// Prints one JSON action for the workflow, or nothing when there is no valid command.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const text = (s, max) => String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

/** A command from an owner, or null. Logins compare exactly. */
export function parseCommand(body, { author, owners }) {
  if (!owners.includes(author)) return null;
  const m = /^\/(drop|score|reject|changes)(?:\s+([\s\S]*))?$/.exec(String(body).trim());
  if (!m) return null;
  const [, cmd, rest = ''] = m;
  if (cmd === 'drop') {
    const drop = [...new Set(rest.split(/[\s,]+/).filter((s) => SLUG.test(s)))];
    return drop.length ? { drop } : null;
  }
  if (cmd === 'score') {
    const parts = rest.trim().split(/\s+/);
    const slug = parts.length === 5 && SLUG.test(parts[0]) ? parts.shift() : undefined;
    if (parts.length !== 4 || !parts.every((p) => /^[1-5]$/.test(p))) return null;
    const [fun, polish, originality, aiCraft] = parts.map(Number);
    return { score: { ...(slug ? { slug } : {}), fun, polish, originality, aiCraft } };
  }
  const note = text(rest, 500);
  return note ? { [cmd]: note } : null;
}

export function dropTargets(slugs, existing) {
  const have = new Set(existing);
  return { remove: slugs.filter((s) => have.has(s)), unknown: slugs.filter((s) => !have.has(s)) };
}

/** Sets the editor score, the review date and status: live, keeping comments and everything else. */
export function applyScore(yamlText, s, today) {
  const doc = parseDocument(yamlText);
  doc.setIn(['editor', 'score'], doc.createNode({ fun: s.fun, polish: s.polish, originality: s.originality, aiCraft: s.aiCraft }));
  doc.setIn(['editor', 'reviewedAt'], today);
  doc.set('status', 'live');
  return doc.toString();
}

/** The workflow's next step for a command, given the slugs this PR adds. */
export function plan(cmd, prSlugs, readGame, today) {
  if (cmd.drop) return { action: 'drop', files: dropTargets(cmd.drop, prSlugs).remove.map((s) => `games/${s}.yaml`) };
  if (cmd.score) {
    const slug = cmd.score.slug ?? (prSlugs.length === 1 ? prSlugs[0] : null);
    if (!slug) return { action: 'error', message: 'This PR has several games: use /score <slug> <fun> <polish> <originality> <aiCraft>.' };
    if (!prSlugs.includes(slug)) return { action: 'error', message: `${slug} is not a game this PR adds.` };
    return { action: 'score', slug, file: `games/${slug}.yaml`, content: applyScore(readGame(slug), cmd.score, today) };
  }
  if (cmd.reject) return { action: 'reject', text: cmd.reject };
  if (cmd.changes) return { action: 'changes', text: cmd.changes };
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  const cmd = parseCommand(process.env.COMMENT_BODY ?? '', { author: process.env.COMMENT_AUTHOR ?? '', owners: (process.env.OWNERS ?? '').split(',').filter(Boolean) });
  if (cmd) {
    const prSlugs = (process.env.PR_SLUGS ?? '').split(/\s+/).filter((s) => SLUG.test(s));
    const out = plan(cmd, prSlugs, (s) => readFileSync(join(dir, 'games', `${s}.yaml`), 'utf8'), new Date().toISOString().slice(0, 10));
    if (out) console.log(JSON.stringify(out));
  }
}
