/**
 * Unit tests for workflow/right-size (slice 1). Pure governor (normalize/clamp/parse) + the injectable
 * concurrency pool (scheduling / abort-drains / throw→null) + the R3-BLOCKER assertion that a worker
 * result is redactor-scrubbed BEFORE the fs write. `rightSize` itself spawns a judge → integration
 * (slice-4 live), not here. Bare `node --test`, offline.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { redactOnWrite } from "../shared/subagent-core.ts";
import { clampKept, normalizeTasks, parseRightSizerReply, runPool } from "./right-size.ts";

// --- normalizeTasks ------------------------------------------------------------------------------

test("normalizeTasks: trims, drops empty/non-string, dedupes (exact), caps to maxInputTasks", () => {
	assert.deepEqual(normalizeTasks(["a", " a ", "", "b", null, 7, "a"], 10), ["a", "b"]);
	assert.deepEqual(normalizeTasks(["a", "b", "c", "d"], 2), ["a", "b"]); // cap
	assert.deepEqual(normalizeTasks("not an array", 10), []);
	assert.deepEqual(normalizeTasks([], 10), []);
});

// --- clampKept (the unconditional cost floor) ----------------------------------------------------

test("clampKept: keeps at most maxParallel; floors maxParallel at 1", () => {
	assert.deepEqual(clampKept(["a", "b", "c"], 2), ["a", "b"]);
	assert.deepEqual(clampKept(["a", "b", "c"], 0), ["a"]); // never 0-wide
	assert.deepEqual(clampKept(["a"], 5), ["a"]);
});

// --- parseRightSizerReply ------------------------------------------------------------------------

test("parseRightSizerReply: KEEP/MERGE lines → task texts, rationale stripped", () => {
	const reply = "KEEP: investigate auth — distinct\nMERGE: trace request and response paths — overlap";
	assert.deepEqual(parseRightSizerReply(reply), ["investigate auth", "trace request and response paths"]);
});

test("parseRightSizerReply: tolerates leading numbers + case; null when nothing parseable", () => {
	assert.deepEqual(parseRightSizerReply("1. keep: foo\n2) MERGE bar"), ["foo", "bar"]);
	assert.equal(parseRightSizerReply("I think we should keep all of them, they're all good."), null);
	assert.equal(parseRightSizerReply(""), null);
});

test("parseRightSizerReply: a hyphenated task survives (only em/en dash splits the rationale)", () => {
	assert.deepEqual(parseRightSizerReply("KEEP: compare a-b vs c-d setup — note"), ["compare a-b vs c-d setup"]);
});

test("parseRightSizerReply: a bare marker line (KEEP: / MERGE-) yields NO junk task", () => {
	assert.equal(parseRightSizerReply("KEEP:"), null); // not [":"]
	assert.equal(parseRightSizerReply("MERGE-"), null);
	// a real task on the next line still parses; the bare marker is just skipped.
	assert.deepEqual(parseRightSizerReply("KEEP:\nKEEP: real task — why"), ["real task"]);
});

// --- runPool -------------------------------------------------------------------------------------

test("runPool: runs every item, results in order", async () => {
	const out = await runPool([1, 2, 3, 4], 2, async (n) => n * 10);
	assert.deepEqual(out, [10, 20, 30, 40]);
});

test("runPool: never exceeds `concurrency` in flight", async () => {
	let active = 0, max = 0;
	await runPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
		active++; max = Math.max(max, active);
		await new Promise((r) => setTimeout(r, 5));
		active--; return n;
	});
	assert.ok(max <= 2, `max concurrent ${max} must be ≤ 2`);
	assert.ok(max >= 2, `expected to reach the cap (got ${max})`);
});

test("runPool: a worker that throws drops that item to null; others still run", async () => {
	const out = await runPool([1, 2, 3], 3, async (n) => {
		if (n === 2) throw new Error("boom");
		return n;
	});
	assert.deepEqual(out, [1, null, 3]);
});

test("runPool: already-aborted signal → no items run, all null", async () => {
	const ac = new AbortController();
	ac.abort();
	let calls = 0;
	const out = await runPool([1, 2, 3], 2, async (n) => { calls++; return n; }, ac.signal);
	assert.equal(calls, 0, "no worker should start once aborted");
	assert.deepEqual(out, [null, null, null]);
});

test("runPool: abort mid-run drains the queue (no NEW items start; in-flight see the signal)", async () => {
	const ac = new AbortController();
	const ran: number[] = [];
	// concurrency 1 → strictly sequential; item 0 aborts, so 1/2/3 must never start.
	const out = await runPool([0, 1, 2, 3], 1, async (n, _i, signal) => {
		ran.push(n);
		if (n === 0) ac.abort();
		return signal?.aborted ? `aborted-${n}` : `ok-${n}`;
	}, ac.signal);
	assert.deepEqual(ran, [0], "only item 0 ran; the queue drained after abort");
	assert.equal(out[0], "aborted-0", "the in-flight worker saw the signal");
	assert.deepEqual(out.slice(1), [null, null, null]);
});

// --- redact-on-write before fs.write (R3-BLOCKER, asserted offline) ------------------------------

test("a worker result is redactor-scrubbed BEFORE the fs write (no raw secret reaches disk)", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-write-"));
	try {
		const dir = path.join(tmp, "memory", "workflow", "run-1");
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "0-task.md");
		// stand-in for loadRedactor(root): redact an AWS-key-shaped token.
		const redact = (s: string) => s.replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED]");
		redactOnWrite(redact, file, "worker found AKIA1234567890ABCDEF in a config", 32 * 1024);
		const onDisk = fs.readFileSync(file, "utf-8");
		assert.ok(!/AKIA[0-9A-Z]{16}/.test(onDisk), "no raw secret on disk");
		assert.match(onDisk, /\[REDACTED\]/);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("redactOnWrite ORDER: redaction runs BEFORE any write — a throwing redactor leaves NO file", () => {
	// Pins the R3-BLOCKER ordering (not just the result): a write-then-redact impl would have already
	// written the RAW secret to disk before the redactor threw. redact-then-write never touches disk.
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-order-"));
	try {
		const file = path.join(tmp, "leak.md");
		const throwing = () => {
			throw new Error("redactor blew up");
		};
		assert.throws(() => redactOnWrite(throwing, file, "secret AKIA1234567890ABCDEF here", 32 * 1024));
		assert.ok(!fs.existsSync(file), "no file may exist when the redactor throws before the write");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
