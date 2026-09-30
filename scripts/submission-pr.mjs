#!/usr/bin/env node
// Opens (or, for an edited issue, updates) the PR for a submission, with the GitHub App's token so the capture
// and validate workflows run on it. Talks to the REST API directly: no shell ever sees issue text.
// Usage (CI): GH_TOKEN=… ISSUE_NUMBER=… node scripts/submission-pr.mjs <converter-output.json>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

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
  let slug = out.slug;
  let yaml = out.yaml;
  const playUrl = (text) => parse(text)?.play?.url;
  const pending = async (s) => {
    const r = await api(`/contents/games/${s}.yaml?ref=${encodeURIComponent(`submission/${s}`)}`);
    if (!r.ok) return null;
    const file = await r.json();
    return { sha: file.sha, url: playUrl(Buffer.from(file.content ?? '', 'base64').toString()) };
  };
  // A pending submission of another game already holds this slug: this one gets its own, bound to the issue number.
  let existing = await pending(slug);
  if (existing && existing.url !== playUrl(yaml)) {
    slug = `${out.slug}-${issue}`;
    yaml = yaml.replace(/^slug: .*$/m, `slug: ${slug}`);
    existing = await pending(slug);
  }
  const branch = `submission/${slug}`;
  const path = `games/${slug}.yaml`;

  const ref = await api(`/git/ref/heads/${branch}`);
  const openPr = async () => {
    const res = await api(`/pulls?head=${encodeURIComponent(`${repo.split('/')[0]}:${branch}`)}&state=open`);
    if (!res.ok) throw new Error(`GitHub pull lookup answered ${res.status}`);
    const prs = await res.json();
    if (!Array.isArray(prs)) throw new Error('GitHub pull lookup did not return an array');
    return prs[0];
  };
  const main = async () => (await (await api('/git/ref/heads/main')).json()).object.sha;
  if (ref.status === 404) {
    await post('/git/refs', { ref: `refs/heads/${branch}`, sha: await main() });
  } else if (!(await openPr())) {
    // A branch left behind by an earlier, closed PR (a rejection, or a merge before branches were auto-deleted): start
    // it again from main, or the new PR would run last month's scripts.
    const reset = await api(`/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: await main(), force: true }) });
    if (!reset.ok) throw new Error(`GitHub branch reset answered ${reset.status}`);
    existing = await pending(slug);
  }
  await api(`/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({ message: `Submission #${issue}: ${slug}`, content: Buffer.from(yaml).toString('base64'), branch, ...(existing?.sha ? { sha: existing.sha } : {}) }),
  });

  let pr = await openPr();
  // The same game submitted again (after /changes): this issue takes over the PR and the old issue is closed, so the
  // merge closes and notifies the latest submission.
  const old = Number(/^Closes #(\d+)/.exec(pr?.body ?? '')?.[1]);
  if (pr && old && old !== issue) {
    await api(`/pulls/${pr.number}`, { method: 'PATCH', body: JSON.stringify({ body: pr.body.replace(/^Closes #\d+/, `Closes #${issue}`) }) });
    await post(`/issues/${old}/comments`, { body: `Superseded by #${issue}, which continues this review.` });
    await api(`/issues/${old}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
  }
  if (!pr) {
    const notes = out.notes?.length ? `\n\nNotes:\n${out.notes.map((n) => `- ${esc(n)}`).join('\n')}` : '';
    const res = await post('/pulls', { title: `Submission: ${slug}`, head: branch, base: 'main', body: `Closes #${issue}. Entry from the submission form; screenshots, the drafted description and the review card follow. Merging publishes it.${notes}` });
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
