/**
 * Unit tests for delegate/config (slice 2). Pure + offline, verdict.test.ts style (bare `node --test`,
 * Node ≥ 22.19, .ts specifiers): loadDelegateConfig is exercised against crafted harness/checks.json
 * under isolated os.tmpdir() dirs (never the real repo); capResult + buildDelegateUserTurn are pure.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildDelegateUserTurn, capResult, type DelegateConfig, findChecksRoot, loadDelegateConfig } from "./config.ts";

// --- loadDelegateConfig -------------------------------------------------------------------------

function mkTmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "delegate-"));
}
function writeChecks(dir: string, content: unknown): void {
	const hd = path.join(dir, "harness");
	fs.mkdirSync(hd, { recursive: true });
	fs.writeFileSync(path.join(hd, "checks.json"), typeof content === "string" ? content : JSON.stringify(content));
}
function loadWith(content: unknown): DelegateConfig | undefined {
	const tmp = mkTmp();
	try {
		writeChecks(tmp, content);
		return loadDelegateConfig(tmp);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

test("full block → values preserved (within clamps)", () => {
	assert.deepEqual(loadWith({ delegate: { maxCallsPerRequest: 5, confirmOnSpawn: false, model: "x/y", effort: "high", capBytes: 8000 } }), {
		maxCallsPerRequest: 5,
		confirmOnSpawn: false,
		model: "x/y",
		effort: "high",
		capBytes: 8000,
	});
});

test("present-but-empty ({}) → all per-field defaults", () => {
	assert.deepEqual(loadWith({ delegate: {} }), {
		maxCallsPerRequest: 3,
		confirmOnSpawn: true,
		model: "",
		effort: "",
		capBytes: 16 * 1024,
	});
});

test("delegate is an array ([]) → undefined (must NOT activate)", () => {
	assert.equal(loadWith({ delegate: [] }), undefined);
});

test("checks.json present, no delegate key → undefined", () => {
	assert.equal(loadWith({ autoJudge: {} }), undefined);
});

test("malformed JSON → undefined", () => {
	assert.equal(loadWith("{ not json "), undefined);
});

test("no checks.json anywhere up to root → undefined", () => {
	const tmp = mkTmp();
	try {
		assert.equal(loadDelegateConfig(tmp), undefined);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("nested: malformed nearest, valid ancestor → undefined (fail-safe, ancestor NOT used)", () => {
	const tmp = mkTmp();
	try {
		writeChecks(tmp, { delegate: { model: "ancestor-should-be-ignored" } });
		const sub = path.join(tmp, "sub");
		writeChecks(sub, "{ not json");
		assert.equal(loadDelegateConfig(sub), undefined);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("maxCallsPerRequest clamps to [1, 20]; non-number → default 3; rounds", () => {
	assert.equal(loadWith({ delegate: { maxCallsPerRequest: 0 } })?.maxCallsPerRequest, 1);
	assert.equal(loadWith({ delegate: { maxCallsPerRequest: -4 } })?.maxCallsPerRequest, 1);
	assert.equal(loadWith({ delegate: { maxCallsPerRequest: 100 } })?.maxCallsPerRequest, 20);
	assert.equal(loadWith({ delegate: { maxCallsPerRequest: 2.6 } })?.maxCallsPerRequest, 3);
	assert.equal(loadWith({ delegate: { maxCallsPerRequest: "x" } })?.maxCallsPerRequest, 3);
});

test("capBytes clamps to [1, 262144]; non-number → default 16384", () => {
	assert.equal(loadWith({ delegate: { capBytes: 0 } })?.capBytes, 1);
	assert.equal(loadWith({ delegate: { capBytes: 9_999_999 } })?.capBytes, 256 * 1024);
	assert.equal(loadWith({ delegate: { capBytes: "big" } })?.capBytes, 16 * 1024);
});

test("confirmOnSpawn: non-boolean → true; explicit false preserved", () => {
	assert.equal(loadWith({ delegate: { confirmOnSpawn: "yes" } })?.confirmOnSpawn, true);
	assert.equal(loadWith({ delegate: { confirmOnSpawn: false } })?.confirmOnSpawn, false);
});

test("model/effort: trimmed; non-string → ''", () => {
	assert.equal(loadWith({ delegate: { model: "  a/b  " } })?.model, "a/b");
	assert.equal(loadWith({ delegate: { effort: 7 } })?.effort, "");
});

// --- findChecksRoot (single root for config + file reads — Decision 9) --------------------------

test("findChecksRoot: returns the dir holding the nearest harness/checks.json (from a subdir)", () => {
	const tmp = mkTmp();
	try {
		writeChecks(tmp, { delegate: {} });
		const sub = path.join(tmp, "a", "b");
		fs.mkdirSync(sub, { recursive: true });
		// realpath: os.tmpdir() on macOS is a /var → /private/var symlink; resolve both sides.
		assert.equal(fs.realpathSync(findChecksRoot(sub) as string), fs.realpathSync(tmp));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("findChecksRoot: undefined when no checks.json up to root", () => {
	const tmp = mkTmp();
	try {
		assert.equal(findChecksRoot(tmp), undefined);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

// --- capResult ----------------------------------------------------------------------------------

test("capResult: under/at the cap → unchanged", () => {
	assert.equal(capResult("hello", 50), "hello");
	assert.equal(capResult("a".repeat(50), 50), "a".repeat(50));
});

test("capResult: over the cap → byte-honest truncation + marker", () => {
	const out = capResult("a".repeat(100), 50);
	assert.ok(out.startsWith("a".repeat(50)));
	assert.ok(!out.includes("a".repeat(51)));
	assert.match(out, /\[result truncated at 50 bytes\]$/);
});

test("capResult: honors the cap in BYTES on multibyte text (not UTF-16 code units)", () => {
	// Each "é" is 2 UTF-8 bytes: 100 chars = 200 bytes. A naive UTF-16 `slice(0,50)` would keep 50
	// chars = 100 bytes (2× over the cap); the Buffer slice keeps 25 chars = 50 bytes. This distinguishes.
	const out = capResult("é".repeat(100), 50);
	const body = out.split("\n\n[result truncated")[0];
	assert.ok(Buffer.byteLength(body, "utf-8") <= 50, `body must be ≤ 50 bytes, got ${Buffer.byteLength(body, "utf-8")}`);
});

// --- buildDelegateUserTurn ----------------------------------------------------------------------

test("buildDelegateUserTurn: includes memory index when present, plus prompt + handoff", () => {
	const turn = buildDelegateUserTurn("MEMORY CONTENT", "find the auth bug");
	assert.match(turn, /memory\/MEMORY\.md/);
	assert.match(turn, /MEMORY CONTENT/);
	assert.match(turn, /find the auth bug/);
	assert.match(turn, /final message IS the answer/i);
	assert.match(turn, /READ-ONLY/);
});

test("buildDelegateUserTurn: omits the memory section when index is empty/blank", () => {
	const turn = buildDelegateUserTurn("   ", "trace the request path");
	assert.doesNotMatch(turn, /memory index/i);
	assert.match(turn, /trace the request path/);
	assert.match(turn, /HARNESS HANDOFF/);
});
