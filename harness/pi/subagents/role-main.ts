/**
 * Pure, dependency-free helpers for the `/<role>-main` in-session modes (dual-mode slice 4).
 *
 * `/<role>-main on` runs the MAIN session UNDER a role's methodology: the body of
 * harness/prompts/<role>.md is injected (body-only — AGENTS.md is already in the base prompt) and the
 * tool surface is CLAMPED to the role's allowed set, with a tool_call block-gate enforcing it.
 *
 * Only the four IN-SESSION roles live here — plan/verify/triage/report. monitor/research are "4b": their
 * real tools (run_experiment, web) are subprocess-only, so their `-main` commands spawn the isolated
 * sub-agent instead (handled in index.ts), not an in-session clamp.
 *
 * This module imports NOTHING (no pi types, no `.js` specifiers) so bare `node --test` can import it
 * directly — the gate predicate is the load-bearing bit and must be offline-tested (like userturns.ts).
 */

export type RoleMain = "plan" | "verify" | "triage" | "report";

export const ROLE_MAIN: readonly RoleMain[] = ["plan", "verify", "triage", "report"];

/**
 * The tool clamp per in-session role. plan/report AUTHOR memory/ artifacts (so `write`); verify/triage
 * REVIEW read-only. Intentional (F3): `write` is fine because the -main artifacts live under memory/,
 * which AGENTS.md treats as writable — the clamp only NARROWS the default read,bash,edit,write session.
 *
 * NOTE on `run_check`: it is a SUB-AGENT-only tool (registered by runner.ts via `-e`), NOT registered in
 * the main session — so pi's setActiveToolsByName silently DROPS it (it keeps only registered names).
 * In the main session verify/triage-main are therefore effectively read,grep,find,ls; the real
 * allowlisted checks run via the `/verify` or `/checks` COMMANDS (isolated). `run_check` is listed so the
 * clamp + gate already permit it the day it becomes a main-session tool — harmless until then.
 */
export const ROLE_MAIN_TOOLS: Record<RoleMain, readonly string[]> = {
	plan: ["read", "grep", "find", "ls", "write"],
	report: ["read", "grep", "find", "ls", "write"],
	verify: ["read", "grep", "find", "ls", "run_check"],
	triage: ["read", "grep", "find", "ls", "run_check"],
};

/** role -> the canonical methodology prompt file under harness/prompts/ (verify uses verify-change.md). */
export const ROLE_MAIN_PROMPT: Record<RoleMain, string> = {
	plan: "plan.md",
	verify: "verify-change.md",
	triage: "triage.md",
	report: "report.md",
};

export function isRoleMain(s: string): s is RoleMain {
	return (ROLE_MAIN as readonly string[]).includes(s);
}

/**
 * The tool_call gate predicate (LOAD-BEARING — the setActiveTools clamp only narrows what the model
 * SEES; this BLOCKS a call that slips through). While a role is active, any tool NOT in that role's
 * allowed set is blocked — including the six `subagent_*` role tools (a role shouldn't spawn sub-agents
 * while it IS the role). Null role → nothing blocked (normal session). Pure → offline-tested.
 */
export function isToolBlockedInRoleMain(role: RoleMain | null, toolName: string): boolean {
	if (!role) return false;
	return !ROLE_MAIN_TOOLS[role].includes(toolName);
}

/** Parse the `/<role>-main on|off` argument. Anything else (incl. empty) → null = show status/usage. */
export function parseOnOff(args: string): "on" | "off" | null {
	const a = args.trim().toLowerCase();
	if (a === "on") return "on";
	if (a === "off") return "off";
	return null;
}
