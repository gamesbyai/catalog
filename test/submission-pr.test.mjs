import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openOrUpdate } from '../scripts/submission-pr.mjs';

function fakeGitHub({ branchExists = false, prExists = false, existingUrl = 'https://sky.example.com', prBody = 'Closes #12. Entry from the submission form.' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname + u.search, body });
    if (method === 'GET' && u.pathname.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'mainsha' } });
    // Only the first pending branch exists; a re-slugged branch is new.
    const taken = (p) => branchExists && /submission\/sky-hop$|games\/sky-hop\.yaml$/.test(p);
    if (method === 'GET' && u.pathname.includes('/git/ref/heads/submission/')) return taken(u.pathname) ? Response.json({ object: { sha: 'b' } }) : new Response('', { status: 404 });
    if (method === 'GET' && u.pathname.includes('/contents/')) return taken(u.pathname) ? Response.json({ sha: 'filesha', content: Buffer.from(`slug: sky-hop\nplay:\n  url: ${existingUrl}\n`).toString('base64') }) : new Response('', { status: 404 });
    if (method === 'GET' && u.pathname.endsWith('/pulls')) return Response.json(prExists && decodeURIComponent(u.search).endsWith('submission/sky-hop&state=open') ? [{ number: 9, html_url: 'https://github.com/gamesbyai/catalog/pull/9', body: prBody }] : []);
    if (method === 'POST' && u.pathname.endsWith('/pulls')) return Response.json({ number: 9, html_url: 'https://github.com/gamesbyai/catalog/pull/9' }, { status: 201 });
    return Response.json({}, { status: 201 });
  };
  return { calls, fetchImpl };
}
const ok = { slug: 'sky-hop', yaml: 'slug: sky-hop\ntitle: Sky Hop\nplay:\n  url: https://sky.example.com\n', notes: ['Unknown model "Mystery *9*" was left out.'] };
const ctx = (fetchImpl) => ({ repo: 'gamesbyai/catalog', issue: 12, token: 't', fetchImpl });

test('a new submission gets a branch, the file and a PR that closes the issue', async () => {
  const gh = fakeGitHub();
  const r = await openOrUpdate(ok, ctx(gh.fetchImpl));
  assert.equal(r.pr, 'https://github.com/gamesbyai/catalog/pull/9');
  assert.ok(gh.calls.some((c) => c.method === 'POST' && c.path.endsWith('/git/refs') && c.body.ref === 'refs/heads/submission/sky-hop' && c.body.sha === 'mainsha'));
  const put = gh.calls.find((c) => c.method === 'PUT');
  assert.equal(put.path, '/repos/gamesbyai/catalog/contents/games/sky-hop.yaml');
  assert.equal(Buffer.from(put.body.content, 'base64').toString(), ok.yaml);
  const pr = gh.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls'));
  assert.equal(pr.body.head, 'submission/sky-hop');
  assert.match(pr.body.body, /Closes #12/);
  assert.match(pr.body.body, /Mystery \\\*9\\\*/, 'notes are escaped');
  assert.ok(gh.calls.some((c) => c.method === 'POST' && c.path.endsWith('/issues/12/comments')));
});

test('an edited issue updates the file on the existing branch and PR', async () => {
  const gh = fakeGitHub({ branchExists: true, prExists: true });
  await openOrUpdate(ok, ctx(gh.fetchImpl));
  assert.ok(!gh.calls.some((c) => c.method === 'POST' && c.path.endsWith('/git/refs')));
  assert.equal(gh.calls.find((c) => c.method === 'PUT').body.sha, 'filesha');
  assert.ok(!gh.calls.some((c) => c.method === 'POST' && c.path.endsWith('/pulls')));
  assert.ok(!gh.calls.some((c) => c.method === 'PATCH'), 'the same issue edited again changes nothing else');
});

test('a different game with the same title gets its own slug and branch, never the pending PR', async () => {
  const gh = fakeGitHub({ branchExists: true, prExists: true, existingUrl: 'https://other.example.com', prBody: 'Closes #7.' });
  const r = await openOrUpdate(ok, ctx(gh.fetchImpl));
  assert.ok(gh.calls.some((c) => c.method === 'POST' && c.path.endsWith('/git/refs') && c.body.ref === 'refs/heads/submission/sky-hop-12'));
  const put = gh.calls.find((c) => c.method === 'PUT');
  assert.equal(put.path, '/repos/gamesbyai/catalog/contents/games/sky-hop-12.yaml');
  assert.match(Buffer.from(put.body.content, 'base64').toString(), /^slug: sky-hop-12$/m);
  assert.equal(put.body.sha, undefined);
  assert.equal(gh.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls')).body.head, 'submission/sky-hop-12');
  assert.ok(!gh.calls.some((c) => c.method === 'PATCH'));
  assert.ok(r.pr);
});

test('a resubmission of the same game takes over the pending PR and closes the old issue', async () => {
  const gh = fakeGitHub({ branchExists: true, prExists: true, prBody: 'Closes #7. Entry from the submission form.' });
  await openOrUpdate(ok, ctx(gh.fetchImpl));
  const edit = gh.calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/pulls/9'));
  assert.match(edit.body.body, /^Closes #12\./);
  assert.doesNotMatch(edit.body.body, /#7/);
  assert.ok(gh.calls.some((c) => c.method === 'POST' && c.path.endsWith('/issues/7/comments') && /#12/.test(c.body.body)));
  assert.ok(gh.calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/issues/7') && c.body.state === 'closed'));
});

test('a refused submission only gets a neutral comment and a label', async () => {
  const gh = fakeGitHub();
  const r = await openOrUpdate({ error: 'This game is already in the catalog or waiting for review.' }, ctx(gh.fetchImpl));
  assert.equal(r.pr, undefined);
  assert.deepEqual(gh.calls.map((c) => `${c.method} ${c.path}`), ['POST /repos/gamesbyai/catalog/issues/12/comments', 'POST /repos/gamesbyai/catalog/issues/12/labels']);
});

test('slugs that are not plain kebab-case never reach a branch name or path', async () => {
  const gh = fakeGitHub();
  await assert.rejects(openOrUpdate({ ...ok, slug: '../../main' }, ctx(gh.fetchImpl)));
  assert.equal(gh.calls.length, 0);
});

test('a branch left behind by a closed PR starts again from main, so the new PR runs current scripts', async () => {
  const gh = fakeGitHub({ branchExists: true, prExists: false });
  await openOrUpdate(ok, ctx(gh.fetchImpl));
  const reset = gh.calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/git/refs/heads/submission/sky-hop'));
  assert.deepEqual(reset?.body, { sha: 'mainsha', force: true });
  assert.ok(gh.calls.some((c) => c.method === 'POST' && c.path.endsWith('/pulls')), 'and a new PR opens');
});
