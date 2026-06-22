/**
 * Unit tests for shared/subagent-core (delegate slice 1). Pure + offline, in the verdict.test.ts
 * style (bare `node --test`, Node ≥ 22.19, .ts specifiers): extractSummary's SUMMARY grammar, the
 * metadata-only cleanDetails filter, and redactOnWrite's redact-then-byte-cap-then-write contract
 * (the R3-BLOCKER guard — a worker result must be scrubbed at the source before any fs write).
 * The subprocess plumbing (runSubagent / the shutdown guard) needs a live pi and is a slice-4 FLAG,
 * not unit-tested here.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { cleanDetails, extractSummary, redactOnWrite } from "./subagent-core.ts";

// --- extractSummary -----------------------------------------------------------------------------

test("extractSummary: returns the lines after a ## SUMMARY heading", () => {
	const text = "preamble\nnoise\n## SUMMARY\nGoal line\n1. first\n2. second";
	assert.equal(extractSummary(text, 10), "Goal line\n1. first\n2. second");
});

test("extractSummary: caps at maxLines", () => {
	const text = "## SUMMARY\na\nb\nc\nd\ne";
	assert.equal(extractSummary(text, 3), "a\nb\nc");
});

test("extractSummary: uses the LAST SUMMARY block when several appear", () => {
	const text = "## SUMMARY\nold one\n---\n## SUMMARY\nnew one";
	assert.equal(extractSummary(text, 10), "new one");
});

test("extractSummary: tolerates leading whitespace + 1–6 # and trailing text on the heading", () => {
	const text = "   ### SUMMARY (final)\nPASS\nlooks good";
	assert.equal(extractSummary(text, 10), "PASS\nlooks good");
});

test("extractSummary: no SUMMARY heading → falls back to first non-empty lines", () => {
	const text = "\n\nfirst real line\nsecond line";
	assert.equal(extractSummary(text, 10), "first real line\nsecond line");
});

test("extractSummary: trims leading + trailing blank lines around the body", () => {
	const text = "## SUMMARY\n\n\nkept line\n\n\n";
	assert.equal(extractSummary(text, 10), "kept line");
});

test("extractSummary: empty / whitespace-only → placeholder", () => {
	assert.equal(extractSummary("", 10), "(subagent produced no summary)");
	assert.equal(extractSummary("## SUMMARY\n   \n  ", 10), "(subagent produced no summary)");
});

// --- cleanDetails (metadata-only `details` channel) ---------------------------------------------

test("cleanDetails: keeps primitive (string/number/boolean) fields", () => {
	assert.deepEqual(cleanDetails({ mode: "json", turns: 3, ok: true, model: "github-copilot/claude-opus-4.8" }), {
		mode: "json",
		turns: 3,
		ok: true,
		model: "github-copilot/claude-opus-4.8",
	});
});

test("cleanDetails: drops objects/arrays/null/undefined (no worker-text blob can ride through)", () => {
	const dropped = cleanDetails({
		turns: 1,
		nested: { secret: "x" },
		list: ["a", "b"],
		nothing: null,
		missing: undefined,
		fn: () => 1,
	});
	assert.deepEqual(dropped, { turns: 1 });
});

// --- redactOnWrite (redact-at-source before fs write — R3-BLOCKER) -------------------------------

function mkTmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "subagent-core-"));
}

test("redactOnWrite: redacts BEFORE writing + appends a trailing newline", () => {
	const tmp = mkTmp();
	try {
		const file = path.join(tmp, "out.md");
		const redact = (s: string) => s.replace(/SECRET/g, "[X]");
		redactOnWrite(redact, file, "token=SECRET in body");
		assert.equal(fs.readFileSync(file, "utf-8"), "token=[X] in body\n");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("redactOnWrite: does not double a newline already present", () => {
	const tmp = mkTmp();
	try {
		const file = path.join(tmp, "out.md");
		redactOnWrite((s) => s, file, "line\n");
		assert.equal(fs.readFileSync(file, "utf-8"), "line\n");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("redactOnWrite: byte-caps the (redacted) content, honoring the limit in bytes", () => {
	const tmp = mkTmp();
	try {
		const file = path.join(tmp, "big.md");
		redactOnWrite((s) => s, file, "a".repeat(100), 50);
		const written = fs.readFileSync(file, "utf-8");
		assert.ok(written.startsWith("a".repeat(50)), "keeps the first 50 bytes");
		assert.ok(!written.includes("a".repeat(51)), "drops everything past the cap");
		assert.match(written, /\[truncated at 50 bytes\]\n$/);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("redactOnWrite: redacts BEFORE the byte-cap (R3-BLOCKER ordering — a secret at the cut can't leak)", () => {
	const tmp = mkTmp();
	try {
		const file = path.join(tmp, "boundary.md");
		const redact = (s: string) => s.replace(/TOPSECRET/g, "[X]");
		// The secret straddles the byte cut (byte 53 lands inside "TOPSECRET" at offset 47). The CORRECT
		// order (redact → cap) replaces the whole token before slicing, so nothing leaks. A buggy
		// cap-then-redact impl would slice "TOPSEC" off the end first; the redactor never matches the
		// severed fragment, and a partial secret survives past the cut. This test FAILS such a swap.
		redactOnWrite(redact, file, `${"a".repeat(47)}TOPSECRET rest`, 53);
		const written = fs.readFileSync(file, "utf-8");
		assert.ok(!written.includes("TOPSEC"), "no secret fragment survives a mid-token cut");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("redactOnWrite: content at/under the cap is written whole (no truncation marker)", () => {
	const tmp = mkTmp();
	try {
		const file = path.join(tmp, "small.md");
		redactOnWrite((s) => s, file, "short", 50);
		assert.equal(fs.readFileSync(file, "utf-8"), "short\n");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("redactOnWrite: ORDER — redaction runs BEFORE the write, so a throwing redactor leaves NO file", () => {
	// Pins the security ordering (R3-BLOCKER), not just the result: a write-then-redact impl would have
	// already put the RAW text on disk before the redactor threw. redact-then-write never touches disk.
	const tmp = mkTmp();
	try {
		const file = path.join(tmp, "leak.md");
		assert.throws(() =>
			redactOnWrite(
				() => {
					throw new Error("redactor failed");
				},
				file,
				"secret here",
			),
		);
		assert.ok(!fs.existsSync(file), "no file may exist if redaction throws before the write");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
