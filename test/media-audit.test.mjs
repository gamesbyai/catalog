import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { auditGame, auditAll, report, summaryTable, variants } from '../scripts/media-audit.mjs';

const MEDIA = 'https://media.gamesbyai.win';
const entry = (slug, { status = 'live', shots = 2 } = {}) => ({ slug, status, media: { cover: `games/${slug}/cover`, screenshots: ['shot-1', 'shot-2'].slice(0, shots).map((n) => `games/${slug}/${n}`) } });

/** Our media host, mocked: markers per slug, and every image variant exists unless listed in `gone`. */
function host(markers, { gone = [], down = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const slug = /\/games\/([a-z0-9-]+)\//.exec(url)?.[1];
    if (down.includes(slug)) return new Response('busy', { status: 503 });
    if (url.includes('/ready.json')) return markers[slug] ? Response.json(markers[slug]) : new Response('', { status: 404 });
    if (!markers[slug]) return new Response('', { status: 404 });
    return gone.some((k) => url.endsWith(k)) ? new Response('', { status: 404 }) : new Response(null, { status: 200 });
  };
  return { fetchImpl, calls };
}

test('a complete game: every variant of every image is checked and nothing is missing', async () => {
  const h = host({ full: { names: ['cover', 'shot-1', 'shot-2'], widths: [320, 640, 960, 1280] } });
  const row = await auditGame(entry('full'), { fetchImpl: h.fetchImpl });
  assert.deepEqual([row.marker, row.broken, row.missingShots, row.missingWidths], ['ok', [], [], []]);
  assert.equal(h.calls.filter((c) => c.startsWith('HEAD')).length, 3 * 8 + 1);
  assert.ok(h.calls.includes(`HEAD ${MEDIA}/games/full/cover-og.jpg`));
  assert.match(h.calls[0], /^GET https:\/\/media\.gamesbyai\.win\/games\/full\/ready\.json\?audit=[a-z0-9]+$/, 'the marker as it is now, not an edge copy');
});

test('a cover-only capture: screenshots missing (a warning), only the cover is checked, an old marker lacks 960', async () => {
  const h = host({ menu: { names: ['cover'] } });
  const row = await auditGame(entry('menu'), { fetchImpl: h.fetchImpl });
  assert.deepEqual(row.missingShots, ['shot-1', 'shot-2']);
  assert.deepEqual(row.missingWidths, [960]);
  assert.deepEqual(row.broken, []);
  assert.ok(!h.calls.some((c) => c.includes('shot-1')), 'images ready.json does not name are never linked, so never checked');
  assert.ok(!h.calls.some((c) => c.includes('-960.')), 'only the sizes ready.json lists');
});

test('a file ready.json names but the host lacks is broken; no marker or no answer are errors too', async () => {
  const h = host({ bad: { names: ['cover', 'shot-1'], widths: [320, 640, 960, 1280] } }, { gone: ['shot-1-960.webp'], down: ['flaky'] });
  const rows = await auditAll([entry('bad'), entry('gone'), entry('flaky'), entry('draft', { status: 'draft' })], { fetchImpl: h.fetchImpl, concurrency: 2 });
  assert.deepEqual(rows.map((r) => r.slug), ['bad', 'draft', 'flaky', 'gone']);
  const by = Object.fromEntries(rows.map((r) => [r.slug, r]));
  assert.deepEqual(by.bad.broken, ['games/bad/shot-1-960.webp']);
  assert.equal(by.gone.marker, 'missing');
  assert.equal(by.flaky.marker, 'unreachable');
  const { groups, failed, lines } = report(rows);
  assert.equal(failed, true);
  assert.deepEqual(groups.broken.map((r) => r.slug), ['bad']);
  assert.deepEqual(groups.noMarker.map((r) => r.slug), ['gone'], 'a draft without images is not an error');
  assert.match(lines.join('\n'), /::error title=Broken media::1 games: bad \(1 files\)/);
  assert.match(lines.join('\n'), /::error title=No ready.json::1 live games: gone/);
});

test('missing screenshots warn; with --max-without-shots too large a share fails the run', async () => {
  const h = host({ a: { names: ['cover'], widths: [320, 640, 960, 1280] }, b: { names: ['cover', 'shot-1', 'shot-2'], widths: [320, 640, 960, 1280] } });
  const rows = await auditAll([entry('a'), entry('b')], { fetchImpl: h.fetchImpl });
  const warn = report(rows);
  assert.equal(warn.failed, false);
  assert.match(warn.lines[1], /1 live games show none \(50%\)/);
  assert.match(warn.lines.join('\n'), /::warning title=Fewer screenshots than listed::1 games \(re-capture with the start step\): a/);
  assert.equal(report(rows, { maxWithoutShots: 60 }).failed, false);
  const strict = report(rows, { maxWithoutShots: 20 });
  assert.equal(strict.failed, true);
  assert.match(strict.lines.at(-1), /50% of live games show no screenshot \(limit 20%\)/);
  const table = summaryTable(rows);
  assert.match(table, /\| `a` \| live \| cover \| shot-1, shot-2 \| — \| — \|/);
  assert.doesNotMatch(table, /`b`/);
});

test('variants: AVIF and WebP per width, the OG JPEG for the cover only', () => {
  assert.deepEqual(variants('cover', [320]), ['-320.avif', '-320.webp', '-og.jpg']);
  assert.deepEqual(variants('shot-1', [320, 640]), ['-320.avif', '-320.webp', '-640.avif', '-640.webp']);
});

test('the media audit workflow runs weekly from main with no secrets and fails on errors', () => {
  const wf = parse(readFileSync('.github/workflows/media-audit.yml', 'utf8'));
  assert.ok(wf.on.schedule?.length && 'workflow_dispatch' in wf.on);
  assert.deepEqual(wf.permissions, { contents: 'read' });
  assert.doesNotMatch(JSON.stringify(wf), /secrets\./);
  const run = wf.jobs.audit.steps.map((s) => s.run ?? '').join('\n');
  assert.match(run, /node scripts\/media-audit\.mjs --summary "\$GITHUB_STEP_SUMMARY" --max-without-shots \d+/);
});
