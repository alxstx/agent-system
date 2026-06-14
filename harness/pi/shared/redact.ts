/**
 * Shared secret redaction — the ONE implementation of "scrub secrets from text".
 *
 * Imported by BOTH:
 *   - the `secret-redaction` main-session hook (scrubs main-session tool_result content), and
 *   - the runner's `runFixedTee` (scrubs /monitor's streamed output + memory/runs/<runId>.log).
 * One pattern set, two call sites, no drift (IMPLEMENTATION-PLAN.md P2.0b, ext-secret-redaction.md §3/§7).
 *
 * `loadRedactor(cwd)` walks up to the repo root, reads optional `harness/redaction.json`
 * ({ replacement, extraPatterns, disableDefault }), compiles the rules ONCE, and returns a
 * configured `redact(text)` closure. ALL replacement logic lives here — including the
 * per-pattern rules that must preserve a capture group (Authorization: header → keep the
 * header name, redact the token), which a flat `text.replace(re, "[REDACTED]")` cannot do.
 * Callers never reimplement a replace loop; they just call the returned `redact`.
 *
 * Patterns are deliberately secret-SHAPED (provider keys, AWS ids, Bearer/Authorization,
 * KEY=/TOKEN= assignments, PEM blocks) — NOT bare hex/base64 — to avoid over-redaction of
 * legitimate hashes/ids. Replacers are functions (not "$1" strings) so a `replacement`
 * containing `$` can never be misinterpreted.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface RedactionConfig {
	/** Token that replaces a detected secret. Default "[REDACTED]". */
	replacement?: string;
	/** Extra regex strings (compiled with the global flag); invalid ones are skipped. */
	extraPatterns?: string[];
	/** When true, only `extraPatterns` apply (the built-in set is disabled). */
	disableDefault?: boolean;
}

interface Rule {
	re: RegExp;
	/** Replacer receives the full match then capture groups; returns the replacement text. */
	replacer: (match: string, ...groups: string[]) => string;
}

const DEFAULT_REPLACEMENT = "[REDACTED]";

// Built-in, secret-shaped rules. `rep` is the configured replacement token.
function defaultRules(rep: string): Rule[] {
	return [
		// Provider keys: sk-/pk-/rk- (OpenAI etc.), GitHub ghp_/gho_/ghs_…
		{ re: /\b(?:sk|pk|rk)-[A-Za-z0-9]{20,}\b/g, replacer: () => rep },
		{ re: /\bgh[posu]_[A-Za-z0-9]{36}\b/g, replacer: () => rep },
		// AWS access key ids
		{ re: /\bAKIA[0-9A-Z]{16}\b/g, replacer: () => rep },
		{ re: /\bASIA[0-9A-Z]{16}\b/g, replacer: () => rep },
		// Slack / Google API key
		{ re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacer: () => rep },
		{ re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacer: () => rep },
		// Authorization / Bearer header — KEEP the header name ($1), redact the token.
		{ re: /(Authorization:\s*(?:Bearer\s+)?)\S+/gi, replacer: (_m, p1) => `${p1}${rep}` },
		// KEY= / TOKEN= / SECRET= / PASSWORD= assignments — keep the lhs + quotes, redact the value.
		{
			re: /((?:[A-Z0-9_]*_)?(?:API_KEY|APIKEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)\s*[=:]\s*)(['"]?)[^\s'"]+\2/gi,
			replacer: (_m, p1, q) => `${p1}${q}${rep}${q}`,
		},
		// PEM private-key blocks.
		{ re: /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]+?-----END [^-]+ PRIVATE KEY-----/g, replacer: () => rep },
	];
}

// Walk up from `cwd` to the repo root (first ancestor with harness/checks.json), the same
// discovery pattern runner.ts uses. Returns the dir, or the resolved cwd if none found.
function findRepoRootForRedaction(cwd: string): string {
	let dir = path.resolve(cwd);
	for (;;) {
		if (fs.existsSync(path.join(dir, "harness", "checks.json"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return path.resolve(cwd);
		dir = parent;
	}
}

function readConfig(repoRoot: string): RedactionConfig {
	try {
		const raw = fs.readFileSync(path.join(repoRoot, "harness", "redaction.json"), "utf-8");
		return JSON.parse(raw) as RedactionConfig;
	} catch {
		return {};
	}
}

/**
 * Build a configured redactor. Reads harness/redaction.json (if present) relative to the
 * repo root discovered from `cwd`, compiles defaults + extras once, returns `redact(text)`.
 */
export function loadRedactor(cwd: string): (text: string) => string {
	const repoRoot = findRepoRootForRedaction(cwd);
	const cfg = readConfig(repoRoot);
	const rep = cfg.replacement ?? DEFAULT_REPLACEMENT;
	const rules: Rule[] = cfg.disableDefault ? [] : defaultRules(rep);
	for (const pat of cfg.extraPatterns ?? []) {
		try {
			rules.push({ re: new RegExp(pat, "g"), replacer: () => rep }); // mirrors runner.ts's compile-with-guard
		} catch {
			/* skip invalid pattern, keep the redactor working */
		}
	}
	return (text: string): string => {
		if (!text) return text;
		let out = text;
		for (const rule of rules) out = out.replace(rule.re, rule.replacer);
		return out;
	};
}
