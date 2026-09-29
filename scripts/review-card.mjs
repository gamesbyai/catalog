#!/usr/bin/env node
// The review card on submission PRs: a PR comment built only from our own data, with every third-party string
// escaped (escapeText from upload.mjs) and every email address removed. Text flagged by the injection scanner is
// withheld, never quoted.
//
// CLI mode runs in .github/workflows/review.yml, a privileged workflow_run job. It never checks out or runs PR code:
// the entry is read through the contents API at the head SHA and parsed as YAML data, the play URL is only
// header-checked and scanned by Cloudflare URL Scanner (unlisted), and the repo README (HTML and comments stripped,
// at most 8 kB) only reaches a tool-less model.
// When the entry has no description yet and nothing is flagged, the drafted tagline and description are written into
// games/<slug>.yaml on the PR branch through the contents API (APP_TOKEN, so the checks rerun), then the card is posted.
// Merging the PR is the approval; there is no scoring (rankings come from player votes).
// Usage (CI): GITHUB_TOKEN=… GITHUB_REPOSITORY=… HEAD_BRANCH=submission/<slug> HEAD_SHA=<sha> [APP_TOKEN=…]
//             [CLAUDE_CODE_OAUTH_TOKEN=…] [URLSCAN_TOKEN=… CLOUDFLARE_ACCOUNT_ID=…] node scripts/review-card.mjs
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse, parseDocument, visit } from 'yaml';
import { escapeText, MEDIA_URL } from './upload.mjs';
import { scanInjection } from './enrich/injection.mjs';
import { draftCandidate, loadTaxonomySlugs, FLAGS } from './enrich/draft.mjs';
import { submitScan, pollScan, checkOne, normalizeUrl } from './enrich/urlscan.mjs';

export const MARKER = '<!-- gamesbyai-review-card -->';
const BOT = 'github-actions[bot]';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BRANCH = /^submission\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const GH_REPO = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/?$/;
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/g;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const README_MAX = 8192;
export const DECISION = 'Merge to publish. Comment /changes <note> or /reject <reason> to decline.';

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const int = (v) => (Number.isInteger(v) ? String(v) : '?');

/** Third-party text for the card: invisible characters and email addresses removed, then escaped. */
function text(value, max = 120) {
  const s = String(value ?? '').normalize('NFC').replace(INVISIBLE, '').replace(EMAIL, '(email removed)');
  return escapeText(s, max);
}

/** Only the part of an error before its first colon: never model output, API bodies or quoted input. */
const label = (reason) => text(String(reason ?? 'unknown').split(':')[0], 80);

/** A Markdown link target for an https URL that passes the site's URL rules, or null. */
function safeHref(url) {
  if (typeof url !== 'string' || !normalizeUrl(url)) return null;
  const u = new URL(url.trim());
  const host = u.hostname.toLowerCase();
  if (host === 'gamesbyai.win' || host.endsWith('.gamesbyai.win') || host.endsWith('.')) return null;
  return u.href.replace(/[\s()[\]<>|"'`\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** Every text value (and key) in the entry that the injection scanner flags, by path: [{ field, rules }]. */
export function scanEntry(entry) {
  const out = [];
  const walk = (v, path, depth) => {
    if (depth > 8 || out.length >= 50) return;
    if (typeof v === 'string') {
      const rules = scanInjection(v);
      if (rules.length) out.push({ field: path || '(entry)', rules });
    } else if (Array.isArray(v)) {
      v.slice(0, 200).forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v).slice(0, 200)) {
        const p = path ? `${path}.${k}` : k;
        const rules = scanInjection(k);
        if (rules.length) out.push({ field: `${p} (key)`, rules });
        walk(x, p, depth + 1);
      }
    }
  };
  if (entry && typeof entry === 'object') walk(entry, '', 0);
  return out;
}

/** README text for the model: no HTML, no comments, no angle brackets, at most 8 kB of UTF-8. */
export function stripReadme(raw, max = README_MAX) {
  let s = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]*(?:\n[ \t]*)+/g, '\n\n')
    .trim();
  if (Buffer.byteLength(s) > max) s = Buffer.from(s).subarray(0, max).toString('utf8').replace(/�+$/, '');
  return s;
}

/** The entry's YAML with the drafted tagline and description (paragraphs joined by a blank line); nothing else changes. */
export function applyDraft(yamlText, draft) {
  const doc = parseDocument(yamlText, { maxAliasCount: 50 });
  if (doc.errors.length) throw new Error('the entry is not valid YAML');
  // An anchored tagline aliased elsewhere would let the draft rewrite that field too (play.url, say).
  let linked = false;
  visit(doc, { Alias: () => { linked = true; return visit.BREAK; }, Node: (_, n) => { if (n.anchor) { linked = true; return visit.BREAK; } } });
  if (linked) throw new Error('the entry uses YAML anchors or aliases');
  const before = { ...doc.toJS(), tagline: undefined, description: undefined };
  doc.set('tagline', draft.tagline);
  doc.set('description', strings(draft.description).join('\n\n'));
  const text = doc.toString({ lineWidth: 0 });
  if (!isDeepStrictEqual({ ...parse(text), tagline: undefined, description: undefined }, before)) throw new Error('the draft changed more than the tagline and description');
  return text;
}

/** Git's blob SHA of a file's text: the contents API's `sha` for replacing exactly this version. */
const blobSha = (text) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');

/** The draft input for a submitted entry. Notes and README are untrusted text; everything else is structured. */
export function candidateFromEntry(entry, readme = '') {
  const e = obj(entry);
  const made = obj(e.made);
  const tech = obj(e.tech);
  const play = obj(e.play);
  const notes = typeof made.notes === 'string' ? made.notes : '';
  return {
    key: typeof play.url === 'string' ? play.url : '',
    source: 'submission',
    name: typeof e.title === 'string' ? e.title : '',
    tools: strings(made.tools),
    providers: strings(made.providers),
    engine: typeof tech.engine === 'string' ? tech.engine : undefined,
    genresHint: strings(e.genres),
    multiplayer: typeof tech.multiplayer === 'string' ? tech.multiplayer : undefined,
    mobile: strings(play.platforms).includes('mobile'),
    repo: typeof e.repo === 'string' ? e.repo : undefined,
    textForDraft: [notes && `How the creator says they made it: ${notes}`, readme && `README:\n${readme}`].filter(Boolean).join('\n\n'),
    flags: [],
  };
}

/**
 * The card's Markdown. `flags`: { injection: [{ field, rules }], notes: [string] }; `scan`: { status: 'done', malicious }
 * or { status: 'pending' | 'error' | 'skipped', reason }; `draft`: draftCandidate's result or { skipped: reason };
 * `repoFacts`: { stars, license, pushedAt, archived }; `capture`: { ready }; `checks`: checkOne's result;
 * `commit`: { status: 'committed' } or { status: 'skipped' | 'error', reason } for the drafted text, or null.
 */
export function reviewCard({ entry, flags = {}, scan = null, draft = null, repoFacts = null, capture = null, checks = null, commit = null, sha = '' }) {
  const e = obj(entry);
  const play = obj(e.play);
  const made = obj(e.made);
  const creator = obj(e.creator);
  const injection = Array.isArray(flags.injection) ? flags.injection : [];
  const flagged = injection.map((f) => String(f.field));
  const hidden = (path) => flagged.some((f) => f === path || f.startsWith(`${path}.`) || f.startsWith(`${path}[`) || f.startsWith(`${path} `));
  const WITHHELD = '_withheld (flagged)_';
  const show = (path, value, max) => (hidden(path) ? WITHHELD : text(value, max));
  const showList = (path, value) => (hidden(path) ? WITHHELD : strings(value).slice(0, 12).map((x) => text(x, 60)).join(', ') || '—');
  const malicious = scan?.status === 'done' && scan.malicious === true;
  const slug = typeof e.slug === 'string' && SLUG.test(e.slug) ? e.slug : null;

  const lines = [MARKER];
  const title = typeof e.title === 'string' ? show('title', e.title, 80) : '(no title)';
  lines.push(`### Review card: ${title} ${slug ? `(\`${slug}\`)` : '(invalid slug)'}`, '');

  // Screenshots: only after upload.mjs wrote the ready marker, and only from our media host.
  if (slug && capture?.ready === true) lines.push(['cover', 'shot-1', 'shot-2'].map((n) => `<img src="${MEDIA_URL}/games/${slug}/${n}-320.webp" width="240" alt="${n}">`).join(' '));
  else lines.push('No screenshots yet: the capture is still running, failed, or has not been uploaded.');
  lines.push('');

  // Facts.
  const playHref = malicious || hidden('play.url') ? null : safeHref(play.url);
  const playCell = typeof play.url !== 'string' ? '—' : `${show('play.url', play.url, 200)}${playHref ? ` · [open](${playHref})` : malicious ? '' : ' · not a safe link'}`;
  const embeddable = checks ? (checks.embeddable ? 'yes' : 'no') : typeof play.embeddable === 'boolean' ? (play.embeddable ? 'yes' : 'no') : 'unknown';
  const scanCell = !scan ? 'not scanned'
    : scan.status === 'done' ? (malicious ? '⛔ malicious' : 'clean (unlisted scan)')
    : scan.status === 'pending' ? `pending: ${label(scan.reason)}`
    : scan.status === 'error' ? `error: ${label(scan.reason)}`
    : `not scanned: ${label(scan.reason)}`;
  let repoCell = '—';
  if (typeof e.repo === 'string') {
    const href = hidden('repo') || !GH_REPO.test(e.repo) ? null : safeHref(e.repo);
    const facts = obj(repoFacts);
    const bits = [show('repo', e.repo, 160) + (href ? ` · [open](${href})` : '')];
    if (Number.isInteger(facts.stars)) bits.push(`★ ${facts.stars}`);
    if (typeof facts.license === 'string' && facts.license) bits.push(facts.license === 'NOASSERTION' ? 'other license' : text(facts.license, 40));
    else if (repoFacts) bits.push('no license');
    if (typeof facts.pushedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(facts.pushedAt)) bits.push(`last push ${facts.pushedAt.slice(0, 10)}`);
    if (facts.archived === true) bits.push('archived');
    repoCell = bits.join(' · ');
  }
  const creatorCell = typeof creator.name === 'string' ? `${show('creator.name', creator.name, 80)}${typeof creator.handle === 'string' ? ` (${show('creator.handle', creator.handle, 40)})` : ''}` : '—';
  const rows = [
    ['Play URL', playCell],
    ...(checks ? [['Responds', checks.alive ? `yes (HTTP ${int(checks.status)})` : checks.status ? `no (HTTP ${int(checks.status)})` : 'no']] : []),
    ['Embeddable', embeddable],
    ['URL Scanner', scanCell],
    ['Repository', repoCell],
    ['Creator', creatorCell],
    ['Made with', `tools: ${showList('made.tools', made.tools)}; models: ${showList('made.models', made.models)}`],
    ['AI share', `${show('made.aiShare', made.aiShare ?? 'unknown', 20)} (evidence: ${show('made.evidence', made.evidence ?? '—', 20)})`],
    ['Genres', showList('genres', e.genres)],
  ];
  lines.push('| Fact | Value |', '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${v} |`), '');
  if (typeof made.notes === 'string' && made.notes.trim()) lines.push("**How they made it** (the creator's words, shown as plain text):", '', `> ${show('made.notes', made.notes, 600)}`, '');

  // Flags.
  const d = draft?.ok === true ? obj(draft.draft) : null;
  const draftFlags = strings(d?.flags);
  const outRules = d && d.isGame !== false ? scanInjection([d.tagline, ...strings(d.description)].join('\n')) : [];
  const flagLines = [];
  for (const f of injection.slice(0, 20)) flagLines.push(`- ⚠ injection in ${text(f.field, 80)}: ${strings(f.rules).map((r) => text(r, 40)).join(', ')}`);
  if (draftFlags.includes('injection')) flagLines.push('- ⚠ injection: the drafting model reported text aimed at AI tools or reviewers');
  if (outRules.length) flagLines.push(`- ⚠ injection in the draft output: ${outRules.join(', ')}`);
  if (malicious) flagLines.push('- ⛔ URL Scanner: malicious');
  if (checks && !checks.alive) flagLines.push('- The play URL did not respond with a page');
  const concerns = draftFlags.filter((f) => f !== 'injection' && FLAGS.includes(f));
  if (concerns.length) flagLines.push(`- Model concerns: ${concerns.join(', ')}`);
  for (const n of strings(flags.notes).slice(0, 10)) flagLines.push(`- ${text(n, 160)}`);
  lines.push('#### Flags', '', ...(flagLines.length ? flagLines : ['None.']), '');

  // The tool-less draft: committed to the entry when nothing was flagged, otherwise a suggestion only.
  lines.push('#### Drafted text', '');
  if (draft?.skipped) lines.push(`No draft: ${label(draft.skipped)}.`);
  else if (!d) lines.push(`No draft: ${draft ? label(draft.reason) : 'not run'}.`);
  else if (d.isGame === false) lines.push('No draft: the model judged that this is not a game.');
  else if (draftFlags.includes('injection') || outRules.length) lines.push('Draft withheld: it was flagged for injection.');
  else {
    const note = commit?.status === 'committed'
      ? `> Drafted by a tool-less model and committed to \`games/${slug}.yaml\`. Edit the file on this branch to change it.`
      : commit ? `> Draft by a tool-less model, not committed (${label(commit.reason)}). Check before use.` : '> Draft by a tool-less model, check before use.';
    lines.push(note, '', `**Tagline:** ${text(d.tagline, 100)}`, '');
    for (const p of strings(d.description).slice(0, 3)) lines.push(text(p, 700), '');
    lines.push(`**Suggested genres:** ${strings(d.genres).slice(0, 3).map((g) => text(g, 40)).join(', ') || '—'}`);
  }
  lines.push('');

  // Decision: merging is the approval. No scoring: rankings come from player votes.
  lines.push('#### Decision', '');
  if (malicious) lines.push('⛔ **Do not merge.** Cloudflare URL Scanner marked the play URL as malicious.');
  else lines.push(DECISION);
  lines.push('', `<sub>Review workflow from main${/^[0-9a-f]{40}$/.test(sha) ? `, entry at ${sha.slice(0, 7)}` : ''}. PR code is never run; entry text is shown as plain text.</sub>`);
  return lines.join('\n') + '\n';
}

/** Reads at most `max` bytes of a response body as UTF-8: { text, truncated }. */
async function readText(res, max) {
  const reader = res.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > max) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return { text: Buffer.concat(chunks).subarray(0, max).toString('utf8'), truncated };
}

/** CLI mode: build the card for the PR on HEAD_BRANCH at HEAD_SHA and post or update it. */
export async function runReview({ env = process.env, run, sleep, log = console.log } = {}) {
  const repo = env.GITHUB_REPOSITORY ?? '';
  const branch = env.HEAD_BRANCH ?? '';
  const sha = env.HEAD_SHA ?? '';
  const m = BRANCH.exec(branch);
  if (!m) throw new Error('HEAD_BRANCH is not a submission/<slug> branch');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('HEAD_SHA is not a full commit SHA');
  if (!REPO.test(repo)) throw new Error('GITHUB_REPOSITORY is not owner/name');
  const slug = m[1];
  const gh = (path, init = {}) =>
    fetch(`https://api.github.com${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'gamesbyai-review', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
    });
  const ghJson = async (path) => {
    const res = await gh(path);
    if (!res.ok) throw new Error(`GitHub ${res.status} on ${path.split('?')[0]}`);
    return res.json();
  };

  // The PR: open, from this repository (never a fork), on exactly this branch.
  const prs = await ghJson(`/repos/${repo}/pulls?head=${encodeURIComponent(`${repo.split('/')[0]}:${branch}`)}&state=open`);
  const pr = (Array.isArray(prs) ? prs : []).find((p) => p?.head?.repo?.full_name === repo && p?.head?.ref === branch && Number.isInteger(p?.number));
  if (!pr) {
    log('no open same-repository PR for this branch');
    return { action: 'skipped' };
  }

  // The entry, as data, at the SHA that was captured.
  const notes = [];
  let entry = null;
  let yaml = '';
  const res = await gh(`/repos/${repo}/contents/games/${slug}.yaml?ref=${sha}`, { headers: { Accept: 'application/vnd.github.raw+json' } });
  if (res.ok) {
    const read = await readText(res, 64 * 1024);
    yaml = read.truncated ? '' : read.text;
    try {
      const data = read.truncated ? null : parse(yaml, { maxAliasCount: 50 });
      entry = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch {
      entry = null;
    }
  }
  if (!entry) notes.push(`games/${slug}.yaml could not be read as an entry`);
  else if (entry.slug !== slug) notes.push('the entry slug differs from the branch name');
  const e = obj(entry);
  const hasDescription = typeof e.description === 'string' && e.description.trim() !== '';
  const injection = scanEntry(e);
  const playUrl = typeof e.play?.url === 'string' && safeHref(e.play.url) ? e.play.url.trim() : null;

  const scanP = (async () => {
    if (!playUrl) return { status: 'skipped', reason: 'no safe play URL' };
    if (!env.URLSCAN_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
      notes.push(`scan pending (${env.URLSCAN_TOKEN ? 'CLOUDFLARE_ACCOUNT_ID' : 'URLSCAN_TOKEN'} not set)`);
      return { status: 'pending', reason: `${env.URLSCAN_TOKEN ? 'CLOUDFLARE_ACCOUNT_ID' : 'URLSCAN_TOKEN'} not set` };
    }
    const auth = { accountId: env.CLOUDFLARE_ACCOUNT_ID, token: env.URLSCAN_TOKEN };
    try {
      const uuid = await submitScan(playUrl, { ...auth, visibility: 'Unlisted' });
      if (!uuid) throw new Error('scan submit: no scan id');
      const r = await pollScan(uuid, { ...auth, timeoutMs: 180000, intervalMs: 10000, sleep });
      return r.done ? { status: 'done', malicious: r.malicious } : { status: 'pending', reason: 'no verdict after 3 minutes' };
    } catch (err) {
      return { status: 'error', reason: err.message };
    }
  })();
  const checksP = playUrl ? checkOne({ playUrl }) : Promise.resolve(null);
  const captureP = fetch(`${MEDIA_URL}/games/${slug}/ready.json`, { method: 'HEAD' }).then((r) => ({ ready: r.ok }), () => ({ ready: false }));
  const repoP = (async () => {
    const rm = typeof e.repo === 'string' ? GH_REPO.exec(e.repo.trim()) : null;
    const name = rm?.[2].replace(/\.git$/, '');
    if (!rm || !name || name === '.' || name === '..') return { facts: null, readme: '' };
    const base = `/repos/${rm[1]}/${name}`;
    let facts = null;
    let readme = '';
    try {
      const r = await gh(base);
      if (r.ok) {
        const d = await r.json();
        facts = { stars: d.stargazers_count, license: d.license?.spdx_id ?? null, pushedAt: d.pushed_at, archived: d.archived === true };
      }
    } catch {}
    try {
      const r = await gh(`${base}/readme`, { headers: { Accept: 'application/vnd.github.raw+json' } });
      if (r.ok) readme = stripReadme((await readText(r, 256 * 1024)).text);
    } catch {}
    return { facts, readme };
  })();
  const draftP = repoP.then(async ({ readme }) => {
    const readmeRules = scanInjection(readme);
    if (readmeRules.length) injection.push({ field: 'README', rules: readmeRules });
    if (!entry) return { skipped: 'the entry could not be read' };
    // Our own commit (or a maintainer's edit) filled it: no new draft, and no loop through the capture rerun.
    if (hasDescription) return { skipped: 'the entry already has a description' };
    if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.CLAUDE_CLI_PATH) return { skipped: 'CLAUDE_CODE_OAUTH_TOKEN not set' };
    if (injection.some((f) => f.field !== 'README')) return { skipped: 'the submission was flagged for injection' };
    try {
      return await draftCandidate(candidateFromEntry(e, readmeRules.length ? '' : readme), { slugs: loadTaxonomySlugs(), run });
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });
  const [scan, checks, ready, { facts: repoFacts }, draft] = await Promise.all([scanP, checksP, captureP, repoP, draftP]);
  // Media are keyed by the file's slug; the card builds image URLs from the entry's, so both must agree.
  const capture = entry?.slug === slug ? ready : { ready: false };

  // Commit the clean draft into the entry, as data, on the PR branch. Any flag, a malicious scan or a missing App
  // token leaves the entry as it is, and the validate check keeps failing on the empty description.
  const commit = await (async () => {
    const d = draft?.ok === true ? obj(draft.draft) : null;
    if (!d || d.isGame === false || !yaml) return null;
    if (entry?.slug !== slug) return { status: 'skipped', reason: 'the entry slug differs from the branch' };
    const outRules = scanInjection([d.tagline, ...strings(d.description)].join('\n'));
    if (injection.length || strings(d.flags).includes('injection') || outRules.length) return { status: 'skipped', reason: 'flagged for injection' };
    if (scan.status === 'done' && scan.malicious) return { status: 'skipped', reason: 'malicious play URL' };
    if (!env.APP_TOKEN) return { status: 'skipped', reason: 'APP_TOKEN not set' };
    try {
      const put = await fetch(`https://api.github.com/repos/${repo}/contents/games/${slug}.yaml`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${env.APP_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'gamesbyai-review', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `Draft the description of ${slug}`, content: Buffer.from(applyDraft(yaml, d)).toString('base64'), branch, sha: blobSha(yaml) }),
      });
      return put.ok ? { status: 'committed' } : { status: 'error', reason: `GitHub ${put.status}` };
    } catch (err) {
      return { status: 'error', reason: err.message };
    }
  })();
  if (entry && !hasDescription && commit?.status !== 'committed') notes.push('no description yet: the validate check fails until one is added');

  const card = reviewCard({ entry, flags: { injection, notes }, scan, draft, repoFacts, capture, checks, commit, sha });
  log(`PR #${pr.number}: scan ${scan.status}, draft ${draft.ok ? 'ok' : 'none'}, commit ${commit?.status ?? 'none'}, screenshots ${capture.ready ? 'ready' : 'not yet'}, ${injection.length} injection flag(s)`);

  // Update our own earlier card, if any; never touch anyone else's comment.
  let own = null;
  for (let page = 1; page <= 10 && !own; page++) {
    const list = await ghJson(`/repos/${repo}/issues/${pr.number}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(list)) break;
    own = list.find((c) => c?.user?.login === BOT && typeof c.body === 'string' && c.body.startsWith(MARKER) && Number.isInteger(c.id)) ?? null;
    if (list.length < 100) break;
  }
  const body = JSON.stringify({ body: card });
  const out = own
    ? await gh(`/repos/${repo}/issues/comments/${own.id}`, { method: 'PATCH', body })
    : await gh(`/repos/${repo}/issues/${pr.number}/comments`, { method: 'POST', body });
  if (!out.ok) throw new Error(`GitHub ${out.status} posting the review card`);
  return { action: own ? 'updated' : 'created', pr: pr.number, card };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runReview().then(
    (r) => console.log(`review card ${r.action}${r.pr ? ` on #${r.pr}` : ''}`),
    (err) => {
      console.error(`review card failed: ${err.message}`);
      process.exit(1);
    },
  );
}
