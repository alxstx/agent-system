/**
 * workflow/paths — PURE, OFFLINE filename + path helpers for the fan-out result files
 * (memory/plan-workflow.md, slice 2). Worker results land at memory/workflow/<runId>/<i>-<slug>.md.
 * The zero-based `<i>` is LOAD-BEARING for uniqueness: `slugify` truncates to 60 chars, so two long
 * tasks can share a `<slug>`, and the task dedupe is exact-string-only — `<i>` keeps the filenames
 * distinct regardless. `validateWorkflowPath` confines writes under memory/workflow/ (a sibling of
 * checks-core's validateLogFile, which hardcodes memory/runs/ and would reject these paths). node:path
 * only → bare-node unit-testable.
 */

import * as path from "node:path";

// Operator/model text → a safe, stable file slug (mirrors subagents' slugify: lowercase, non-alnum→-,
// trim dashes, cap 60). Inlined (node:path-only) so this module stays standalone + testable.
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

// Per-worker result filename: `<i>-<slug>.md`. `<i>` (zero-based position in the clamped kept-list) is
// the uniqueness guarantee; a blank slug falls back to "task" so the name is never just `<i>-.md`.
export function workerFileName(index: number, task: string): string {
	return `${index}-${slugify(task) || "task"}.md`;
}

// Confine a workflow result path under <repoRoot>/memory/workflow/ (no traversal). All components are
// internally generated (runId + index + sanitized slug), so this is defense-in-depth, not the only guard.
export function validateWorkflowPath(
	repoRoot: string,
	rel: string,
): { ok: true; abs: string } | { ok: false; reason: string } {
	if (rel.includes("..")) return { ok: false, reason: "'..' is not allowed in the workflow path" };
	const abs = path.resolve(repoRoot, rel);
	const root = path.resolve(repoRoot, "memory", "workflow");
	if (abs !== root && !abs.startsWith(root + path.sep)) {
		return { ok: false, reason: "workflow path must stay within memory/workflow/" };
	}
	return { ok: true, abs };
}
