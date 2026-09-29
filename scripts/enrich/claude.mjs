// Tool-less Claude call on the Max plan (the site's docs/standards/untrusted-content.md, rule 2): no tools, no MCP, no
// settings, no session saved. Untrusted data goes in on stdin; the answer must match the JSON Schema.
// Port of the site's scripts/scout/claude.mjs. In CI the CLI comes from npm (`npx -y @anthropic-ai/claude-code`) and
// authenticates with CLAUDE_CODE_OAUTH_TOKEN; locally set CLAUDE_CLI_PATH. The CLI only ever sees an allowlisted
// environment: never GitHub or Cloudflare tokens, and never ANTHROPIC_API_KEY (no paid API).
import { spawn } from 'node:child_process';

export const PROMPT = 'Write the catalog entry for the game described in the input above. Output only the JSON.';

/** The command that runs Claude Code: `cmd` plus `pre` arguments before ours. */
export function claudeCommand(env = process.env) {
  if (env.CLAUDE_CLI_PATH) return { cmd: env.CLAUDE_CLI_PATH, pre: [] };
  return { cmd: 'npx', pre: ['-y', '@anthropic-ai/claude-code'] };
}

export function claudeArgs(system, schema, { model = 'sonnet' } = {}) {
  return ['-p', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--model', model,
    '--output-format', 'json', '--system-prompt', system, '--json-schema', JSON.stringify(schema), PROMPT];
}

// What the CLI (and npx) needs to start, plus the OAuth token. Names compare case-insensitively (Windows).
const PASS = new Set(['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'SYSTEMROOT', 'COMSPEC',
  'PATHEXT', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'CI', 'CLAUDE_CODE_OAUTH_TOKEN']);

export function claudeEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && PASS.has(k.toUpperCase())));
}

export function claudeJson(system, data, schema, { model = 'sonnet', timeoutMs = 180000, command = claudeCommand() } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(command.cmd, [...command.pre, ...claudeArgs(system, schema, { model })], { stdio: ['pipe', 'pipe', 'pipe'], env: claudeEnv() });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('claude timed out')); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(`claude could not start: ${e.code ?? e.message}`)); });
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.stdin.on('error', () => {});
    p.on('close', (code) => {
      clearTimeout(timer);
      try {
        const res = JSON.parse(out);
        if (res.is_error || !res.structured_output) return reject(new Error(`claude: ${res.subtype ?? 'error'} ${String(res.result ?? err).slice(0, 200)}`));
        resolve(res.structured_output);
      } catch {
        reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
      }
    });
    p.stdin.end(data);
  });
}
