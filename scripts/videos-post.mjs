#!/usr/bin/env node
// Reports are sealed before delivery; only quota reservations bypass PR success.
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { fixedError, errorCode, internalVideosUrl, validateReport, REPORT_ARRAYS, pacificDay } from './find-videos.mjs';

const MAX_POST_BYTES = 512 * 1024;
const MAX_SPOOL_BYTES = 64 * 1024 * 1024;
const digest = (text) => createHash('sha256').update(text).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function reportBatches(report, now = new Date()) {
  validateReport(report, now, 1_000_000);
  const batches = [];
  const fresh = () => ({ ...report, units: batches.length ? 0 : report.units, searches: batches.length ? 0 : report.searches,
    siteComplete: false, ...Object.fromEntries(REPORT_ARRAYS.map((k) => [k, []])) });
  let current = fresh();
  let bytes = Buffer.byteLength(JSON.stringify(current)) + 80;
  const finish = () => { validateReport(current, now); batches.push(current); current = fresh(); bytes = Buffer.byteLength(JSON.stringify(current)) + 80; };
  // This order matches the transaction: all queue deletions precede every enqueue.
  for (const key of REPORT_ARRAYS) for (const value of report[key]) {
    const extra = Buffer.byteLength(JSON.stringify(value)) + (current[key].length ? 1 : 0);
    if (current[key].length >= 5_000 || bytes + extra > MAX_POST_BYTES) finish();
    current[key].push(value); bytes += extra;
  }
  current.siteComplete = report.siteComplete;
  finish();
  return batches.map((b) => ({ ...b, batchId: digest(JSON.stringify(b)) }));
}

// Retry only transient failures. Every attempt carries the same reservation/batch identity.
async function postJson(payload, { notifyUrl, token, fetchImpl = fetch, sleep = delay }) {
  const endpoint = internalVideosUrl(notifyUrl);
  if (!endpoint || !token) throw fixedError('input');
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetchImpl(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(5_000) });
    } catch { /* A lost response can follow a committed transaction. Retry the same identity. */ }
    if (response?.ok) {
      try { return await response.json(); } catch { throw fixedError('response'); }
    }
    if (response && response.status !== 408 && response.status !== 429 && response.status < 500) throw fixedError('post');
    if (attempt < 2) await sleep(250 * 2 ** attempt);
  }
  throw fixedError('post');
}

export function reserveRunQuota({ now = new Date(), runId, searchLimit = 92, ...options }) {
  let sequence = 0;
  return async ({ units, searches }) => {
    const result = await postJson({ action: 'reserve', id: `${runId}:${sequence++}`, day: pacificDay(now), units, searches, searchLimit }, options);
    if (typeof result?.reserved !== 'boolean') throw fixedError('response');
    return result.reserved;
  };
}

function readReport(reportFile) {
  try {
    if (statSync(reportFile).size > MAX_SPOOL_BYTES) throw fixedError('input');
    return JSON.parse(readFileSync(reportFile, 'utf8'));
  } catch (error) { if (error?.code === 'ENOENT') return null; throw fixedError('input'); }
}

export async function postReport({ reportFile, report = readReport(reportFile), now = new Date(), log = console.log, ...options }) {
  if (!report || !options.notifyUrl || !options.token) { log('videos: reports posted 0'); return { posted: false, overflow: 0 }; }
  const batches = reportBatches(report, now);
  let overflow = 0;
  for (const batch of batches) {
    const result = await postJson(batch, options);
    if (!Number.isSafeInteger(result?.overflow) || result.overflow < 0) throw fixedError('response');
    overflow += result.overflow;
  }
  log(`videos: reports posted ${batches.length}; enqueue overflow ${overflow}`);
  return { posted: true, overflow };
}

// Public workflow storage holds authenticated ciphertext only, never the report's private state.
export function sealReport({ reportFile, recoveryFile, token, now = new Date() }) {
  const report = readReport(reportFile);
  if (!report) return false;
  if (!token) throw fixedError('input');
  validateReport(report, now, 1_000_000);
  const iv = randomBytes(12), key = createHash('sha256').update(`videos-outbox-v1:${token}`).digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(report)), cipher.final()]);
  mkdirSync(dirname(recoveryFile), { recursive: true });
  writeFileSync(recoveryFile, Buffer.concat([iv, cipher.getAuthTag(), data]));
  return true;
}

export async function recoverReport({ recoveryFile, token, ...options }) {
  let report;
  try {
    if (statSync(recoveryFile).size > MAX_SPOOL_BYTES + 28) throw fixedError('input');
    const data = readFileSync(recoveryFile);
    const key = createHash('sha256').update(`videos-outbox-v1:${token}`).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    report = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'));
  } catch (error) { if (error?.code === 'ENOENT') return { posted: false, overflow: 0 }; throw fixedError('input'); }
  return postReport({ report, token, ...options });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = { notifyUrl: process.env.NOTIFY_URL, token: process.env.INTERNAL_VIDEOS_TOKEN };
    if (process.argv[2] === '--seal') sealReport({ reportFile: process.argv[3], recoveryFile: process.argv[4], token: options.token });
    else if (process.argv[2] === '--recover') await recoverReport({ recoveryFile: process.argv[3], ...options });
    else if (process.argv[2]) await postReport({ reportFile: process.argv[2], ...options });
    else throw fixedError('input');
  } catch (error) { console.error(`videos: report failed (${errorCode(error)})`); process.exitCode = 1; }
}
