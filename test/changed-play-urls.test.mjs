import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { playUrlChanged, changedPlayUrls } from '../scripts/changed-play-urls.mjs';

test('inline YAML play URL changes trigger capture', () => {
  assert.equal(playUrlChanged('play: { url: "https://old.example/", platforms: [browser] }\n', 'play: { url: "https://new.example/", platforms: [browser] }\n'), true);
  assert.equal(playUrlChanged('play:\n  url: https://old.example/\n', 'play: { url: "https://new.example/" }\n'), true);
});

test('only the parsed play URL controls capture, regardless of formatting or other URLs', () => {
  const before = 'play:\n  url: https://game.example/\ncreator:\n  url: https://creator.example/\n';
  assert.equal(playUrlChanged(before, 'creator: { url: https://other.example/ }\nplay: { platforms: [browser], url: "https://game.example/" }\n'), false);
  assert.equal(playUrlChanged(before, 'play:\n  url: "https://game.example/" # unchanged\n'), false);
  assert.equal(playUrlChanged('title: Game\n', 'play: { url: https://game.example/ }\n'), true);
  assert.equal(playUrlChanged(before, 'title: Game\n'), true);
});

test('invalid YAML stops the comparison', () => {
  assert.throws(() => playUrlChanged('play: { url: [\n', 'play: {}\n'));
  assert.throws(() => playUrlChanged('play: {}\n', 'play: {}\nplay: {}\n'));
});

test('changedPlayUrls reads old content with git show and filters unsafe paths', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'play-urls-'));
  mkdirSync(join(repoDir, 'games'));
  writeFileSync(join(repoDir, 'games', 'changed.yaml'), 'play: { url: https://new.example/ }\n');
  writeFileSync(join(repoDir, 'games', 'same.yaml'), 'play: { url: https://old.example/ }\n');
  const calls = [];
  const execFile = (command, args) => {
    assert.equal(command, 'git');
    assert.deepEqual(args.slice(0, 2), ['-C', repoDir]);
    calls.push(args.slice(2));
    if (args[2] === 'diff') return 'games/changed.yaml\0games/same.yaml\0games/$(unsafe).yaml\0games/../outside.yaml\0';
    assert.equal(args[2], 'show');
    return 'play: { url: https://old.example/ }\n';
  };
  assert.deepEqual(changedPlayUrls('base-sha', { repoDir, execFile }), ['games/changed.yaml']);
  assert.deepEqual(calls, [
    ['diff', '--name-only', '--diff-filter=M', '-z', 'base-sha', 'HEAD', '--', 'games/*.yaml'],
    ['show', 'base-sha:games/changed.yaml'],
    ['show', 'base-sha:games/same.yaml'],
  ]);
});

test('the capture workflow installs YAML before comparing play URLs without shell interpolation', () => {
  const wf = parse(readFileSync('.github/workflows/capture.yml', 'utf8'));
  const steps = wf.jobs.capture.steps;
  const list = steps.findIndex((s) => s.id === 'list');
  assert.match(steps[list].run, /node scripts\/changed-play-urls\.mjs "\$fork"/);
  assert.doesNotMatch(steps[list].run, /grep|\$\{\{/);
  const node = steps.findIndex((s) => s.uses?.startsWith('actions/setup-node@'));
  const install = steps.findIndex((s) => s.run?.startsWith('npm ci'));
  assert.ok(node < install && install < list);
  assert.equal(steps[node].if, undefined);
  assert.equal(steps[install].if, undefined);
  assert.doesNotMatch(JSON.stringify(wf.jobs.capture), /secrets\./);
  assert.match(wf.jobs.upload.steps.find((s) => s.run?.startsWith('npm ci')).run, /--ignore-scripts/);
});
