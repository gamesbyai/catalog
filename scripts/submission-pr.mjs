#!/usr/bin/env node
// Opens (or, for an edited issue, updates) the draft PR for a submission, with the GitHub App's token so the capture
// and validate workflows run on it. Talks to the REST API directly: no shell ever sees issue text.
// Usage (CI): GH_TOKEN=… ISSUE_NUMBER=… node scripts/submission-pr.mjs <converter-output.json>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Our comments quote converter notes, which can echo submitted text: neutralise Markdown and mentions.
const esc = (s) => String(s).replace(/[\\`*_{}[\]()#+!|<>~@]/g, (c) => `\\${c}`);

export async function openOrUpdate(out, { repo, issue, token, fetchImpl = fetch }) {
  const api = (path, init = {}) =>
    fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'gamesbyai-bot', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    });
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

  if (out.error) {
    await post(`/issues/${issue}/comments`, { body: `Thanks for the submission. It can't go to review yet: ${esc(out.error)}\n\nEdit the issue to fix it and the check runs again.` });
    await post(`/issues/${issue}/labels`, { labels: ['needs-changes'] });
    return {};
  }
  if (!SLUG.test(out.slug)) throw new Error('unexpected slug');
  const branch = `submission/${out.slug}`;
  const path = `games/${out.slug}.yaml`;

  const ref = await api(`/git/ref/heads/${branch}`);
  if (ref.status === 404) {
    const main = await (await api('/git/ref/heads/main')).json();
    await post('/git/refs', { ref: `refs/heads/${branch}`, sha: main.object.sha });
  }
  const existing = await api(`/contents/${path}?ref=${encodeURIComponent(branch)}`);
  const sha = existing.ok ? (await existing.json()).sha : undefined;
  await api(`/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({ message: `Submission #${issue}: ${out.slug}`, content: Buffer.from(out.yaml).toString('base64'), branch, ...(sha ? { sha } : {}) }),
  });

  const open = await (await api(`/pulls?head=${encodeURIComponent(`${repo.split('/')[0]}:${branch}`)}&state=open`)).json();
  let pr = open[0];
  if (!pr) {
    const notes = out.notes?.length ? `\n\nNotes:\n${out.notes.map((n) => `- ${esc(n)}`).join('\n')}` : '';
    const res = await post('/pulls', { title: `Submission: ${out.slug}`, head: branch, base: 'main', body: `Closes #${issue}. Draft entry from the submission form; screenshots and the review card follow.${notes}` });
    pr = await res.json();
    await post(`/issues/${issue}/comments`, { body: `Thanks. Your game is in review: ${pr.html_url}` });
  }
  return { pr: pr.html_url };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const r = await openOrUpdate(out, { repo: process.env.GITHUB_REPOSITORY, issue: Number(process.env.ISSUE_NUMBER), token: process.env.GH_TOKEN });
  console.log(r.pr ? `PR ${r.pr}` : 'refused with a comment');
}
