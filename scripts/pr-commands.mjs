#!/usr/bin/env node
// Review commands on seed and submission PRs. Only comments from the organization's members count, and they only touch games the
// PR itself adds (never a game already live on main). There is no scoring: rankings come from player votes, and
// merging the PR is the approval.
//   /drop <slug> [<slug> …]           remove games from the PR
//   /reject <reason>                  close the PR and tell the creator
//   /changes <note>                   ask the creator for changes
// Usage (in CI): COMMENT_BODY=… COMMENT_ASSOCIATION=… PR_SLUGS="a b" node scripts/pr-commands.mjs
// Prints one JSON action for the workflow, or nothing when there is no valid command.
import { fileURLToPath } from 'node:url';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const text = (s, max) => String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

// GitHub's author_association: people an admin added (org owners, members, collaborators), never outside contributors.
const MAINTAINERS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

/** A command from a maintainer, or null. */
export function parseCommand(body, { association }) {
  if (!MAINTAINERS.includes(association)) return null;
  const m = /^\/(drop|reject|changes)(?:\s+([\s\S]*))?$/.exec(String(body).trim());
  if (!m) return null;
  const [, cmd, rest = ''] = m;
  if (cmd === 'drop') {
    const drop = [...new Set(rest.split(/[\s,]+/).filter((s) => SLUG.test(s)))];
    return drop.length ? { drop } : null;
  }
  const note = text(rest, 500);
  return note ? { [cmd]: note } : null;
}

export function dropTargets(slugs, existing) {
  const have = new Set(existing);
  return { remove: slugs.filter((s) => have.has(s)), unknown: slugs.filter((s) => !have.has(s)) };
}

/** The workflow's next step for a command, given the slugs this PR adds. */
export function plan(cmd, prSlugs) {
  if (cmd.drop) return { action: 'drop', files: dropTargets(cmd.drop, prSlugs).remove.map((s) => `games/${s}.yaml`) };
  if (cmd.reject) return { action: 'reject', text: cmd.reject };
  if (cmd.changes) return { action: 'changes', text: cmd.changes };
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = parseCommand(process.env.COMMENT_BODY ?? '', { association: process.env.COMMENT_ASSOCIATION ?? '' });
  if (cmd) {
    const prSlugs = (process.env.PR_SLUGS ?? '').split(/\s+/).filter((s) => SLUG.test(s));
    const out = plan(cmd, prSlugs);
    if (out) console.log(JSON.stringify(out));
  }
}
