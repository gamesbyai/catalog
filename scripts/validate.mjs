#!/usr/bin/env node
// Validates every game and taxonomy file. Runs in this repo's CI on every PR (no secrets involved).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const KINDS = ['providers', 'models', 'tools', 'engines', 'genres', 'jams'];

export function validate(dir = '.') {
  const problems = [];
  // strictTypes/strictRequired off: the live-entry if/then refers to root properties without redefining them.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
  addFormats(ajv);
  const load = (f) => JSON.parse(readFileSync(join(dir, 'schema', f), 'utf8'));
  const vGame = ajv.compile(load('game.schema.json'));
  const vTax = ajv.compile(load('taxonomy.schema.json'));
  const fmt = (file, errors) => errors.map((e) => `${file}: ${e.instancePath || '(root)'} ${e.message}`);
  const read = (file) => {
    try {
      return parse(readFileSync(join(dir, file), 'utf8'));
    } catch (e) {
      problems.push(`${file}: YAML error ${String(e.message).split('\n')[0]}`);
      return undefined;
    }
  };

  const slugs = {};
  for (const kind of KINDS) {
    const file = `taxonomies/${kind}.yaml`;
    const data = read(file);
    if (data && !vTax(data)) problems.push(...fmt(file, vTax.errors));
    const terms = data?.terms ?? [];
    slugs[kind] = new Set(terms.map((t) => t.slug));
    if (slugs[kind].size !== terms.length) problems.push(`${file}: duplicate slug`);
    for (const t of terms) if (t.parent && !slugs[kind].has(t.parent)) problems.push(`${file}: ${t.slug} has unknown parent ${t.parent}`);
    if (kind === 'models') for (const t of terms) if (!t.provider || !slugs.providers.has(t.provider)) problems.push(`${file}: ${t.slug} has unknown provider "${t.provider ?? ''}"`);
  }

  const gamesDir = join(dir, 'games');
  const files = existsSync(gamesDir) ? readdirSync(gamesDir).filter((f) => f.endsWith('.yaml')).sort() : [];
  const playUrls = new Map();
  for (const f of files) {
    const rel = `games/${f}`;
    const g = read(rel);
    if (g === undefined) continue;
    if (!vGame(g)) {
      problems.push(...fmt(rel, vGame.errors));
      continue;
    }
    if (basename(f, '.yaml') !== g.slug) problems.push(`${rel}: slug "${g.slug}" must match the file name`);
    const check = (kind, list, label) => list.forEach((s) => slugs[kind].has(s) || problems.push(`${rel}: unknown ${label} "${s}"`));
    check('models', g.made.models, 'model');
    check('providers', g.made.providers ?? [], 'provider');
    check('tools', g.made.tools, 'tool');
    // Jam rules require mostly AI-written code, so a jam entry may name no AI at all.
    if (!g.made.models.length && !(g.made.providers ?? []).length && !g.made.tools.length && !g.jam) problems.push(`${rel}: name a model, provider or tool, or a jam`);
    if (g.tech.engine) check('engines', [g.tech.engine], 'engine');
    check('genres', g.genres, 'genre');
    if (g.jam) check('jams', [g.jam.event], 'jam');
    if (g.jam?.rank && g.jam.entries && g.jam.rank > g.jam.entries) problems.push(`${rel}: jam.rank ${g.jam.rank} is above jam.entries ${g.jam.entries}`);
    const key = g.play.url.replace(/\/+$/, '').toLowerCase();
    if (playUrls.has(key)) problems.push(`${rel}: same play.url as ${playUrls.get(key)}`);
    else playUrls.set(key, rel);
  }
  return { problems, files: files.length };
}

async function checkLinks(dir) {
  const bad = [];
  for (const kind of KINDS) {
    for (const t of parse(readFileSync(join(dir, 'taxonomies', `${kind}.yaml`), 'utf8')).terms) {
      if (!t.url) continue;
      const res = await fetch(t.url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (GamesByAI link check; +https://gamesbyai.win)' } }).catch((e) => ({ status: String(e.cause?.code ?? e) }));
      // Bot walls (401/403/429) and oversized headers still prove the site exists; only real breakage fails.
      const alive = typeof res.status === 'number' ? res.status < 400 || [401, 403, 429].includes(res.status) : res.status === 'UND_ERR_HEADERS_OVERFLOW';
      if (!alive) bad.push(`${kind}/${t.slug}: ${t.url} → ${res.status}`);
    }
  }
  return bad;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { problems, files } = validate('.');
  if (process.argv.includes('--check-links')) problems.push(...(await checkLinks('.')));
  if (problems.length) {
    console.error(`${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`catalog OK (${files} games)`);
}
