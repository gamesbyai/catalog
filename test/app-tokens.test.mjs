// Every GitHub App token a workflow here mints names exactly the permissions its job uses. Without them the token gets
// everything the App is installed with, which may include organisation-level rights these public workflows never need.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const DIR = '.github/workflows';
const tokens = readdirSync(DIR).filter((f) => f.endsWith('.yml')).flatMap((file) => {
  const flow = parse(readFileSync(join(DIR, file), 'utf8'));
  return Object.entries(flow.jobs).flatMap(([job, { steps = [] }]) => steps
    .filter((s) => String(s.uses ?? '').startsWith('actions/create-github-app-token@'))
    .map((s) => ({ where: `${file} ${job}`, with: s.with ?? {} })));
});
const permissions = (w) => Object.fromEntries(Object.entries(w).filter(([k]) => k.startsWith('permission-')).map(([k, v]) => [k.slice('permission-'.length), v]));

test('every App token names its permissions, and only contents, pull requests and issues', () => {
  assert.ok(tokens.length >= 5);
  for (const t of tokens) {
    const p = permissions(t.with);
    assert.ok(Object.keys(p).length > 0, `${t.where}: no permission-* inputs`);
    for (const [name, level] of Object.entries(p)) {
      assert.ok(['contents', 'pull-requests', 'issues'].includes(name), `${t.where}: ${name}`);
      assert.ok(['read', 'write'].includes(level), `${t.where}: ${name}=${level}`);
    }
  }
});

test('each workflow keeps the token it needs, scoped to this repository or to the site dispatch', () => {
  const map = Object.fromEntries(tokens.map((t) => [t.where, { repositories: t.with.repositories ?? '(this repository)', ...permissions(t.with) }]));
  assert.deepEqual(map, {
    'on-merge.yml publish': { repositories: 'gamesbyai-site', contents: 'write' },
    'pr-commands.yml command': { repositories: '(this repository)', contents: 'write', 'pull-requests': 'write', issues: 'write' },
    'review.yml dispatch': { repositories: 'gamesbyai-site', contents: 'write' },
    'submission.yml to-pr': { repositories: '(this repository)', contents: 'write', 'pull-requests': 'write', issues: 'write' },
    'videos.yml find': { repositories: '(this repository)', contents: 'write', 'pull-requests': 'write' },
  });
  for (const t of tokens) if (t.with.repositories) assert.equal(t.with.owner, 'gamesbyai', t.where);
});
