/**
 * Gate-config drift guard (dual-mode slice 3). Offline. The auto-judge gate is EXACT-MATCH
 * (`Array.includes` on the tool name, auto-judge/index.ts) — a typo or rename silently un-gates a
 * model-driven spawn. So the set of `subagent_*` tools REGISTERED in index.ts must equal the set
 * GUARDED in harness/checks.json's autoJudge.guardedTools (and the shipped example), and contextDiff
 * must stay false for the role tools' cost reasons (plan §B / N8). This test pins all three.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const HERE = import.meta.dirname ?? __dirname;
const REPO = path.resolve(HERE, "..", "..", ".."); // harness/pi/subagents -> repo root
const INDEX = path.join(HERE, "index.ts");
const CHECKS = path.join(REPO, "harness", "checks.json");
const EXAMPLE = path.join(REPO, "harness", "examples", "checks.python-lmcache.json");

// The six role tools, derived from the `name: "subagent_*"` fields actually registered in index.ts
// (not hardcoded — so a rename on one side without the other is caught).
function registeredRoleTools(): string[] {
	const src = fs.readFileSync(INDEX, "utf-8");
	const names = new Set<string>();
	for (const m of src.matchAll(/name:\s*"(subagent_[a-z]+)"/g)) names.add(m[1]);
	return [...names].sort();
}

function guardedTools(file: string): string[] {
	const cfg = JSON.parse(fs.readFileSync(file, "utf-8")) as { autoJudge?: { guardedTools?: string[] } };
	return cfg.autoJudge?.guardedTools ?? [];
}

test("gate-config: index.ts registers exactly the six namespaced role tools", () => {
	assert.deepEqual(registeredRoleTools(), [
		"subagent_monitor",
		"subagent_plan",
		"subagent_report",
		"subagent_research",
		"subagent_triage",
		"subagent_verify",
	]);
});

test("gate-config: every registered subagent_* tool is guarded in harness/checks.json (exact match)", () => {
	const guarded = new Set(guardedTools(CHECKS));
	for (const name of registeredRoleTools()) {
		assert.ok(guarded.has(name), `auto-judge guardedTools is missing ${name} — a model-driven spawn would be un-gated`);
	}
});

test("gate-config: the shipped example checks.json guards the same role tools", () => {
	const guarded = new Set(guardedTools(EXAMPLE));
	for (const name of registeredRoleTools()) {
		assert.ok(guarded.has(name), `example guardedTools is missing ${name}`);
	}
});

test("gate-config: contextDiff stays false for the role tools (cost, plan N8)", () => {
	const cfg = JSON.parse(fs.readFileSync(CHECKS, "utf-8")) as { autoJudge?: { contextDiff?: boolean } };
	assert.equal(cfg.autoJudge?.contextDiff, false);
});
