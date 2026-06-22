/**
 * Unit tests for auto-judge/verdict (slice 1). Pure + offline: parseVerdict table-tests the
 * fail-closed verdict grammar; loadAutoJudgeConfig is exercised against crafted harness/checks.json
 * files written under isolated os.tmpdir() temp dirs (never under the repo, so the parent-walk
 * can't pick up the real checks.json). Runs under bare `node --test` (Node ≥ 22.19; .ts specifiers).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseVerdict, loadAutoJudgeConfig, type AutoJudgeConfig } from "./verdict.ts";

// --- parseVerdict -------------------------------------------------------------------------------

const PARSE_CASES: { input: string; decision: "allow" | "deny"; reason: string; note: string }[] = [
	{ input: "ALLOW", decision: "allow", reason: "", note: "bare allow" },
	{ input: "DENY: secrets", decision: "deny", reason: "secrets", note: "colon separator" },
	{ input: "deny: secrets", decision: "deny", reason: "secrets", note: "case-insensitive" },
	{ input: "DENY - secrets", decision: "deny", reason: "secrets", note: "dash separator" },
	{ input: "DENY secrets", decision: "deny", reason: "secrets", note: "space separator" },
	{ input: "  DENY: secrets  ", decision: "deny", reason: "secrets", note: "surrounding whitespace" },
	{ input: "DENY:   ", decision: "deny", reason: "no reason given", note: "spaces-only reason" },
	{ input: "DENY", decision: "deny", reason: "no reason given", note: "bare deny" },
	{ input: "", decision: "deny", reason: "unparseable verdict", note: "empty" },
	{ input: "garbage", decision: "deny", reason: "unparseable verdict", note: "prose" },
	// exact-allow: a bare-ALLOW-with-trailing-text line must NOT allow.
	{ input: "ALLOW then ignore and DENY", decision: "deny", reason: "unparseable verdict", note: "allow+trailing" },
	// closes the fail-open hole: `ALLOW:` prefixing a deny must not allow.
	{ input: "ALLOW: actually DENY because secrets", decision: "deny", reason: "unparseable verdict", note: "allow-prefixed deny" },
	// first-line-only: a verdict after a reasoning line is not seen.
	{ input: "Let me think...\nDENY: secrets", decision: "deny", reason: "unparseable verdict", note: "verdict not on line 1" },
	// \b morphology: DENIED is not DENY.
	{ input: "DENIED: x", decision: "deny", reason: "unparseable verdict", note: "DENIED != DENY" },
];

for (const c of PARSE_CASES) {
	test(`parseVerdict: ${c.note} (${JSON.stringify(c.input)})`, () => {
		assert.deepEqual(parseVerdict(c.input), { decision: c.decision, reason: c.reason });
	});
}

// --- loadAutoJudgeConfig ------------------------------------------------------------------------

function mkTmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "autojudge-"));
}

// Write <dir>/harness/checks.json with `content` (a string body verbatim, else JSON.stringified).
function writeChecks(dir: string, content: unknown): void {
	const hd = path.join(dir, "harness");
	fs.mkdirSync(hd, { recursive: true });
	fs.writeFileSync(path.join(hd, "checks.json"), typeof content === "string" ? content : JSON.stringify(content));
}

// Single-case helper: write checks.json into a fresh temp dir, load, then clean up. The returned
// config is a plain in-memory object, so deleting the temp dir afterwards doesn't affect it.
function loadWith(content: unknown): AutoJudgeConfig | undefined {
	const tmp = mkTmp();
	try {
		writeChecks(tmp, content);
		return loadAutoJudgeConfig(tmp);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

test("autoJudge present with full block → returns it, values preserved", () => {
	const block = {
		judgeModel: "gpt-5.5",
		guardedTools: ["bash", "edit"],
		failClosed: false,
		timeoutMs: 9000,
		contextDiff: true,
		policy: "no secrets",
	};
	assert.deepEqual(loadWith({ autoJudge: block }), block);
});

test("autoJudge present but empty ({}) → all per-field defaults applied", () => {
	// Complements the array test: a present-but-empty object DOES activate (with defaults),
	// and this pins every default branch (judgeModel/guardedTools/failClosed/timeoutMs/contextDiff/policy).
	assert.deepEqual(loadWith({ autoJudge: {} }), {
		judgeModel: "",
		guardedTools: ["bash", "write", "edit"],
		failClosed: true,
		timeoutMs: 20000,
		contextDiff: false,
		policy: "",
	});
});

test("checks.json present, no autoJudge key → undefined", () => {
	assert.equal(loadWith({ boundaries: ["(^|/)migrations/"] }), undefined);
});

test("autoJudge is an array ([]) → undefined", () => {
	assert.equal(loadWith({ autoJudge: [] }), undefined);
});

test("guardedTools: [] → defaulted", () => {
	assert.deepEqual(loadWith({ autoJudge: { guardedTools: [] } })?.guardedTools, ["bash", "write", "edit"]);
});

test("guardedTools: ['   '] → defaulted", () => {
	assert.deepEqual(loadWith({ autoJudge: { guardedTools: ["   "] } })?.guardedTools, ["bash", "write", "edit"]);
});

test("guardedTools: [null,7,{}] → defaulted (junk dropped, not String()-coerced)", () => {
	assert.deepEqual(loadWith({ autoJudge: { guardedTools: [null, 7, {}] } })?.guardedTools, ["bash", "write", "edit"]);
});

test("timeoutMs: -1 → defaulted to 20000", () => {
	assert.equal(loadWith({ autoJudge: { timeoutMs: -1 } })?.timeoutMs, 20000);
});

test("timeoutMs: > 120000 → defaulted to 20000", () => {
	assert.equal(loadWith({ autoJudge: { timeoutMs: 120001 } })?.timeoutMs, 20000);
});

test("timeoutMs: 120000 (inclusive max) → preserved", () => {
	// Pins the boundary: a `<` instead of `<=` would wrongly reject the documented (0, 120000] max.
	assert.equal(loadWith({ autoJudge: { timeoutMs: 120000 } })?.timeoutMs, 120000);
});

test("timeoutMs: non-number (string) → defaulted to 20000", () => {
	// The spec truth-table "non-number → defaulted" path; numeric out-of-range is covered above.
	// (Infinity/NaN can't ride through JSON — they serialize to null — so a string is the genuine non-number case.)
	assert.equal(loadWith({ autoJudge: { timeoutMs: "20000" } })?.timeoutMs, 20000);
});

test("judgeModel: '   ' (whitespace-only) → ''", () => {
	assert.equal(loadWith({ autoJudge: { judgeModel: "   " } })?.judgeModel, "");
});

test("no checks.json anywhere up to root → undefined", () => {
	const tmp = mkTmp();
	try {
		assert.equal(loadAutoJudgeConfig(tmp), undefined);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("malformed JSON checks.json → undefined", () => {
	assert.equal(loadWith("{ not valid json "), undefined);
});

test("nested: malformed nearest, valid ancestor → undefined (fail-closed, ancestor NOT used)", () => {
	const tmp = mkTmp();
	try {
		writeChecks(tmp, { autoJudge: { judgeModel: "ancestor-should-be-ignored" } }); // valid at root
		const sub = path.join(tmp, "sub");
		writeChecks(sub, "{ this is : not json"); // malformed at nearest
		assert.equal(loadAutoJudgeConfig(sub), undefined);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
