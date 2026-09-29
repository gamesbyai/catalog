// Cloudflare URL Scanner and play URL checks for submissions. HTTP only: page bodies are never read or executed here.
// Port of the site's scripts/scout/check-lib.mjs (and normalizeUrl from scripts/scout/lib.mjs). Submissions are
// unreleased games, so scans are 'Unlisted' by default (capped at 500 a month); the site's seed scans are public.

const UA = 'Mozilla/5.0 (compatible; GamesByAI-check/1.0; +https://gamesbyai.win)';
const API = 'https://api.cloudflare.com/client/v4/accounts';
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Canonical https URL (lowercase host, no www., no trailing slash, no utm_* params) or null if unsafe. */
export function normalizeUrl(input) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!host.includes('.') || IPV4.test(host) || host.startsWith('[') || host.split('.').some((l) => l.startsWith('xn--'))) return null;
  for (const k of [...u.searchParams.keys()]) if (k.startsWith('utm_')) u.searchParams.delete(k);
  const path = u.pathname.replace(/\/+$/, '');
  const q = u.searchParams.toString();
  return `https://${host}${path}${q ? `?${q}` : ''}`;
}

/** Can gamesbyai.win embed this page in an iframe? */
export function framingAllowed(headers) {
  const xfo = (headers.get('x-frame-options') ?? '').toLowerCase();
  if (xfo.includes('deny') || xfo.includes('sameorigin')) return false;
  const csp = headers.get('content-security-policy') ?? '';
  const fa = csp.split(';').map((d) => d.trim()).find((d) => d.toLowerCase().startsWith('frame-ancestors'));
  if (!fa) return true;
  const sources = fa.split(/\s+/).slice(1);
  return sources.includes('*') || sources.some((s) => /^https:\/\/(\*\.)?gamesbyai\.win\/?$/i.test(s));
}

/** GET with manual redirects (max 5, https only); the body is cancelled unread. */
export async function checkOne(c, { timeoutMs = 15000 } = {}) {
  let url = c.playUrl;
  for (let hop = 0; hop < 6; hop++) {
    let res;
    try {
      res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      return { alive: false, status: 0, finalUrl: url, embeddable: false };
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), url).href;
      if (!normalizeUrl(next)) return { alive: false, status: res.status, finalUrl: next, embeddable: false };
      url = next;
      continue;
    }
    await res.body?.cancel().catch(() => {});
    const alive = res.status >= 200 && res.status < 300;
    return { alive, status: res.status, finalUrl: url, embeddable: alive && framingAllowed(res.headers) };
  }
  return { alive: false, status: 0, finalUrl: url, embeddable: false };
}

/** Submit a Cloudflare URL Scanner scan; returns the uuid. The token needs URL Scanner edit rights. */
export async function submitScan(url, { accountId, token, visibility = 'Unlisted' }) {
  const res = await fetch(`${API}/${encodeURIComponent(accountId)}/urlscanner/v2/scan`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, visibility }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`scan submit ${res.status}: ${JSON.stringify(data.errors ?? data).slice(0, 200)}`);
  return data.uuid ?? data.result?.uuid;
}

/** Poll a scan result: { done: false } while running, else { done: true, malicious }. */
export async function scanResult(uuid, { accountId, token }) {
  const res = await fetch(`${API}/${encodeURIComponent(accountId)}/urlscanner/v2/result/${encodeURIComponent(uuid)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return { done: false };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`scan result ${res.status}`);
  return { done: true, malicious: Boolean(data.verdicts?.overall?.malicious) };
}

/** Polls until the verdict is in or `timeoutMs` has passed; { done: false } on timeout. */
export async function pollScan(uuid, { accountId, token, timeoutMs = 180000, intervalMs = 10000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const attempts = Math.max(1, Math.floor(timeoutMs / intervalMs));
  for (let i = 0; i < attempts; i++) {
    const r = await scanResult(uuid, { accountId, token });
    if (r.done) return r;
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return { done: false };
}
