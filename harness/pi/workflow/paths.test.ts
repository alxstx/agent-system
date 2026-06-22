/**
 * Unit tests for workflow/paths (slice 2). Pure + offline.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify, validateWorkflowPath, workerFileName } from "./paths.ts";

test("slugify: lowercase, non-alnum→-, trimmed, capped at 60", () => {
	assert.equal(slugify("Trace the Request Path!"), "trace-the-request-path");
	assert.equal(slugify("  --weird__name--  "), "weird-name");
	assert.equal(slugify("x".repeat(80)).length, 60);
	assert.equal(slugify("!!!"), "");
});

test("workerFileName: `<i>-<slug>.md`, with <i> guaranteeing uniqueness when slugs collide", () => {
	assert.equal(workerFileName(0, "Investigate auth"), "0-investigate-auth.md");
	// two long tasks sharing the truncated slug stay distinct via <i>.
	const a = workerFileName(0, "x".repeat(80));
	const b = workerFileName(1, "x".repeat(80));
	assert.notEqual(a, b);
	assert.equal(a, `0-${"x".repeat(60)}.md`);
});

test("workerFileName: empty slug → falls back to 'task' (never `<i>-.md`)", () => {
	assert.equal(workerFileName(2, "!!!"), "2-task.md");
});

test("validateWorkflowPath: accepts under memory/workflow/, rejects traversal + escapes", () => {
	const repo = "/repo";
	assert.deepEqual(validateWorkflowPath(repo, "memory/workflow/run-1/0-task.md"), { ok: true, abs: "/repo/memory/workflow/run-1/0-task.md" });
	assert.equal(validateWorkflowPath(repo, "memory/workflow/../runs/x.log").ok, false); // '..'
	assert.equal(validateWorkflowPath(repo, "memory/runs/x.log").ok, false); // sibling dir, not workflow
	assert.equal(validateWorkflowPath(repo, "../etc/passwd").ok, false);
});
