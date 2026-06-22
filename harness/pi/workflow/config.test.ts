/**
 * Unit tests for workflow/config (slice 1). Pure + offline, verdict.test.ts style: loadWorkflowConfig
 * against crafted harness/checks.json under isolated os.tmpdir() dirs; clamps/defaults/inert exercised.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { loadWorkflowConfig, type WorkflowConfig, withWorkflowDefaults } from "./config.ts";

function mkTmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "workflow-"));
}
function writeChecks(dir: string, content: unknown): void {
	const hd = path.join(dir, "harness");
	fs.mkdirSync(hd, { recursive: true });
	fs.writeFileSync(path.join(hd, "checks.json"), typeof content === "string" ? content : JSON.stringify(content));
}
function loadWith(content: unknown): WorkflowConfig | undefined {
	const tmp = mkTmp();
	try {
		writeChecks(tmp, content);
		return loadWorkflowConfig(tmp);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

test("present-but-empty ({}) → all LOCKED defaults", () => {
	assert.deepEqual(loadWith({ workflow: {} }), {
		maxParallel: 5,
		concurrency: 5,
		maxWorkflowsPerRequest: 2,
		useJudge: true,
		judgeThreshold: 10, // 2×maxParallel
		judgeModel: "",
		synthesize: false,
		maxInputTasks: 30,
		maxResultBytes: 32 * 1024,
		timeoutMs: 600000,
	});
});

test("workflow is an array ([]) → undefined (must NOT activate)", () => {
	assert.equal(loadWith({ workflow: [] }), undefined);
});

test("checks.json present, no workflow key → undefined", () => {
	assert.equal(loadWith({ delegate: {} }), undefined);
});

test("malformed JSON → undefined", () => {
	assert.equal(loadWith("{ nope "), undefined);
});

test("maxParallel clamps to [1, 8] (the kill-switch ceiling); non-number → default 5", () => {
	assert.equal(loadWith({ workflow: { maxParallel: 0 } })?.maxParallel, 1);
	assert.equal(loadWith({ workflow: { maxParallel: 500 } })?.maxParallel, 8);
	assert.equal(loadWith({ workflow: { maxParallel: "x" } })?.maxParallel, 5);
});

test("concurrency is clamped to [1, maxParallel] — its DEFAULT collapses when maxParallel < 5", () => {
	// maxParallel 3, concurrency unspecified → default 5 must collapse to 3 (not exceed maxParallel).
	assert.equal(loadWith({ workflow: { maxParallel: 3 } })?.concurrency, 3);
	// explicit concurrency over the cap → clamped to maxParallel.
	assert.equal(loadWith({ workflow: { maxParallel: 4, concurrency: 99 } })?.concurrency, 4);
	// concurrency 0 → 1 (never a pool that can't drain).
	assert.equal(loadWith({ workflow: { concurrency: 0 } })?.concurrency, 1);
});

test("judgeThreshold defaults to 2×maxParallel; explicit value clamped [1,200]", () => {
	assert.equal(loadWith({ workflow: { maxParallel: 8 } })?.judgeThreshold, 16);
	assert.equal(loadWith({ workflow: { judgeThreshold: 4 } })?.judgeThreshold, 4);
	assert.equal(loadWith({ workflow: { judgeThreshold: 9999 } })?.judgeThreshold, 200);
});

test("booleans typed (useJudge/synthesize); non-boolean → defaults", () => {
	assert.equal(loadWith({ workflow: { useJudge: false } })?.useJudge, false);
	assert.equal(loadWith({ workflow: { useJudge: "yes" } })?.useJudge, true);
	assert.equal(loadWith({ workflow: { synthesize: true } })?.synthesize, true);
	assert.equal(loadWith({ workflow: { synthesize: 1 } })?.synthesize, false);
});

test("maxInputTasks/maxResultBytes/timeoutMs clamp to their ceilings", () => {
	assert.equal(loadWith({ workflow: { maxInputTasks: 9999 } })?.maxInputTasks, 200);
	assert.equal(loadWith({ workflow: { maxResultBytes: 9_999_999 } })?.maxResultBytes, 256 * 1024);
	assert.equal(loadWith({ workflow: { timeoutMs: 9_999_999 } })?.timeoutMs, 30 * 60 * 1000);
	assert.equal(loadWith({ workflow: { timeoutMs: 0 } })?.timeoutMs, 1);
});

test("judgeModel trimmed; non-string → ''", () => {
	assert.equal(loadWith({ workflow: { judgeModel: "  a/b  " } })?.judgeModel, "a/b");
	assert.equal(loadWith({ workflow: { judgeModel: 7 } })?.judgeModel, "");
});

test("full block round-trips within clamps", () => {
	assert.deepEqual(
		withWorkflowDefaults({ maxParallel: 6, concurrency: 4, maxWorkflowsPerRequest: 3, useJudge: false, judgeThreshold: 12, judgeModel: "m", synthesize: true, maxInputTasks: 50, maxResultBytes: 4000, timeoutMs: 120000 }),
		{ maxParallel: 6, concurrency: 4, maxWorkflowsPerRequest: 3, useJudge: false, judgeThreshold: 12, judgeModel: "m", synthesize: true, maxInputTasks: 50, maxResultBytes: 4000, timeoutMs: 120000 },
	);
});
