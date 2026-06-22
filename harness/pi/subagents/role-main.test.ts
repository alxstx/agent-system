/**
 * Unit tests for subagents/role-main (dual-mode slice 4). Pure + offline (bare `node --test`): the
 * load-bearing tool_call gate predicate (the clamp only narrows what the model SEES; this BLOCKS), plus
 * the role tables, the role type guard, and the on|off parser. The stateful command/hook wiring needs a
 * live pi (a live-pi FLAG), not unit-tested here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isRoleMain,
	isToolBlockedInRoleMain,
	parseOnOff,
	ROLE_MAIN,
	ROLE_MAIN_PROMPT,
	ROLE_MAIN_TOOLS,
} from "./role-main.ts";

// --- the in-session role set ---

test("ROLE_MAIN is exactly the four in-session roles (monitor/research are 4b, not here)", () => {
	assert.deepEqual([...ROLE_MAIN], ["plan", "verify", "triage", "report"]);
});

test("ROLE_MAIN_TOOLS: plan/report can write; verify/triage are read-only + run_check; none has edit/bash", () => {
	assert.deepEqual([...ROLE_MAIN_TOOLS.plan], ["read", "grep", "find", "ls", "write"]);
	assert.deepEqual([...ROLE_MAIN_TOOLS.report], ["read", "grep", "find", "ls", "write"]);
	assert.deepEqual([...ROLE_MAIN_TOOLS.verify], ["read", "grep", "find", "ls", "run_check"]);
	assert.deepEqual([...ROLE_MAIN_TOOLS.triage], ["read", "grep", "find", "ls", "run_check"]);
	for (const role of ROLE_MAIN) {
		assert.ok(!ROLE_MAIN_TOOLS[role].includes("edit"), `${role} must not allow edit`);
		assert.ok(!ROLE_MAIN_TOOLS[role].includes("bash"), `${role} must not allow bash`);
	}
});

test("ROLE_MAIN_PROMPT maps verify -> verify-change.md, the rest -> <role>.md", () => {
	assert.equal(ROLE_MAIN_PROMPT.verify, "verify-change.md");
	assert.equal(ROLE_MAIN_PROMPT.plan, "plan.md");
	assert.equal(ROLE_MAIN_PROMPT.triage, "triage.md");
	assert.equal(ROLE_MAIN_PROMPT.report, "report.md");
});

// --- the gate predicate (load-bearing) ---

test("isToolBlockedInRoleMain: null role blocks NOTHING (normal session)", () => {
	for (const t of ["bash", "edit", "write", "read", "subagent_verify", "anything"]) {
		assert.equal(isToolBlockedInRoleMain(null, t), false);
	}
});

test("isToolBlockedInRoleMain: in-role tools allowed, off-role tools blocked", () => {
	// plan-main: write allowed, edit/bash blocked
	assert.equal(isToolBlockedInRoleMain("plan", "write"), false);
	assert.equal(isToolBlockedInRoleMain("plan", "read"), false);
	assert.equal(isToolBlockedInRoleMain("plan", "edit"), true);
	assert.equal(isToolBlockedInRoleMain("plan", "bash"), true);
	// verify-main: run_check allowed, write blocked (verify never writes source/artifacts itself)
	assert.equal(isToolBlockedInRoleMain("verify", "run_check"), false);
	assert.equal(isToolBlockedInRoleMain("verify", "write"), true);
	assert.equal(isToolBlockedInRoleMain("triage", "bash"), true);
});

test("isToolBlockedInRoleMain: the six subagent_* role tools are blocked in every in-session role", () => {
	const roleTools = [
		"subagent_plan",
		"subagent_verify",
		"subagent_triage",
		"subagent_monitor",
		"subagent_report",
		"subagent_research",
	];
	for (const role of ROLE_MAIN) {
		for (const t of roleTools) {
			assert.equal(isToolBlockedInRoleMain(role, t), true, `${t} must be blocked in ${role}-main`);
		}
	}
});

// --- helpers ---

test("isRoleMain: true only for the four roles", () => {
	for (const r of ROLE_MAIN) assert.equal(isRoleMain(r), true);
	for (const s of ["monitor", "research", "", "PLAN", "verify-change", "delegate"]) assert.equal(isRoleMain(s), false);
});

test("parseOnOff: on/off (case-insensitive, trimmed); anything else -> null", () => {
	assert.equal(parseOnOff("on"), "on");
	assert.equal(parseOnOff("  ON "), "on");
	assert.equal(parseOnOff("off"), "off");
	assert.equal(parseOnOff("Off"), "off");
	assert.equal(parseOnOff(""), null);
	assert.equal(parseOnOff("status"), null);
	assert.equal(parseOnOff("on off"), null);
});
