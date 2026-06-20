/**
 * Unit tests for subagents/userturns (dual-mode slice 1). Pure + offline, in the verdict.test.ts
 * style (bare `node --test`, Node ≥ 22.19, .ts specifiers): the slug helper, the per-role handoff
 * contracts, and the per-role first-user-turn assembly that BOTH command-mode and tool-mode share.
 * The spawn plumbing (runSubagent / runXRole) needs a live pi and is a live-pi FLAG, not unit-tested.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildMonitorUserTurn,
	buildPlanUserTurn,
	buildReportUserTurn,
	buildResearchUserTurn,
	buildTriageUserTurn,
	buildVerifyUserTurn,
	handoffMonitor,
	handoffPlan,
	slugify,
} from "./userturns.ts";

// --- slugify ------------------------------------------------------------------------------------

test("slugify: lowercases, collapses non-alnum to single dashes, trims edge dashes", () => {
	assert.equal(slugify("Health Endpoint!"), "health-endpoint");
	assert.equal(slugify("  --Foo__Bar--  "), "foo-bar");
	assert.equal(slugify("a/b.c"), "a-b-c");
});

test("slugify: caps at 60 chars", () => {
	assert.equal(slugify("x".repeat(100)).length, 60);
});

test("slugify: all-punctuation collapses to empty (caller treats as invalid)", () => {
	assert.equal(slugify("---"), "");
	assert.equal(slugify("   "), "");
});

// --- handoff contracts --------------------------------------------------------------------------

test("handoffPlan: NEW feature instructs a fresh plan, names both output files + the SUMMARY rule", () => {
	const h = handoffPlan("/repo/memory/plan-feat.md", "/repo/memory/tasks.md", true);
	assert.match(h, /NEW feature/);
	assert.match(h, /\/repo\/memory\/plan-feat\.md/);
	assert.match(h, /\/repo\/memory\/tasks\.md/);
	assert.match(h, /your final message must be a line exactly `## SUMMARY`/);
});

test("handoffPlan: SAME feature instructs UPDATE/EXTEND in place", () => {
	const h = handoffPlan("/repo/memory/plan-feat.md", "/repo/memory/tasks.md", false);
	assert.match(h, /ALREADY exists/);
	assert.match(h, /UPDATE\/EXTEND it in place/);
});

test("handoffMonitor: pins the exact run_experiment call (experiment + runId verbatim) + the log path", () => {
	const h = handoffMonitor("/repo/memory/monitor-r.md", "smoke", "smoke-20260620-0", "memory/runs/smoke-20260620-0.log");
	assert.match(h, /run_experiment\(\{ experiment: "smoke", runId: "smoke-20260620-0" \}\)/);
	assert.match(h, /memory\/runs\/smoke-20260620-0\.log/);
	assert.match(h, /FIRST token is OK or ERROR/);
});

// --- buildPlanUserTurn --------------------------------------------------------------------------

test("buildPlanUserTurn: new feature → 'NEW feature' marker, NOT the existing-plan block", () => {
	const t = buildPlanUserTurn({
		memory: "MEM",
		slug: "feat",
		isNewFeature: true,
		existingPlan: "",
		prevTasks: "PREV",
		task: "do the thing",
		planPath: "/repo/memory/plan-feat.md",
		tasksPath: "/repo/memory/tasks.md",
	});
	assert.match(t, /# Current memory index \(memory\/MEMORY\.md\)\n\nMEM/);
	assert.match(t, /this is a NEW feature/);
	assert.doesNotMatch(t, /UPDATE\/EXTEND this/);
	assert.match(t, /# TASK TO PLAN \(the next slice to work on\)\n\ndo the thing/);
	assert.match(t, /HARNESS HANDOFF/); // handoff appended
});

test("buildPlanUserTurn: existing feature → injects the existing plan under UPDATE/EXTEND", () => {
	const t = buildPlanUserTurn({
		memory: "MEM",
		slug: "feat",
		isNewFeature: false,
		existingPlan: "OLD PLAN BODY",
		prevTasks: "PREV",
		task: "next",
		planPath: "/repo/memory/plan-feat.md",
		tasksPath: "/repo/memory/tasks.md",
	});
	assert.match(t, /UPDATE\/EXTEND this/);
	assert.match(t, /OLD PLAN BODY/);
});

// --- buildVerifyUserTurn ------------------------------------------------------------------------

test("buildVerifyUserTurn: with overall plan → includes the plan section + the diff fence + note", () => {
	const t = buildVerifyUserTurn({
		memory: "MEM",
		hasOverallPlan: true,
		slug: "feat",
		overallPlan: "PLAN BODY",
		tasks: "TASKS",
		diffLabel: "git diff main",
		diff: "DIFFTEXT",
		note: "look at edge cases",
		verdictPath: "/repo/memory/verdict.md",
		verifyChecks: "test, lint, git-diff",
	});
	assert.match(t, /# Overall plan for this feature \(memory\/plan-feat\.md\)\n\nPLAN BODY/);
	assert.match(t, /# Change under review \(git diff main\)\n\n```diff\n\nDIFFTEXT\n\n```/);
	assert.match(t, /# Reviewer note from operator\n\nlook at edge cases/);
	assert.match(t, /Allowed checks ONLY: test, lint, git-diff\./);
});

test("buildVerifyUserTurn: no overall plan → omits the plan section; no note → omits note block", () => {
	const t = buildVerifyUserTurn({
		memory: "MEM",
		hasOverallPlan: false,
		tasks: "TASKS",
		diffLabel: "git diff main",
		diff: "DIFFTEXT",
		note: "",
		verdictPath: "/repo/memory/verdict.md",
		verifyChecks: "test",
	});
	assert.doesNotMatch(t, /# Overall plan for this feature/);
	assert.doesNotMatch(t, /# Reviewer note from operator/);
	assert.match(t, /# Current task slice \/ done-condition \(memory\/tasks\.md\)\n\nTASKS/);
});

// --- buildTriageUserTurn ------------------------------------------------------------------------

test("buildTriageUserTurn: with log → includes the failing-log fence; with note → includes operator note", () => {
	const t = buildTriageUserTurn({
		memory: "MEM",
		slug: "boom",
		logText: "Traceback...",
		logLabel: "memory/runs/x.log",
		note: "started after the refactor",
		triagePath: "/repo/memory/triage-boom.md",
		verifyChecks: "git-blame, env-dump",
	});
	assert.match(t, /# Failing log \(memory\/runs\/x\.log\)\n\n```\n\nTraceback\.\.\.\n\n```/);
	assert.match(t, /# Operator note\n\nstarted after the refactor/);
});

test("buildTriageUserTurn: no log → omits the log fence", () => {
	const t = buildTriageUserTurn({
		memory: "MEM",
		slug: "boom",
		logText: "",
		logLabel: "",
		note: "just a hint",
		triagePath: "/repo/memory/triage-boom.md",
		verifyChecks: "git-blame",
	});
	assert.doesNotMatch(t, /# Failing log/);
	assert.match(t, /# Operator note\n\njust a hint/);
});

// --- buildMonitorUserTurn -----------------------------------------------------------------------

test("buildMonitorUserTurn: renders the fixed command + timeout seconds + the verbatim run id", () => {
	const t = buildMonitorUserTurn({
		memory: "MEM",
		expName: "smoke",
		exp: { cmd: "python", args: ["bench/run.py", "--smoke"], timeoutMs: 1800000 },
		run: "smoke-20260620-0",
		logRel: "memory/runs/smoke-20260620-0.log",
		note: "",
		reportPath: "/repo/memory/monitor-smoke-20260620-0.md",
	});
	assert.match(t, /# Experiment to run: smoke/);
	assert.match(t, /```\n\npython bench\/run\.py --smoke\n\n```/);
	assert.match(t, /timeout 1800s/);
	assert.match(t, /# Run id \(pass this verbatim as run_experiment's runId\): smoke-20260620-0/);
});

// --- buildReportUserTurn ------------------------------------------------------------------------

test("buildReportUserTurn: includes audience, each source block, the diff fence and the commit-log fence", () => {
	const t = buildReportUserTurn({
		memory: "MEM",
		slug: "results",
		audience: "paper",
		sources: [
			{ label: "memory/verdict.md", content: "VERDICT" },
			{ label: "memory/tasks.md", content: "TASKS" },
		],
		diffLabel: "git diff main",
		diff: "DIFF",
		logLabel: "git log main..HEAD",
		gitlog: "abc commit",
		reportPath: "/repo/memory/reports/results-2026-06-20.md",
	});
	assert.match(t, /# Report subject: results {2}\(audience: paper\)/);
	assert.match(t, /# Source: memory\/verdict\.md\n\nVERDICT/);
	assert.match(t, /# Source: memory\/tasks\.md\n\nTASKS/);
	assert.match(t, /# Change under review \(git diff main\)\n\n```diff\n\nDIFF\n\n```/);
	assert.match(t, /# Recent commits \(git log main\.\.HEAD\)\n\n```\n\nabc commit\n\n```/);
	assert.match(t, /Audience: paper\./); // from handoffReport
});

// --- buildResearchUserTurn ----------------------------------------------------------------------

test("buildResearchUserTurn: includes the topic, the question, and the research handoff", () => {
	const t = buildResearchUserTurn({
		memory: "MEM",
		slug: "zod",
		question: "is zod smaller than valibot?",
		researchPath: "/repo/memory/research-zod.md",
	});
	assert.match(t, /# Research topic: zod/);
	assert.match(t, /# QUESTION TO RESEARCH\n\nis zod smaller than valibot\?/);
	assert.match(t, /web_search \+ fetch_content/); // from handoffResearch
});
