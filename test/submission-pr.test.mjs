import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openOrUpdate } from '../scripts/submission-pr.mjs';

function fakeGitHub({ branchExists = false, prExists = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname + u.search, body });
    if (method === 'GET' && u.pathname.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'mainsha' } });
    if (method === 'GET' && u.pathname.includes('/git/ref/heads/submission/')) return branchExists ? Response.json({ object: { sha: 'b' } }) : new Response('', { status: 404 });
    if (method === 'GET' && u.pathname.includes('/contents/')) return branchExists ? Response.json({ sha: 'filesha' }) : new Response('', { status: 404 });
    if (method === 'GET' && u.pathname.endsWith('/pulls')) return Response.json(prExists ? [{ number: 9, html_url: 'https://github.com/gamesbyai/catalog/pull/9' }] : []);
    if (method === 'POST' && u.pathname.endsWith('/pulls')) return Response.json({ number: 9, html_url: 'https://github.com/gamesbyai/catalog/pull/9' }, { status: 201 });
    return Response.json({}, { status: 201 });
  };
  return { calls, fetchImpl };
}
const ok = { slug: 'sky-hop', yaml: 'slug: sky-hop\ntitle: Sky Hop\n', notes: ['Unknown model "Mystery *9*" was left out.'] };
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
