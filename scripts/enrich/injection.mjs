// Flags text that tries to instruct AI tools or hides content (the site's docs/standards/untrusted-content.md, rule 3).
// Copy of the site's scripts/scout/injection.mjs: the RULES literal must stay identical (the site's
// tests/unit/enrich-sync.test.ts compares both files as text).
const RULES = [
  ['instruction-override', /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(instructions?|prompts?|rules)\b/i],
  ['ai-address', /\b(system prompt|you are now|as an ai\b|developer mode|jailbreak|assistant:|dear (ai|llm|model|claude|chatgpt))/i],
  ['hidden-chars', /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/],
  ['encoded-blob', /[A-Za-z0-9+/]{120,}={0,2}/],
  ['html-comment', /<!--/],
  ['script-url', /javascript:|data:text\/html/i],
];

/** Returns a list of flag names; empty means nothing suspicious was found. */
export function scanInjection(text) {
  const t = String(text ?? '');
  return RULES.filter(([, re]) => re.test(t)).map(([name]) => name);
}
