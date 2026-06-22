/**
 * auto-judge/verdict — slice 1 of the optional LLM-as-judge "auto-mode" for pi
 * (memory/plan-llmjudge.md). Two PURE, OFFLINE helpers; NON-ACTIVATING (no index.ts, no
 * subprocess, no extension wiring — install.sh keys off index.ts, which this slice omits):
 *   - parseVerdict(text): map a judge reply's first non-empty line to allow/deny, fail-closed.
 *   - loadAutoJudgeConfig(cwd): parent-walk for harness/checks.json and return the `autoJudge`
 *     block with per-field defaults, or undefined (extension dormant). Fail-closed on a
 *     malformed nearest config — never walks past it to an ancestor repo's policy.
 *
 * Only node:fs / node:path I/O.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type Verdict = { decision: "allow" | "deny"; reason: string };

export interface AutoJudgeConfig {
	judgeModel: string;
	guardedTools: string[];
	failClosed: boolean;
	timeoutMs: number;
	contextDiff: boolean;
	policy: string;
}

const MAX_TIMEOUT_MS = 120_000;

// First non-empty line is exactly `ALLOW` or `DENY: <reason>` (case-insensitive). Anything else
// (incl. empty, prose, `ALLOW` with trailing text) → deny. Fail-closed; resists injected reversals.
export function parseVerdict(text: string): Verdict {
	const line = (text ?? "").split("\n").map((s) => s.trim()).find((s) => s) ?? "";
	if (/^allow$/i.test(line)) return { decision: "allow", reason: "" };
	const m = line.match(/^deny\b[:\-\s]*(.*)$/i);
	if (m) return { decision: "deny", reason: m[1].trim() || "no reason given" };
	return { decision: "deny", reason: "unparseable verdict" };
}

// Parent-walk for harness/checks.json. Walk on MISSING file only; a present-but-unreadable/malformed
// file is fail-closed (returns undefined) and is NOT walked past to an ancestor repo's policy.
export function loadAutoJudgeConfig(cwd: string): AutoJudgeConfig | undefined {
	let dir = path.resolve(cwd);
	for (;;) {
		const file = path.join(dir, "harness", "checks.json");
		if (fs.existsSync(file)) {
			try {
				const a = JSON.parse(fs.readFileSync(file, "utf-8"))?.autoJudge;
				// Must be a non-null, non-array object; `autoJudge: []` must NOT activate defaults.
				return a && typeof a === "object" && !Array.isArray(a) ? withDefaults(a) : undefined;
			} catch {
				return undefined;
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function withDefaults(a: Record<string, unknown>): AutoJudgeConfig {
	// guardedTools: trim, keep non-empty strings; empty/whitespace/invalid → default (never guard nothing).
	const tools = Array.isArray(a.guardedTools)
		? a.guardedTools
				.filter((t): t is string => typeof t === "string")
				.map((t) => t.trim())
				.filter((t) => t.length > 0)
		: [];
	const t = a.timeoutMs;
	return {
		judgeModel: typeof a.judgeModel === "string" ? a.judgeModel.trim() : "", // whitespace-only → ""
		guardedTools: tools.length ? tools : ["bash", "write", "edit"],
		failClosed: typeof a.failClosed === "boolean" ? a.failClosed : true,
		timeoutMs: typeof t === "number" && Number.isFinite(t) && t > 0 && t <= MAX_TIMEOUT_MS ? t : 20000,
		contextDiff: typeof a.contextDiff === "boolean" ? a.contextDiff : false,
		policy: typeof a.policy === "string" ? a.policy : "",
	};
}
