import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

// The one author submission.yml treats as a bot: the site's own GitHub App, matched by the user id of its bot account.
// The id survives a rename of the App, which a login would not (a renamed App would count as a person and hit the
// three-open limit). `user.type == 'Bot'` would let in every other App installed on the repository, such as dependabot.
const PIN = "${{ github.event.issue.user.id == 335636269 && 'Bot' || 'User' }}";

const text = () => readFileSync('.github/workflows/submission.yml', 'utf8');
const step = (match) => parse(text()).jobs['to-pr'].steps.find(match);

test('the three-open limit skips only the site\'s GitHub App, matched by its user id', () => {
  const limit = step((s) => s.id === 'limit');
  assert.equal(limit.env.AUTHOR_TYPE, PIN);
  assert.match(limit.run, /^if \[ "\$AUTHOR_TYPE" = "Bot" \]; then echo "ok=true" >> "\$GITHUB_OUTPUT"; exit 0; fi$/m);
});

test('only an issue filed by the site\'s GitHub App can name uploaded screenshots', () => {
  assert.equal(step((s) => s.name === 'Convert the issue to an entry').env.ISSUE_AUTHOR_TYPE, PIN);
});

test('a maintainer\'s submission label starts an issue filed without it; other labels never rerun one', () => {
  const wf = parse(text());
  assert.deepEqual(wf.on.issues.types, ['opened', 'edited', 'labeled']);
  assert.equal(wf.jobs['to-pr'].if, "contains(github.event.issue.labels.*.name, 'submission') && github.event.issue.state == 'open' && (github.event.action != 'labeled' || github.event.label.name == 'submission')");
});

test('the workflow never decides by the author type or by a login', () => {
  const wf = text();
  assert.doesNotMatch(wf, /user\.type/);
  assert.doesNotMatch(wf, /user\.login\s*[=!]=/);
  assert.equal(wf.match(/user\.id\b/g).length, 2, 'the pin sits in exactly the two places above');
});
