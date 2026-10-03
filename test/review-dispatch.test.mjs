// The review workflow only hands a submission PR over to the site repository after its capture run: the PR number and
// the captured head commit, sent with the GitHub App. These tests hold it to that: no checkout, no other secret, no
// output, and exactly one dispatch whose payload is { pr, head_sha }. Its script runs here in bash with a stand-in `gh`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const WORKFLOWS = '.github/workflows';
const TEXT = readFileSync(join(WORKFLOWS, 'review.yml'), 'utf8');
const FLOW = parse(TEXT);
const JOB = FLOW.jobs.dispatch;
const RUN = JOB.steps.find((s) => s.run).run;
const SHA = 'a'.repeat(40);

function bash() {
  if (process.platform !== 'win32') return 'bash';
  const git = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
  return existsSync(git) ? git : null;
}

/** Runs the step script with a stand-in gh that records each call (token and arguments) and answers `pr list`. */
function dispatch(env, { listed = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'review-dispatch-'));
  const log = join(dir, 'calls').replace(/\\/g, '/');
  const gh = join(dir, 'gh');
  writeFileSync(gh, '#!/usr/bin/env bash\n{ printf "%s" "$GH_TOKEN"; for a in "$@"; do printf "\\x1f%s" "$a"; done; printf "\\n"; } >> "$GH_LOG"\nif [ "$1 $2" = "pr list" ]; then printf "%s" "$STUB_PR"; fi\n');
  chmodSync(gh, 0o755);
  try {
    const r = spawnSync(bash(), ['--noprofile', '--norc', '-eo', 'pipefail', '-c', RUN], {
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, GH_LOG: log, STUB_PR: listed, GITHUB_REPOSITORY: 'gamesbyai/catalog', GH_TOKEN: 'ghs_actions', APP_TOKEN: 'ghs_app', ...env },
      encoding: 'utf8',
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => { const [token, ...args] = l.split('\x1f'); return { token, args }; }) : [];
    return { status: r.status, stdout: r.stdout, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The JSON body `gh api` builds from -f (string) and -F (typed) fields, with key[sub]=value nesting. */
function ghBody(args) {
  const body = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-f' && args[i] !== '-F') continue;
    const [key, value] = args[++i].split(/=(.*)/s);
    const typed = args[i - 1] === '-F' && /^-?\d+$/.test(value) ? Number(value) : value;
    const path = key.split('[').map((k) => k.replace(/\]$/, ''));
    let at = body;
    for (const k of path.slice(0, -1)) at = at[k] ??= {};
    at[path.at(-1)] = typed;
  }
  return body;
}

const base = { BRANCH: 'submission/neon-drift', SHA, PR: '7', PR_REF: 'submission/neon-drift' };

test('runs after capture, for same-repository submission branches only, with no checkout and least privilege', () => {
  assert.deepEqual(FLOW.on, { workflow_run: { workflows: ['capture'], types: ['completed'] } });
  assert.deepEqual(FLOW.permissions, {});
  assert.deepEqual(JOB.permissions, { 'pull-requests': 'read' });
  for (const part of ["startsWith(github.event.workflow_run.head_branch, 'submission/')", 'github.event.workflow_run.head_repository.full_name == github.repository', "github.event.workflow_run.conclusion != 'cancelled'"])
    assert.ok(JOB.if.includes(part), part);
  assert.ok(!JOB.steps.some((s) => String(s.uses ?? '').startsWith('actions/checkout')), 'nothing is checked out');
  assert.doesNotMatch(RUN, /\$\{\{/, 'event values reach the script only through env');
  const app = JOB.steps.find((s) => String(s.uses ?? '').startsWith('actions/create-github-app-token@'));
  assert.deepEqual({ ...app.with, 'app-id': undefined, 'private-key': undefined }, { 'app-id': undefined, 'private-key': undefined, owner: 'gamesbyai', repositories: 'gamesbyai-site', 'permission-contents': 'write' });
});

test('only the App secrets are used, and no workflow here holds a review secret', () => {
  assert.deepEqual([...new Set([...TEXT.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]))].sort(), ['GH_APP_ID', 'GH_APP_PRIVATE_KEY']);
  for (const f of readdirSync(WORKFLOWS)) {
    const text = readFileSync(join(WORKFLOWS, f), 'utf8');
    assert.doesNotMatch(text, /CLAUDE_CODE_OAUTH_TOKEN|URLSCAN_TOKEN|PRIVATE_REPO|PRIVATE_TOKEN/, f);
  }
  const words = TEXT.replace(/private-key: \$\{\{ secrets\.GH_APP_PRIVATE_KEY \}\}/g, '');
  assert.doesNotMatch(words, /scan|inject|claude|draft|model|prompt|oauth|private|card|flag/i, 'the workflow says nothing about how the review works');
});

test('one silent dispatch with { pr, head_sha }, sent with the App token', { skip: !bash() && 'bash not found' }, () => {
  const r = dispatch(base);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'nothing in the public log');
  assert.equal(r.calls.length, 1);
  const [call] = r.calls;
  assert.equal(call.token, 'ghs_app');
  assert.deepEqual(call.args.slice(0, 3), ['api', 'repos/gamesbyai/gamesbyai-site/dispatches', '--silent']);
  assert.deepEqual(ghBody(call.args), { event_type: 'catalog-pr', client_payload: { pr: 7, head_sha: SHA } });
});

test('without the event\'s PR (or with another branch\'s), the open same-repository PR is looked up', { skip: !bash() && 'bash not found' }, () => {
  for (const env of [{ ...base, PR: '', PR_REF: '' }, { ...base, PR: '5', PR_REF: 'submission/other' }]) {
    const r = dispatch(env, { listed: '12' });
    assert.equal(r.status, 0);
    assert.equal(r.calls.length, 2);
    assert.equal(r.calls[0].token, 'ghs_actions', 'the lookup uses the workflow token');
    assert.deepEqual(r.calls[0].args.slice(0, 2), ['pr', 'list']);
    assert.ok(r.calls[0].args.includes('submission/neon-drift'));
    assert.deepEqual(ghBody(r.calls[1].args), { event_type: 'catalog-pr', client_payload: { pr: 12, head_sha: SHA } });
  }
  const none = dispatch({ ...base, PR: '' }, { listed: '' });
  assert.equal(none.status, 0);
  assert.equal(none.calls.length, 1, 'lookup only, no dispatch');
  assert.equal(none.stdout.trim(), 'no open pull request for this branch');
});

test('anything but a submission branch, a full SHA and a PR number sends nothing', { skip: !bash() && 'bash not found' }, () => {
  for (const env of [{ BRANCH: 'seed/batch-30' }, { BRANCH: 'submission/x;id' }, { BRANCH: 'submission/$(id)' }, { BRANCH: 'submission/../main' }, { BRANCH: 'submission/Neon' }]) {
    const r = dispatch({ ...base, ...env });
    assert.equal(r.status, 0, env.BRANCH);
    assert.equal(r.calls.length, 0, env.BRANCH);
  }
  for (const sha of ['main', SHA.toUpperCase(), `${SHA}0`, '']) {
    const r = dispatch({ ...base, SHA: sha });
    assert.notEqual(r.status, 0, sha);
    assert.equal(r.calls.length, 0, sha);
  }
  for (const pr of ['0', '7; id', '$(id)', 'abc']) {
    const r = dispatch({ ...base, PR: pr }, { listed: pr });
    assert.equal(r.calls.filter((c) => c.args[0] === 'api').length, 0, pr);
  }
});
