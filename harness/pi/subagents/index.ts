/**
 * Planner -> Implement -> Verify subagents for the token-minimizing harness — DUAL-MODE.
 *
 * Each of the six roles (/plan /verify /triage /monitor /report /research) is reachable two ways
 * (memory/plan-subagent-dual-mode.md):
 *   1. Command-mode (unchanged): the operator types `/<role> …`. Posts a <=10-line SUMMARY back to
 *      the main session via deliverAs:"nextTurn".
 *   2. Tool-mode (NEW — the reported bug fix): the running model invokes the role as an isolated
 *      sub-agent MID-TURN via a namespaced `subagent_<role>` tool and sees the summary in-context.
 *
 * Both modes funnel through ONE shared `runXRole(input, rctx)` per role: it owns findRepoRoot +
 * validation + the first-user-turn build (the pure builders live in ./userturns.ts) + runSubagent +
 * the fileSig "did it write its own file?" fallback + SUMMARY extraction. Command-mode and tool-mode
 * differ ONLY at the seam:
 *   - command-mode passes NO signal and NO wall-clock timeout (the six roles' original behavior,
 *     byte-for-byte), then maps the outcome to ctx.ui.notify + pi.sendMessage(nextTurn).
 *   - tool-mode passes ctx.signal + a wall-clock timeout, then RETURNS the <=10-line summary as the
 *     tool result `content` (artifact stays on disk). On failure it THROWS a controlled, redaction-safe
 *     Error — a returned isError:true is inert (agent-loop hardcodes isError:false on the no-throw
 *     path); only a thrown error marks the result failed and surfaces the reason to the model.
 *
 * Isolation + tool restriction (unchanged safety core): each sub-agent is a SEPARATE `pi` subprocess
 * (--mode json -p --no-session -nc --no-skills --no-prompt-templates --no-themes --no-extensions) with
 * an explicit --tools allowlist; execution funnels through run_check/run_experiment (runner.ts);
 * /monitor /research logs are redacted at the source (runFixedTee). The subprocess loads NO ambient
 * config, so it can't re-enter this extension (no recursion). The shared subprocess plumbing,
 * allowlists, and redaction live in ../shared/subagent-core.ts + runner.ts and are reused UNCHANGED.
 *
 * Tool-spawned children run DURING streaming, so the factory arms registerShutdownGuard(pi): the
 * module-level live-children Set + a session_shutdown SIGTERM→SIGKILL ladder reclaim them on
 * /reload|quit (ctx.signal covers operator-abort only, not shutdown).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GIT_CHECKS, READONLY_PROBES } from "../shared/checks-core.js";
import {
	cleanDetails,
	extractSummary,
	MODEL_DEFAULT,
	MODEL_REVIEW,
	registerShutdownGuard,
	runSubagent,
	type RunSubagentOptions,
	type SubagentResult,
	subagentFailed,
} from "../shared/subagent-core.js";
import {
	buildMonitorUserTurn,
	buildPlanUserTurn,
	buildReportUserTurn,
	buildResearchUserTurn,
	buildTriageUserTurn,
	buildVerifyUserTurn,
	slugify,
} from "./userturns.js";
import {
	isRoleMain,
	isToolBlockedInRoleMain,
	parseOnOff,
	ROLE_MAIN,
	ROLE_MAIN_PROMPT,
	ROLE_MAIN_TOOLS,
	type RoleMain,
} from "./role-main.js";

const RUNNER_PATH = path.join(import.meta.dirname ?? __dirname, "runner.ts");

const MAX_DIFF_BYTES = 150 * 1024;

// Tool-mode wall-clock timeout (command-mode keeps the original "no artificial timeout" behavior).
// Generous so legitimate repo exploration isn't cut short; bounds a runaway model-driven spawn.
const ROLE_TOOL_TIMEOUT_MS = 15 * 60 * 1000; // 900_000
// /monitor's tool-mode timeout must outlast the experiment it launches (run_experiment has its own
// per-experiment timeoutMs); add a buffer so the sub-agent can still write its report afterwards.
const MONITOR_TOOL_BUFFER_MS = 3 * 60 * 1000;

// Per-role model & thinking policy (MODEL_DEFAULT / MODEL_REVIEW / EFFORT) lives in
// ../shared/subagent-core.ts now, shared with delegate/workflow/auto-judge so the ids can never
// drift across call sites. Passed to runSubagent per role (see the role map in the README).

// Module-scope monotonic counter for collision-resistant /monitor run ids (a ms timestamp can
// still collide within the same millisecond; the counter disambiguates).
let monitorSeq = 0;

// ---------------------------------------------------------------------------
// /<role>-main state (dual-mode slice 4). Single-slot: at most ONE in-session role is active.
// Module-scope so it survives within a session; RESET to null when the module is re-instantiated on
// /reload — which is exactly why it's persisted via pi.appendEntry and restored on session_start (N2).
// ---------------------------------------------------------------------------
const ROLE_MAIN_ENTRY = "subagent-role-main"; // appendEntry customType for persist/restore
// Best-effort full set restored ONLY in the defensive path (no recorded snapshot but a clamp appears to
// have leaked). The real restore uses the snapshot captured on `on` (preserving sibling extension tools).
const ROLE_MAIN_FALLBACK_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"subagent_plan",
	"subagent_verify",
	"subagent_triage",
	"subagent_monitor",
	"subagent_report",
	"subagent_research",
];
let activeRoleMain: RoleMain | null = null;
let savedMainTools: string[] | null = null; // the pre-clamp tool set, captured on `on`

// /research web tools: pi-web-access, loaded into the sub-agent via -e (explicit -e still loads
// under --no-extensions). It exposes web_search + fetch_content. Operator prerequisite:
// `pi install npm:pi-web-access`. Verified: `-e npm:pi-web-access` resolves + registers the tools
// under the full subagent flag set; only an actual web_search call needs live auth/network.
const WEB_TOOLS_SOURCE = "npm:pi-web-access";

// Build the human-readable list of checks a runner-backed sub-agent is allowed to run, derived
// from <repoRoot>/harness/checks.json (project-specific checks + test-file) plus the universal git
// checks and the read-only /triage probes. GIT_CHECKS/READONLY_PROBES are imported from the shared
// core (runner.ts enforces the same set), so the prompt and the tool can never diverge.
function listVerifyChecks(repoRoot: string): string {
	const names: string[] = [];
	try {
		const raw = fs.readFileSync(path.join(repoRoot, "harness", "checks.json"), "utf-8");
		const cfg = JSON.parse(raw) as { checks?: Record<string, unknown>; testFile?: unknown };
		if (cfg.checks) names.push(...Object.keys(cfg.checks));
		if (cfg.testFile) names.push("test-file");
	} catch {
		/* no config: only git checks + probes are available */
	}
	names.push(...GIT_CHECKS, ...READONLY_PROBES);
	return names.join(", ");
}

interface ExperimentEntry {
	cmd: string;
	args: string[];
	timeoutMs: number;
}

// Read the closed allowlist of experiments the Monitor may launch (names only; the model never
// assembles a command). The runner enforces the same set via run_experiment's StringEnum.
function listExperiments(repoRoot: string): Record<string, ExperimentEntry> {
	try {
		const raw = fs.readFileSync(path.join(repoRoot, "harness", "checks.json"), "utf-8");
		const cfg = JSON.parse(raw) as { experiments?: Record<string, ExperimentEntry> };
		return cfg.experiments ?? {};
	} catch {
		return {};
	}
}

// Read a file capped to MAX_DIFF_BYTES (the same truncation idiom computeDiff uses), for
// injecting an operator-supplied log into a sub-agent's first turn.
function readCapped(p: string): string {
	let out = readIfExists(p) ?? "";
	if (Buffer.byteLength(out, "utf-8") > MAX_DIFF_BYTES) {
		out = `${out.slice(0, MAX_DIFF_BYTES)}\n\n[log truncated at ${MAX_DIFF_BYTES} bytes]`;
	}
	return out;
}

// mtime+size signature so the parent can tell whether the subagent wrote the file itself.
function fileSig(p: string): string | null {
	try {
		const st = fs.statSync(p);
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Repo discovery
// ---------------------------------------------------------------------------

interface RepoPaths {
	root: string;
	agents: string;
	memory: string;
	memoryDir: string;
	tasks: string;
	verdict: string;
	activePlanPointer: string;
	planPrompt: string;
	verifyPrompt: string;
}

function findRepoRoot(startCwd: string): RepoPaths | null {
	let dir = path.resolve(startCwd);
	while (true) {
		const planPrompt = path.join(dir, "harness", "prompts", "plan.md");
		const memory = path.join(dir, "memory", "MEMORY.md");
		if (fs.existsSync(planPrompt) && fs.existsSync(memory)) {
			return {
				root: dir,
				agents: path.join(dir, "AGENTS.md"),
				memory,
				memoryDir: path.join(dir, "memory"),
				tasks: path.join(dir, "memory", "tasks.md"),
				verdict: path.join(dir, "memory", "verdict.md"),
				activePlanPointer: path.join(dir, "memory", ".active-plan"),
				planPrompt,
				verifyPrompt: path.join(dir, "harness", "prompts", "verify-change.md"),
			};
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function readIfExists(p: string): string | undefined {
	try {
		return fs.readFileSync(p, "utf-8");
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Feature-scoped overall plan files: memory/plan-<feature>.md
// ---------------------------------------------------------------------------

function planFilePath(repo: RepoPaths, slug: string): string {
	return path.join(repo.memoryDir, `plan-${slug}.md`);
}

// Remember which feature the last /plan targeted, so /verify can find it.
function writeActivePlan(repo: RepoPaths, slug: string): void {
	try {
		fs.writeFileSync(repo.activePlanPointer, `${slug}\n`, "utf-8");
	} catch {
		/* best effort */
	}
}

function readActivePlan(repo: RepoPaths): string | undefined {
	const raw = readIfExists(repo.activePlanPointer)?.trim();
	return raw ? raw : undefined;
}

// List feature slugs that already have a memory/plan-<slug>.md file.
function listPlanSlugs(repo: RepoPaths): string[] {
	try {
		return fs
			.readdirSync(repo.memoryDir)
			.map((f) => /^plan-(.+)\.md$/.exec(f)?.[1])
			.filter((s): s is string => !!s);
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// git diff (parent computes it deterministically for the Verifier's user turn)
// ---------------------------------------------------------------------------

function computeDiff(repoRoot: string): { text: string; label: string } {
	const tryDiff = (base: string): string | null => {
		const r = spawnSync("git", ["diff", base], {
			cwd: repoRoot,
			encoding: "utf-8",
			maxBuffer: 64 * 1024 * 1024,
		});
		if (r.status === 0) return r.stdout ?? "";
		return null;
	};
	let label = "git diff main";
	let out = tryDiff("main");
	if (out === null) {
		label = "git diff HEAD~1";
		out = tryDiff("HEAD~1");
	}
	if (out === null) {
		return { text: "(unable to compute a diff: no 'main' or 'HEAD~1' base found)", label: "no base" };
	}
	if (!out.trim()) return { text: `(no changes vs ${label.replace("git diff ", "")})`, label };
	if (Buffer.byteLength(out, "utf-8") > MAX_DIFF_BYTES) {
		out = `${out.slice(0, MAX_DIFF_BYTES)}\n\n[diff truncated at ${MAX_DIFF_BYTES} bytes — re-run the git-diff check for the full diff]`;
	}
	return { text: out, label };
}

// Sibling of computeDiff for /report: the recent commit log (the report contract references both
// diff AND log, and no git-log helper existed). Same base resolution + truncation.
function computeGitLog(repoRoot: string): { text: string; label: string } {
	const tryLog = (base: string): string | null => {
		const r = spawnSync("git", ["log", "--oneline", "-40", `${base}..HEAD`], {
			cwd: repoRoot,
			encoding: "utf-8",
			maxBuffer: 64 * 1024 * 1024,
		});
		if (r.status === 0) return r.stdout ?? "";
		return null;
	};
	let label = "git log main..HEAD";
	let out = tryLog("main");
	if (out === null) {
		label = "git log HEAD~1..HEAD";
		out = tryLog("HEAD~1");
	}
	if (out === null) {
		return { text: "(unable to compute a git log: no 'main' or 'HEAD~1' base found)", label: "no base" };
	}
	if (!out.trim()) return { text: `(no commits vs ${label.replace("git log ", "").replace("..HEAD", "")})`, label };
	if (Buffer.byteLength(out, "utf-8") > MAX_DIFF_BYTES) {
		out = `${out.slice(0, MAX_DIFF_BYTES)}\n\n[log truncated at ${MAX_DIFF_BYTES} bytes]`;
	}
	return { text: out, label };
}

// Newest memory/monitor-*.md (by mtime), for /report's source auto-discovery.
function newestMonitorReport(memoryDir: string): string | undefined {
	try {
		const candidates = fs
			.readdirSync(memoryDir)
			.filter((f) => /^monitor-.+\.md$/.test(f))
			.map((f) => ({ f, m: fs.statSync(path.join(memoryDir, f)).mtimeMs }))
			.sort((a, b) => b.m - a.m);
		return candidates.length ? path.join(memoryDir, candidates[0].f) : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Shared role-run plumbing (the seam both command-mode and tool-mode call into)
// ---------------------------------------------------------------------------

type NotifyLevel = "info" | "warning" | "error";

interface RoleRunCtx {
	cwd: string;
	mode: "command" | "tool";
	/** Operator abort signal (tool-mode only — command-mode passes none, preserving original behavior). */
	signal?: AbortSignal;
	onProgress?: (turns: number, lastTool: string | undefined) => void;
}

interface InvalidOutcome {
	kind: "invalid";
	reason: string;
	level: NotifyLevel;
}
interface FailedOutcome {
	kind: "failed";
	res: SubagentResult;
	timedOut: boolean;
}
type RoleOutcome<TOk> = InvalidOutcome | FailedOutcome | ({ kind: "ok"; res: SubagentResult; summary: string } & TOk);

type PlanOutcome = RoleOutcome<{ slug: string; wrotePlan: boolean }>;
type VerifyOutcome = RoleOutcome<{ verdictWord: "PASS" | "FAIL" }>;
type TriageOutcome = RoleOutcome<{ slug: string; topLabel: string }>;
type MonitorOutcome = RoleOutcome<{ run: string; logRel: string; expName: string; verdictWord: "OK" | "ERROR" }>;
type ReportOutcome = RoleOutcome<{ slug: string; reportRel: string; audience: string }>;
type ResearchOutcome = RoleOutcome<{ slug: string; verdictWord: string }>;

function repoMissing(role: string): InvalidOutcome {
	return {
		kind: "invalid",
		level: "error",
		reason: `Not inside the harness repo (need harness/prompts/${role}.md + memory/MEMORY.md above cwd).`,
	};
}

// Run a role sub-agent. Command-mode reproduces the six roles' original call EXACTLY (no signal, no
// timeout). Tool-mode layers a wall-clock timeout combined with the operator abort signal: the
// combined signal triggers runSubagent's SIGTERM; the session_shutdown guard owns the SIGTERM→SIGKILL
// ladder for /reload|quit. Returns timedOut so a failure can be worded clearly.
async function runRoleSubagent(
	opts: RunSubagentOptions,
	toolTimeoutMs: number,
	rctx: RoleRunCtx,
): Promise<{ res: SubagentResult; timedOut: boolean }> {
	if (rctx.mode === "command") {
		const res = await runSubagent({ ...opts, onProgress: rctx.onProgress });
		return { res, timedOut: false };
	}
	const ac = new AbortController();
	let timedOut = false;
	const onParentAbort = () => ac.abort();
	const timer = setTimeout(() => {
		timedOut = true;
		ac.abort();
	}, toolTimeoutMs);
	timer.unref?.();
	const parent = rctx.signal;
	if (parent) {
		if (parent.aborted) ac.abort();
		else parent.addEventListener("abort", onParentAbort, { once: true });
	}
	try {
		const res = await runSubagent({ ...opts, signal: ac.signal, onProgress: rctx.onProgress });
		return { res, timedOut };
	} finally {
		clearTimeout(timer);
		parent?.removeEventListener("abort", onParentAbort);
	}
}

// Command-mode failure reason (verbatim from the original handlers — may include stderr; this text
// goes only to the operator's UI + the command's own nextTurn message, preserving prior behavior).
function failReasonVerbose(res: SubagentResult): string {
	return res.errorMessage || res.stopReason || res.stderr.trim() || "no output";
}

// Tool-mode failure reason: redaction-SAFE and short (never raw stderr — the thrown message becomes
// model-visible content). pi's structured errorMessage/stopReason are safe; stderr is not.
function failReason(res: SubagentResult, timedOut: boolean): string {
	if (timedOut) return "timed out";
	return res.errorMessage || res.stopReason || "no usable output";
}

// The fallback write: only when the sub-agent did NOT author its own file (mtime/size sig unchanged
// or empty). Mirrors the original per-role fallback exactly.
function fallbackWrite(p: string, sigBefore: string | null, finalText: string): void {
	const wroteItself = fileSig(p) !== sigBefore && (readIfExists(p)?.trim()?.length ?? 0) > 0;
	if (!wroteItself) {
		fs.writeFileSync(p, finalText.endsWith("\n") ? finalText : `${finalText}\n`, "utf-8");
	}
}

// ---------------------------------------------------------------------------
// Per-role runXRole (owns findRepoRoot + validation + run + fallback + SUMMARY)
// ---------------------------------------------------------------------------

async function runPlanRole(input: { feature: string; task: string }, rctx: RoleRunCtx): Promise<PlanOutcome> {
	const slug = slugify(input.feature);
	const task = input.task.trim();
	if (!slug || !task) {
		return {
			kind: "invalid",
			level: "warning",
			reason: "Usage: /plan <feature-name> <task description>  (e.g. /plan health-endpoint add a /health route)",
		};
	}
	const repo = findRepoRoot(rctx.cwd);
	if (!repo) return repoMissing("plan");

	const planPath = planFilePath(repo, slug);
	const existingPlan = readIfExists(planPath);
	const isNewFeature = !existingPlan || !existingPlan.trim();
	const memory = readIfExists(repo.memory) ?? "(memory/MEMORY.md missing)";
	const prevTasks = readIfExists(repo.tasks) ?? "(none yet)";
	const userTurn = buildPlanUserTurn({
		memory,
		slug,
		isNewFeature,
		existingPlan: existingPlan ?? "",
		prevTasks,
		task,
		planPath,
		tasksPath: repo.tasks,
	});

	const tasksSigBefore = fileSig(repo.tasks);
	const planSigBefore = fileSig(planPath);
	const { res, timedOut } = await runRoleSubagent(
		{
			repoRoot: repo.root,
			agentsPath: repo.agents,
			promptBodyPath: repo.planPrompt,
			tools: "read,grep,find,ls,write",
			model: MODEL_DEFAULT, // Phase 0.5: Planner runs on Opus 4.8 (xhigh)
			userTurn,
		},
		ROLE_TOOL_TIMEOUT_MS,
		rctx,
	);
	if (subagentFailed(res)) return { kind: "failed", res, timedOut };

	// The planner writes both files itself (write tool). Only fall back to persisting the returned
	// text into tasks.md if it did not write that file.
	fallbackWrite(repo.tasks, tasksSigBefore, res.finalText);
	const wrotePlan = fileSig(planPath) !== planSigBefore && (readIfExists(planPath)?.trim()?.length ?? 0) > 0;
	writeActivePlan(repo, slug);
	return { kind: "ok", res, summary: extractSummary(res.finalText, 10), slug, wrotePlan };
}

async function runVerifyRole(input: { feature?: string; note?: string }, rctx: RoleRunCtx): Promise<VerifyOutcome> {
	const repo = findRepoRoot(rctx.cwd);
	if (!repo) return repoMissing("verify-change");
	const tasks = readIfExists(repo.tasks);
	if (!tasks || !tasks.trim()) {
		return { kind: "invalid", level: "error", reason: "No memory/tasks.md to verify against — run /plan first." };
	}

	// Resolve which overall plan to check against. A provided feature that names an existing
	// plan-<feature>.md wins; otherwise it is not a feature and folds back into the note. Falls back
	// to the active plan recorded by the last /plan, else the sole plan-*.md if there's exactly one.
	let slug: string | undefined;
	let note = (input.note ?? "").trim();
	if (input.feature) {
		const maybe = slugify(input.feature);
		if (maybe && fs.existsSync(planFilePath(repo, maybe))) slug = maybe;
		else note = note ? `${input.feature} ${note}` : input.feature;
	}
	if (!slug) {
		const active = readActivePlan(repo);
		if (active && fs.existsSync(planFilePath(repo, active))) slug = active;
		else {
			const all = listPlanSlugs(repo);
			if (all.length === 1) slug = all[0];
		}
	}
	const overallPlan = slug ? readIfExists(planFilePath(repo, slug)) : undefined;
	const hasOverallPlan = !!overallPlan?.trim();

	const memory = readIfExists(repo.memory) ?? "(memory/MEMORY.md missing)";
	const { text: diff, label: diffLabel } = computeDiff(repo.root);
	const userTurn = buildVerifyUserTurn({
		memory,
		hasOverallPlan,
		slug,
		overallPlan: overallPlan ?? undefined,
		tasks,
		diffLabel,
		diff,
		note,
		verdictPath: repo.verdict,
		verifyChecks: listVerifyChecks(repo.root),
	});

	const sigBefore = fileSig(repo.verdict);
	const { res, timedOut } = await runRoleSubagent(
		{
			repoRoot: repo.root,
			agentsPath: repo.agents,
			promptBodyPath: repo.verifyPrompt,
			tools: "read,grep,find,ls,run_check,write",
			runnerPath: RUNNER_PATH,
			model: MODEL_REVIEW, // Phase 0.5: Verifier (reviewer class) runs on GPT-5.5 (xhigh)
			userTurn,
		},
		ROLE_TOOL_TIMEOUT_MS,
		rctx,
	);
	if (subagentFailed(res)) return { kind: "failed", res, timedOut };

	fallbackWrite(repo.verdict, sigBefore, res.finalText);
	const summary = extractSummary(res.finalText, 10);
	const verdictWord = /\bFAIL\b/i.test(summary.split("\n")[0]) ? "FAIL" : "PASS";
	return { kind: "ok", res, summary, verdictWord };
}

async function runTriageRole(input: { logPath?: string; note?: string }, rctx: RoleRunCtx): Promise<TriageOutcome> {
	const repo = findRepoRoot(rctx.cwd);
	if (!repo) return repoMissing("triage");

	// A provided logPath that names an existing file UNDER the repo is read as the failing log;
	// otherwise it is not a path and folds back into the note (mirrors the original arg handling).
	let logText = "";
	let logLabel = "";
	let note = (input.note ?? "").trim();
	if (input.logPath) {
		const candidate = path.resolve(repo.root, input.logPath);
		const inRepo = candidate === repo.root || candidate.startsWith(repo.root + path.sep);
		if (inRepo && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
			logText = readCapped(candidate);
			logLabel = input.logPath;
		} else {
			note = note ? `${input.logPath} ${note}` : input.logPath;
		}
	}
	if (!logText && !note) {
		return { kind: "invalid", level: "warning", reason: "Usage: /triage [<log-path>] [note: stderr/traceback or a hint]" };
	}

	const firstLogLine = logText.split("\n").find((l) => l.trim()) ?? "";
	const slug = slugify(logLabel || firstLogLine || note) || `triage-${Date.now().toString(36)}`;
	const triagePath = path.join(repo.memoryDir, `triage-${slug}.md`);
	const memory = readIfExists(repo.memory) ?? "(memory/MEMORY.md missing)";
	const userTurn = buildTriageUserTurn({
		memory,
		slug,
		logText,
		logLabel,
		note,
		triagePath,
		verifyChecks: listVerifyChecks(repo.root),
	});

	const sigBefore = fileSig(triagePath);
	const { res, timedOut } = await runRoleSubagent(
		{
			repoRoot: repo.root,
			agentsPath: repo.agents,
			promptBodyPath: path.join(repo.root, "harness", "prompts", "triage.md"),
			tools: "read,grep,find,ls,run_check,write",
			runnerPath: RUNNER_PATH,
			model: MODEL_DEFAULT, // Phase 0.5: diagnostic/observer class -> Opus 4.8 (xhigh)
			userTurn,
		},
		ROLE_TOOL_TIMEOUT_MS,
		rctx,
	);
	if (subagentFailed(res)) return { kind: "failed", res, timedOut };

	fallbackWrite(triagePath, sigBefore, res.finalText);
	const summary = extractSummary(res.finalText, 10);
	const topLabel = summary.split("\n")[0]?.trim().split(/\s+/)[0] || "TRIAGE";
	return { kind: "ok", res, summary, slug, topLabel };
}

async function runMonitorRole(input: { experiment: string; note?: string }, rctx: RoleRunCtx): Promise<MonitorOutcome> {
	const expName = input.experiment.trim();
	if (!expName) {
		return { kind: "invalid", level: "warning", reason: "Usage: /monitor <experiment-name> [note]" };
	}
	const repo = findRepoRoot(rctx.cwd);
	if (!repo) return repoMissing("monitor");

	// Validate the free-text experiment against the closed allowlist IN-HANDLER (F5) so the
	// sub-agent's run_experiment({runId}) isn't refused by the runner for an unknown name.
	const experiments = listExperiments(repo.root);
	const exp = experiments[expName];
	if (!exp) {
		const allowed = Object.keys(experiments).join(", ") || "(none configured in harness/checks.json)";
		return { kind: "invalid", level: "error", reason: `Unknown experiment '${expName}'. Allowed: ${allowed}` };
	}

	// Collision-resistant run id: full ms timestamp + a monotonic per-process suffix.
	// (new Date() is fine in real extension code; only the Workflow scripting sandbox forbids it.)
	const stamp = new Date().toISOString().replace(/[-:T]/g, "").replace("Z", "").replace(".", ""); // YYYYMMDDHHMMSSmmm
	const run = `${slugify(expName)}-${stamp}-${(monitorSeq++).toString(36)}`; // matches ^[A-Za-z0-9._-]{1,80}$
	const reportPath = path.join(repo.memoryDir, `monitor-${run}.md`);
	const logRel = `memory/runs/${run}.log`;
	fs.mkdirSync(path.join(repo.memoryDir, "runs"), { recursive: true });

	const memory = readIfExists(repo.memory) ?? "(memory/MEMORY.md missing)";
	const userTurn = buildMonitorUserTurn({ memory, expName, exp, run, logRel, note: (input.note ?? "").trim(), reportPath });

	const sigBefore = fileSig(reportPath);
	const { res, timedOut } = await runRoleSubagent(
		{
			repoRoot: repo.root,
			agentsPath: repo.agents,
			promptBodyPath: path.join(repo.root, "harness", "prompts", "monitor.md"),
			tools: "read,grep,find,ls,run_experiment,write",
			runnerPath: RUNNER_PATH,
			model: MODEL_DEFAULT, // Phase 0.5: observer class -> Opus 4.8 (xhigh)
			userTurn,
		},
		exp.timeoutMs + MONITOR_TOOL_BUFFER_MS,
		rctx,
	);
	if (subagentFailed(res)) return { kind: "failed", res, timedOut };

	fallbackWrite(reportPath, sigBefore, res.finalText);
	const summary = extractSummary(res.finalText, 10);
	const verdictWord = /^\s*ERROR\b/i.test(summary) ? "ERROR" : "OK";
	return { kind: "ok", res, summary, run, logRel, expName, verdictWord };
}

async function runReportRole(
	input: { subject: string; audience?: string; sources?: string[] },
	rctx: RoleRunCtx,
): Promise<ReportOutcome> {
	const slug = slugify(input.subject);
	if (!slug) {
		return { kind: "invalid", level: "warning", reason: "Usage: /report <subject> [--for=team|paper|self] [sources...]" };
	}
	const repo = findRepoRoot(rctx.cwd);
	if (!repo) return repoMissing("report");
	const audience = input.audience ?? "team";

	// Gather source artifacts: explicit paths if given, else auto-discover the newest monitor report
	// + the standard verdict/tasks artifacts. Missing/empty sources are skipped.
	const sources: { label: string; content: string }[] = [];
	const seen = new Set<string>();
	const addSource = (relOrAbs: string) => {
		const abs = path.resolve(repo.root, relOrAbs);
		if (seen.has(abs)) return;
		seen.add(abs);
		const content = readIfExists(abs);
		if (content && content.trim()) sources.push({ label: path.relative(repo.root, abs), content });
	};
	const explicit = input.sources ?? [];
	if (explicit.length) {
		for (const s of explicit) addSource(s);
	} else {
		const newest = newestMonitorReport(repo.memoryDir);
		if (newest) addSource(newest);
		addSource("memory/verdict.md");
		addSource("memory/tasks.md");
	}

	const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
	fs.mkdirSync(path.join(repo.memoryDir, "reports"), { recursive: true });
	const reportRel = `memory/reports/${slug}-${date}.md`;
	const reportPath = path.join(repo.root, reportRel);

	const memory = readIfExists(repo.memory) ?? "(memory/MEMORY.md missing)";
	const { text: diff, label: diffLabel } = computeDiff(repo.root);
	const { text: gitlog, label: logLabel } = computeGitLog(repo.root);
	const userTurn = buildReportUserTurn({ memory, slug, audience, sources, diffLabel, diff, logLabel, gitlog, reportPath });

	const sigBefore = fileSig(reportPath);
	const { res, timedOut } = await runRoleSubagent(
		{
			repoRoot: repo.root,
			agentsPath: repo.agents,
			promptBodyPath: path.join(repo.root, "harness", "prompts", "report.md"),
			tools: "read,grep,find,ls,write", // writer composes; no execution surface
			model: MODEL_DEFAULT, // Phase 0.5: author class -> Opus 4.8 (xhigh)
			userTurn,
		},
		ROLE_TOOL_TIMEOUT_MS,
		rctx,
	);
	if (subagentFailed(res)) return { kind: "failed", res, timedOut };

	fallbackWrite(reportPath, sigBefore, res.finalText);
	return { kind: "ok", res, summary: extractSummary(res.finalText, 10), slug, reportRel, audience };
}

async function runResearchRole(input: { topic: string; question: string }, rctx: RoleRunCtx): Promise<ResearchOutcome> {
	const slug = slugify(input.topic);
	const question = input.question.trim();
	if (!slug || !question) {
		return {
			kind: "invalid",
			level: "warning",
			reason: "Usage: /research <topic> <question>  (e.g. /research zod is zod or valibot smaller?)",
		};
	}
	const repo = findRepoRoot(rctx.cwd);
	if (!repo) return repoMissing("research");

	const researchPath = path.join(repo.memoryDir, `research-${slug}.md`);
	const memory = readIfExists(repo.memory) ?? "(memory/MEMORY.md missing)";
	const userTurn = buildResearchUserTurn({ memory, slug, question, researchPath });

	const sigBefore = fileSig(researchPath);
	const { res, timedOut } = await runRoleSubagent(
		{
			repoRoot: repo.root,
			agentsPath: repo.agents,
			promptBodyPath: path.join(repo.root, "harness", "prompts", "research.md"),
			tools: "read,grep,find,ls,write,web_search,fetch_content",
			runnerPath: WEB_TOOLS_SOURCE, // -e npm:pi-web-access — web tools load only via explicit -e
			model: MODEL_DEFAULT, // Phase 0.5: research class -> Opus 4.8 (xhigh)
			userTurn,
		},
		ROLE_TOOL_TIMEOUT_MS,
		rctx,
	);
	if (subagentFailed(res)) return { kind: "failed", res, timedOut };

	fallbackWrite(researchPath, sigBefore, res.finalText);
	const summary = extractSummary(res.finalText, 10);
	const first = summary.split("\n")[0]?.trim().toUpperCase() ?? "";
	const verdictWord = first.startsWith("CONFIDENT")
		? "CONFIDENT"
		: first.startsWith("INCONCLUSIVE")
			? "INCONCLUSIVE"
			: "MIXED"; // default when the first token is MIXED or unrecognized
	return { kind: "ok", res, summary, slug, verdictWord };
}

// ---------------------------------------------------------------------------
// Mode helpers
// ---------------------------------------------------------------------------

// Footer-status progress setter for command-mode (mirrors the original "<role>: turn N (tool)…").
function statusProgress(
	ctx: ExtensionCommandContext,
	label: string,
): (turns: number, lastTool: string | undefined) => void {
	return (turns, lastTool) => ctx.ui.setStatus("subagents", `${label}: turn ${turns}${lastTool ? ` (${lastTool})` : ""}…`);
}

// Tool-mode progress: footer status + (when streaming a tool) the tool-result row.
function toolProgress(
	ctx: ExtensionContext,
	onUpdate: AgentToolUpdateCallback<unknown> | undefined,
	label: string,
): (turns: number, lastTool: string | undefined) => void {
	return (turns, lastTool) => {
		const text = `${label}: turn ${turns}${lastTool ? ` (${lastTool})` : ""}…`;
		ctx.ui.setStatus("subagents", text);
		onUpdate?.({ content: [{ type: "text", text }], details: {} });
	};
}

// Build the tool result: the <=10-line summary as content (artifact stays on disk) + metadata-only
// details (cleanDetails drops non-primitives — secret-redaction never scrubs `details`).
function summaryResult(summary: string, details: Record<string, unknown>): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: summary }], details: cleanDetails(details) };
}

// Post a /monitor (or /monitor-main) outcome to the operator + the next turn. Shared so both the
// command and its 4b -main alias deliver identically.
function postMonitorOutcome(pi: ExtensionAPI, ctx: ExtensionCommandContext, r: MonitorOutcome): void {
	if (r.kind === "invalid") {
		ctx.ui.notify(r.reason, r.level);
		return;
	}
	if (r.kind === "failed") {
		const why = failReasonVerbose(r.res);
		ctx.ui.notify(`Monitor failed: ${why}`, "error");
		pi.sendMessage(
			{
				customType: "subagent-monitor",
				content: `Monitor FAILED (${r.res.stopReason ?? `exit ${r.res.exitCode}`}): ${why}`,
				display: true,
			},
			{ deliverAs: "nextTurn" },
		);
		return;
	}
	pi.sendMessage(
		{
			customType: "subagent-monitor",
			content: `Monitor verdict (${r.expName}, ${r.res.turns} turns):\n\n${r.summary}\n\nFull report -> memory/monitor-${r.run}.md\nLog -> ${r.logRel}`,
			display: true,
			details: { verdict: r.verdictWord, experiment: r.expName, runId: r.run },
		},
		{ deliverAs: "nextTurn" },
	);
	ctx.ui.notify(
		`Monitor: ${r.verdictWord} — written to memory/monitor-${r.run}.md`,
		r.verdictWord === "ERROR" ? "warning" : "info",
	);
}

// Post a /research (or /research-main) outcome. Shared by the command and its 4b -main alias.
function postResearchOutcome(pi: ExtensionAPI, ctx: ExtensionCommandContext, r: ResearchOutcome): void {
	if (r.kind === "invalid") {
		ctx.ui.notify(r.reason, r.level);
		return;
	}
	if (r.kind === "failed") {
		const why = failReasonVerbose(r.res);
		ctx.ui.notify(`Research failed: ${why}. (Web tools require: pi install npm:pi-web-access)`, "error");
		pi.sendMessage(
			{
				customType: "subagent-research",
				content: `Research FAILED (${r.res.stopReason ?? `exit ${r.res.exitCode}`}): ${why}`,
				display: true,
			},
			{ deliverAs: "nextTurn" },
		);
		return;
	}
	pi.sendMessage(
		{
			customType: "subagent-research",
			content: `Research summary (topic: ${r.slug}, ${r.res.turns} turns):\n\n${r.summary}\n\nFull note + citations -> memory/research-${r.slug}.md`,
			display: true,
			details: { verdict: r.verdictWord },
		},
		{ deliverAs: "nextTurn" },
	);
	ctx.ui.notify(`Research: ${r.verdictWord} — written to memory/research-${r.slug}.md`, "info");
}

// ---------------------------------------------------------------------------
// Commands + tools
// ---------------------------------------------------------------------------

export default function subagents(pi: ExtensionAPI) {
	// Tool-mode children spawn DURING streaming; arm the shutdown guard so /reload|quit reclaims them.
	registerShutdownGuard(pi);

	// ----- /plan -----
	pi.registerCommand("plan", {
		description:
			"Planner subagent (isolated) -> writes overall memory/plan-<feature>.md + memory/tasks.md, returns a <=10-line summary",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const raw = args.trim();
			const firstSpace = raw.search(/\s/);
			const featureRaw = firstSpace === -1 ? raw : raw.slice(0, firstSpace);
			const task = firstSpace === -1 ? "" : raw.slice(firstSpace + 1).trim();
			ctx.ui.setStatus("subagents", "planner: starting…");
			let r: PlanOutcome;
			try {
				r = await runPlanRole(
					{ feature: featureRaw, task },
					{ cwd: ctx.cwd, mode: "command", onProgress: statusProgress(ctx, "planner") },
				);
			} finally {
				ctx.ui.setStatus("subagents", "");
			}
			if (r.kind === "invalid") {
				ctx.ui.notify(r.reason, r.level);
				return;
			}
			if (r.kind === "failed") {
				const why = failReasonVerbose(r.res);
				ctx.ui.notify(`Planner failed: ${why}`, "error");
				pi.sendMessage(
					{
						customType: "subagent-plan",
						content: `Planner FAILED (${r.res.stopReason ?? `exit ${r.res.exitCode}`}): ${why}`,
						display: true,
					},
					{ deliverAs: "nextTurn" },
				);
				return;
			}
			const planNote = r.wrotePlan
				? `Overall plan -> memory/plan-${r.slug}.md`
				: `WARNING: planner did not write memory/plan-${r.slug}.md`;
			pi.sendMessage(
				{
					customType: "subagent-plan",
					content: `Planner summary (feature: ${r.slug}, ${r.res.turns} turns):\n\n${r.summary}\n\n${planNote}\nTask slice -> memory/tasks.md`,
					display: true,
				},
				{ deliverAs: "nextTurn" },
			);
			ctx.ui.notify(`Plan written: memory/plan-${r.slug}.md + memory/tasks.md`, r.wrotePlan ? "info" : "warning");
		},
	});

	// ----- /verify -----
	pi.registerCommand("verify", {
		description: "Verifier subagent (allowlisted runner, isolated) -> writes its own memory/verdict.md, returns PASS/FAIL",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			// Free-text disambiguation (which token is the feature) lives inside runVerifyRole — it needs
			// the repo, which runVerifyRole resolves. Pass the first token as the feature candidate.
			const rawArgs = args.trim();
			const tokens = rawArgs.length ? rawArgs.split(/\s+/) : [];
			const feature = tokens.length ? tokens[0] : undefined;
			const note = tokens.length ? tokens.slice(1).join(" ") : "";
			ctx.ui.setStatus("subagents", "verifier: starting…");
			let r: VerifyOutcome;
			try {
				r = await runVerifyRole(
					{ feature, note },
					{ cwd: ctx.cwd, mode: "command", onProgress: statusProgress(ctx, "verifier") },
				);
			} finally {
				ctx.ui.setStatus("subagents", "");
			}
			if (r.kind === "invalid") {
				ctx.ui.notify(r.reason, r.level);
				return;
			}
			if (r.kind === "failed") {
				const why = failReasonVerbose(r.res);
				ctx.ui.notify(`Verifier failed: ${why}`, "error");
				pi.sendMessage(
					{
						customType: "subagent-verify",
						content: `Verifier FAILED (${r.res.stopReason ?? `exit ${r.res.exitCode}`}): ${why}`,
						display: true,
					},
					{ deliverAs: "nextTurn" },
				);
				return;
			}
			pi.sendMessage(
				{
					customType: "subagent-verify",
					content: `Verifier verdict (${r.res.turns} turns):\n\n${r.summary}\n\nFull verdict -> memory/verdict.md`,
					display: true,
					details: { verdict: r.verdictWord },
				},
				{ deliverAs: "nextTurn" },
			);
			ctx.ui.notify(
				`Verifier: ${r.verdictWord} — written to memory/verdict.md`,
				r.verdictWord === "FAIL" ? "warning" : "info",
			);
		},
	});

	// ----- /triage -----
	pi.registerCommand("triage", {
		description:
			"Triage subagent (allowlisted read-only probes, isolated) -> ranks root-cause hypotheses + one next probe, writes memory/triage-<id>.md",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const raw = args.trim();
			const tokens = raw ? raw.split(/\s+/) : [];
			const logPath = tokens.length ? tokens[0] : undefined;
			const note = tokens.length ? tokens.slice(1).join(" ") : "";
			ctx.ui.setStatus("subagents", "triage: starting…");
			let r: TriageOutcome;
			try {
				r = await runTriageRole(
					{ logPath, note },
					{ cwd: ctx.cwd, mode: "command", onProgress: statusProgress(ctx, "triage") },
				);
			} finally {
				ctx.ui.setStatus("subagents", "");
			}
			if (r.kind === "invalid") {
				ctx.ui.notify(r.reason, r.level);
				return;
			}
			if (r.kind === "failed") {
				const why = failReasonVerbose(r.res);
				ctx.ui.notify(`Triage failed: ${why}`, "error");
				pi.sendMessage(
					{
						customType: "subagent-triage",
						content: `Triage FAILED (${r.res.stopReason ?? `exit ${r.res.exitCode}`}): ${why}`,
						display: true,
					},
					{ deliverAs: "nextTurn" },
				);
				return;
			}
			pi.sendMessage(
				{
					customType: "subagent-triage",
					content: `Triage summary (${r.res.turns} turns):\n\n${r.summary}\n\nFull triage -> memory/triage-${r.slug}.md`,
					display: true,
					details: { hypothesis: r.topLabel },
				},
				{ deliverAs: "nextTurn" },
			);
			ctx.ui.notify(`Triage: ${r.topLabel} — written to memory/triage-${r.slug}.md`, "info");
		},
	});

	// ----- /monitor -----
	// /monitor and /monitor-main run the SAME isolated sub-agent. 4b: monitor's real tool
	// (run_experiment) is subprocess-only, so `-main` can't be an in-session clamp — it spawns the
	// isolated sub-agent and returns the summary, identical to /monitor.
	const monitorCmd = async (args: string, ctx: ExtensionCommandContext) => {
		const raw = args.trim();
		const firstSpace = raw.search(/\s/);
		const experiment = (firstSpace === -1 ? raw : raw.slice(0, firstSpace)).trim();
		const note = firstSpace === -1 ? "" : raw.slice(firstSpace + 1).trim();
		ctx.ui.setStatus("subagents", experiment ? `monitor: starting ${experiment}…` : "monitor: starting…");
		let r: MonitorOutcome;
		try {
			r = await runMonitorRole({ experiment, note }, { cwd: ctx.cwd, mode: "command", onProgress: statusProgress(ctx, "monitor") });
		} finally {
			ctx.ui.setStatus("subagents", "");
		}
		postMonitorOutcome(pi, ctx, r);
	};
	pi.registerCommand("monitor", {
		description:
			"Monitor subagent (allowlisted experiment runner, isolated) -> runs one experiment, watches for errors, writes memory/monitor-<run>.md, returns OK/ERROR",
		handler: monitorCmd,
	});
	pi.registerCommand("monitor-main", {
		description:
			"Monitor under its methodology = the isolated monitor sub-agent (4b: its tools are subprocess-only). Same as /monitor <experiment>.",
		handler: monitorCmd,
	});

	// ----- /report -----
	pi.registerCommand("report", {
		description:
			"Report subagent (writer, isolated) -> composes a polished audience-facing document from memory/ artifacts into memory/reports/<subject>-<date>.md",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim() ? args.trim().split(/\s+/) : [];
			let audience = "team";
			const rest: string[] = [];
			for (const t of tokens) {
				const m = /^--for=(team|paper|self)$/.exec(t);
				if (m) {
					audience = m[1];
					continue;
				}
				rest.push(t);
			}
			const subject = rest.shift() ?? "";
			ctx.ui.setStatus("subagents", "report: composing…");
			let r: ReportOutcome;
			try {
				r = await runReportRole(
					{ subject, audience, sources: rest },
					{ cwd: ctx.cwd, mode: "command", onProgress: statusProgress(ctx, "report") },
				);
			} finally {
				ctx.ui.setStatus("subagents", "");
			}
			if (r.kind === "invalid") {
				ctx.ui.notify(r.reason, r.level);
				return;
			}
			if (r.kind === "failed") {
				const why = failReasonVerbose(r.res);
				ctx.ui.notify(`Report failed: ${why}`, "error");
				pi.sendMessage(
					{
						customType: "subagent-report",
						content: `Report FAILED (${r.res.stopReason ?? `exit ${r.res.exitCode}`}): ${why}`,
						display: true,
					},
					{ deliverAs: "nextTurn" },
				);
				return;
			}
			// /report's contract inverts the others: the SUMMARY is an abstract, NOT a verdict — so the
			// parent posts details:{audience}, not details:{verdict} (intentional asymmetry).
			pi.sendMessage(
				{
					customType: "subagent-report",
					content: `Report summary (${r.slug}, ${r.res.turns} turns):\n\n${r.summary}\n\nFull report -> ${r.reportRel}`,
					display: true,
					details: { audience: r.audience },
				},
				{ deliverAs: "nextTurn" },
			);
			ctx.ui.notify(`Report written: ${r.reportRel}`, "info");
		},
	});

	// ----- /research -----
	// /research and /research-main run the SAME isolated sub-agent (4b: web tools are subprocess-only).
	const researchCmd = async (args: string, ctx: ExtensionCommandContext) => {
		const raw = args.trim();
		const firstSpace = raw.search(/\s/);
		const topicRaw = firstSpace === -1 ? raw : raw.slice(0, firstSpace);
		const question = firstSpace === -1 ? "" : raw.slice(firstSpace + 1).trim();
		ctx.ui.setStatus("subagents", "research: starting…");
		let r: ResearchOutcome;
		try {
			r = await runResearchRole({ topic: topicRaw, question }, { cwd: ctx.cwd, mode: "command", onProgress: statusProgress(ctx, "research") });
		} finally {
			ctx.ui.setStatus("subagents", "");
		}
		postResearchOutcome(pi, ctx, r);
	};
	pi.registerCommand("research", {
		description:
			"Research subagent (web search, isolated) -> a cited, claim-checked note in memory/research-<topic>.md. Needs: pi install npm:pi-web-access",
		handler: researchCmd,
	});
	pi.registerCommand("research-main", {
		description:
			"Research under its methodology = the isolated research sub-agent (4b: web tools are subprocess-only). Same as /research <topic> <question>.",
		handler: researchCmd,
	});

	// -------------------------------------------------------------------------
	// Tool-mode: model-callable `subagent_<role>` tools (namespaced — pi's tool registry is
	// last-write-wins with NO collision error, so the prefix is mandatory to avoid silently shadowing
	// a built-in (read/write/edit/bash/grep/find/ls) or extension tool (run_check/run_experiment)).
	// executionMode:"sequential" serializes a batch; a one-line promptSnippet makes each discoverable.
	// On failure each THROWS a controlled, redaction-safe Error (a returned isError:true is inert).
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "subagent_plan",
		label: "Subagent: Plan",
		description:
			"Spawn an isolated planner sub-agent that writes the durable memory/plan-<feature>.md roadmap + the memory/tasks.md slice, then returns ONLY a <=10-line summary (the plan files stay on disk).",
		promptSnippet:
			"subagent_plan{feature,task}: isolated planner → writes memory/plan-<feature>.md + memory/tasks.md, returns a <=10-line summary.",
		parameters: Type.Object({
			feature: Type.String({ description: "Short feature name; slugified to scope memory/plan-<feature>.md" }),
			task: Type.String({ description: "The concrete next slice to plan" }),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, onUpdate, ctx) {
			let r: PlanOutcome;
			try {
				r = await runPlanRole(
					{ feature: params.feature, task: params.task },
					{ cwd: ctx.cwd, mode: "tool", signal, onProgress: toolProgress(ctx, onUpdate, "planner") },
				);
			} finally {
				ctx.ui.setStatus("subagents", "");
			}
			if (r.kind === "invalid") throw new Error(r.reason);
			if (r.kind === "failed") throw new Error(`planner sub-agent failed: ${failReason(r.res, r.timedOut)}`);
			return summaryResult(r.summary, { role: "plan", feature: r.slug, turns: r.res.turns, wrotePlan: r.wrotePlan });
		},
	});

	pi.registerTool({
		name: "subagent_verify",
		label: "Subagent: Verify",
		description:
			"Spawn an isolated verifier sub-agent that judges the working diff against the overall plan + the task slice, writes memory/verdict.md, and returns PASS/FAIL + a <=10-line summary. It never edits source.",
		promptSnippet:
			"subagent_verify{feature?,note?}: isolated verifier → judges the diff, writes memory/verdict.md, returns PASS/FAIL + a <=10-line summary.",
		parameters: Type.Object({
			feature: Type.Optional(
				Type.String({
					description: "Feature whose memory/plan-<feature>.md to judge against; defaults to the active plan",
				}),
			),
			note: Type.Optional(Type.String({ description: "Optional reviewer note / hint" })),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, onUpdate, ctx) {
			let r: VerifyOutcome;
			try {
				r = await runVerifyRole(
					{ feature: params.feature, note: params.note },
					{ cwd: ctx.cwd, mode: "tool", signal, onProgress: toolProgress(ctx, onUpdate, "verifier") },
				);
			} finally {
				ctx.ui.setStatus("subagents", "");
			}
			if (r.kind === "invalid") throw new Error(r.reason);
			if (r.kind === "failed") throw new Error(`verifier sub-agent failed: ${failReason(r.res, r.timedOut)}`);
			return summaryResult(r.summary, { role: "verify", verdict: r.verdictWord, turns: r.res.turns });
		},
	});

	pi.registerTool({
		name: "subagent_triage",
		label: "Subagent: Triage",
		description:
			"Spawn an isolated triage sub-agent that ranks root-cause hypotheses for a failure (read-only probes) + names one next probe, writes memory/triage-<id>.md, and returns a <=10-line summary. It never fixes code.",
		promptSnippet:
			"subagent_triage{logPath?,note}: isolated triage → ranks root-cause hypotheses, writes memory/triage-<id>.md, returns a <=10-line summary.",
		parameters: Type.Object({
			logPath: Type.Optional(Type.String({ description: "Repo-relative path to a failing log to diagnose" })),
			note: Type.String({ description: "stderr / traceback excerpt or a hint describing the failure" }),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, onUpdate, ctx) {
			let r: TriageOutcome;
			try {
				r = await runTriageRole(
					{ logPath: params.logPath, note: params.note },
					{ cwd: ctx.cwd, mode: "tool", signal, onProgress: toolProgress(ctx, onUpdate, "triage") },
				);
			} finally {
				ctx.ui.setStatus("subagents", "");
			}
			if (r.kind === "invalid") throw new Error(r.reason);
			if (r.kind === "failed") throw new Error(`triage sub-agent failed: ${failReason(r.res, r.timedOut)}`);
			return summaryResult(r.summary, { role: "triage", hypothesis: r.topLabel, turns: r.res.turns });
		},
	});

	pi.registerTool({
		name: "subagent_monitor",
		label: "Subagent: Monitor",
		description:
			"Spawn an isolated monitor sub-agent that launches ONE allowlisted experiment (from harness/checks.json), watches the redacted stream for errors, writes memory/monitor-<run>.md, and returns OK/ERROR + a <=10-line summary.",
		promptSnippet:
			"subagent_monitor{experiment,note?}: isolated monitor → runs one allowlisted experiment, writes memory/monitor-<run>.md, returns OK/ERROR + a <=10-line summary.",
		parameters: Type.Object({
			experiment: Type.String({ description: "Name of an allowlisted experiment defined in harness/checks.json" }),
			note: Type.Optional(Type.String({ description: "Optional operator note" })),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, onUpdate, ctx) {
			let r: MonitorOutcome;
			try {
				r = await runMonitorRole(
					{ experiment: params.experiment, note: params.note },
					{ cwd: ctx.cwd, mode: "tool", signal, onProgress: toolProgress(ctx, onUpdate, "monitor") },
				);
			} finally {
				ctx.ui.setStatus("subagents", "");
			}
			if (r.kind === "invalid") throw new Error(r.reason);
			if (r.kind === "failed") throw new Error(`monitor sub-agent failed: ${failReason(r.res, r.timedOut)}`);
			return summaryResult(r.summary, {
				role: "monitor",
				verdict: r.verdictWord,
				experiment: r.expName,
				runId: r.run,
				turns: r.res.turns,
			});
		},
	});

	pi.registerTool({
		name: "subagent_report",
		label: "Subagent: Report",
		description:
			"Spawn an isolated report sub-agent that composes a polished, audience-facing document from memory/ artifacts into memory/reports/<subject>-<date>.md, then returns a <=10-line summary. It runs nothing and fixes nothing.",
		promptSnippet:
			"subagent_report{subject,audience?,sources?}: isolated writer → composes memory/reports/<subject>-<date>.md, returns a <=10-line summary.",
		parameters: Type.Object({
			subject: Type.String({ description: "Report subject; slugified into memory/reports/<subject>-<date>.md" }),
			audience: Type.Optional(
				StringEnum(["team", "paper", "self"], { description: "Audience register (default team)", default: "team" }),
			),
			sources: Type.Optional(
				Type.Array(Type.String(), {
					description: "Explicit source artifact paths; default auto-discovers the newest monitor report + verdict + tasks",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, onUpdate, ctx) {
			let r: ReportOutcome;
			try {
				r = await runReportRole(
					{ subject: params.subject, audience: params.audience, sources: params.sources },
					{ cwd: ctx.cwd, mode: "tool", signal, onProgress: toolProgress(ctx, onUpdate, "report") },
				);
			} finally {
				ctx.ui.setStatus("subagents", "");
			}
			if (r.kind === "invalid") throw new Error(r.reason);
			if (r.kind === "failed") throw new Error(`report sub-agent failed: ${failReason(r.res, r.timedOut)}`);
			return summaryResult(r.summary, { role: "report", audience: r.audience, turns: r.res.turns });
		},
	});

	pi.registerTool({
		name: "subagent_research",
		label: "Subagent: Research",
		description:
			"Spawn an isolated research sub-agent that web-searches a question into a cited, claim-checked note in memory/research-<topic>.md, then returns CONFIDENT/MIXED/INCONCLUSIVE + a <=10-line summary. Needs pi install npm:pi-web-access.",
		promptSnippet:
			"subagent_research{topic,question}: isolated web research → cited note in memory/research-<topic>.md, returns a <=10-line summary.",
		parameters: Type.Object({
			topic: Type.String({ description: "Short topic; slugified into memory/research-<topic>.md" }),
			question: Type.String({ description: "The question to research" }),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, onUpdate, ctx) {
			let r: ResearchOutcome;
			try {
				r = await runResearchRole(
					{ topic: params.topic, question: params.question },
					{ cwd: ctx.cwd, mode: "tool", signal, onProgress: toolProgress(ctx, onUpdate, "research") },
				);
			} finally {
				ctx.ui.setStatus("subagents", "");
			}
			if (r.kind === "invalid") throw new Error(r.reason);
			if (r.kind === "failed") throw new Error(`research sub-agent failed: ${failReason(r.res, r.timedOut)}`);
			return summaryResult(r.summary, { role: "research", verdict: r.verdictWord, turns: r.res.turns });
		},
	});

	// -------------------------------------------------------------------------
	// 4a: /<role>-main — run the MAIN session UNDER an in-session role's methodology (plan/verify/
	// triage/report). On: snapshot the full tool set, clamp to the role set, inject the role body, and
	// gate off-role tool calls. Single-slot activeRoleMain (replace, never stack). State persists across
	// /reload + /resume so the clamp never strands the user (N2). (monitor/research-main are 4b — they're
	// the isolated-sub-agent aliases registered above, not an in-session clamp.)
	// -------------------------------------------------------------------------
	const persistRoleMain = () => pi.appendEntry(ROLE_MAIN_ENTRY, { activeRole: activeRoleMain, savedTools: savedMainTools });
	const setRoleMainStatus = (ctx: ExtensionContext) =>
		ctx.ui.setStatus("role-main", activeRoleMain ? `▶ ${activeRoleMain}-main` : undefined);

	const roleMainOn = (role: RoleMain, ctx: ExtensionCommandContext) => {
		// Snapshot the FULL set only when entering from no-role; a role SWITCH keeps the original snapshot
		// (so the eventual `off` restores the true pre-clamp set, incl. the six subagent_* + sibling tools).
		if (activeRoleMain === null) savedMainTools = pi.getActiveTools();
		activeRoleMain = role;
		pi.setActiveTools([...ROLE_MAIN_TOOLS[role]]);
		persistRoleMain();
		setRoleMainStatus(ctx);
		ctx.ui.notify(
			`${role}-main ON — tools clamped to {${ROLE_MAIN_TOOLS[role].join(", ")}}, ${role} methodology injected. /${role}-main off to exit.`,
			"info",
		);
	};
	const roleMainOff = (ctx: ExtensionCommandContext) => {
		if (activeRoleMain === null) {
			ctx.ui.notify("No -main role is active.", "info");
			return;
		}
		const was = activeRoleMain;
		pi.setActiveTools(savedMainTools ?? [...ROLE_MAIN_FALLBACK_TOOLS]);
		activeRoleMain = null;
		savedMainTools = null;
		persistRoleMain();
		setRoleMainStatus(ctx);
		ctx.ui.notify(`${was}-main OFF — full tools restored.`, "info");
	};

	for (const role of ROLE_MAIN) {
		pi.registerCommand(`${role}-main`, {
			description: `Run the MAIN session under the ${role} methodology (clamps tools + injects the body): /${role}-main on|off`,
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				const cmd = parseOnOff(args);
				if (cmd === "on") roleMainOn(role, ctx);
				else if (cmd === "off") roleMainOff(ctx);
				else
					ctx.ui.notify(
						activeRoleMain
							? `Active: ${activeRoleMain}-main (tools: ${ROLE_MAIN_TOOLS[activeRoleMain].join(", ")}). Usage: /${role}-main on|off`
							: `No -main role active. Usage: /${role}-main on|off  (clamps tools + injects the ${role} methodology)`,
						"info",
					);
			},
		});
	}

	// Inject ONLY the role methodology body (NOT the AGENTS.md brief — the main session already
	// auto-loads it into e.systemPrompt; re-injecting would duplicate it). F1. Auto-reverts to base
	// when no role is active (this returns nothing).
	pi.on("before_agent_start", async (e, ctx) => {
		if (!activeRoleMain) return;
		const repo = findRepoRoot(ctx.cwd);
		if (!repo) return;
		const body = readIfExists(path.join(repo.root, "harness", "prompts", ROLE_MAIN_PROMPT[activeRoleMain]));
		if (!body || !body.trim()) return;
		return {
			systemPrompt: `${e.systemPrompt}\n\n---\n\n# Active methodology — you are operating as ${activeRoleMain} in this main session. Apply it.\n\n${body.trim()}\n`,
		};
	});

	// Load-bearing enforcement: while a role is active, BLOCK any tool call outside its allowed set.
	// (The clamp narrows what the model SEES; this gate enforces even if a call slips through. The six
	// subagent_* tools are intentionally NOT in any role set — don't spawn a sub-agent while you ARE it.)
	pi.on("tool_call", async (event) => {
		if (!activeRoleMain) return;
		if (isToolBlockedInRoleMain(activeRoleMain, event.toolName)) {
			return {
				block: true,
				reason: `${activeRoleMain}-main: '${event.toolName}' is not allowed in this role (allowed: ${ROLE_MAIN_TOOLS[activeRoleMain].join(", ")}). Run /${activeRoleMain}-main off first.`,
			};
		}
	});

	// Restore across /reload + /resume (N2, the highest-risk lifecycle bug). On /reload the runtime
	// re-applies the persisted tool CLAMP but re-instantiates this module (activeRoleMain -> null), which
	// would strand the user clamped read-only with no role + no body. Re-read the persisted state and
	// re-apply the clamp + status; the always-armed before_agent_start re-injects the body. Safety net:
	// if no role is active, ensure a clamp can never outlive its role — restore the recorded full set, or
	// (defensive, no snapshot but tools look clamped) the best-effort fallback.
	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const last = [...entries]
			.reverse()
			.find((en: { type: string; customType?: string }) => en.type === "custom" && en.customType === ROLE_MAIN_ENTRY) as
			| { data?: { activeRole?: unknown; savedTools?: unknown } }
			| undefined;
		const persistedRole =
			typeof last?.data?.activeRole === "string" && isRoleMain(last.data.activeRole) ? last.data.activeRole : null;
		const recorded = Array.isArray(last?.data?.savedTools) ? (last.data.savedTools as string[]) : null;
		if (persistedRole) {
			activeRoleMain = persistedRole;
			savedMainTools = recorded;
			pi.setActiveTools([...ROLE_MAIN_TOOLS[persistedRole]]); // re-apply the clamp the role needs
		} else {
			activeRoleMain = null;
			savedMainTools = null;
			if (recorded && recorded.length) {
				pi.setActiveTools(recorded);
			} else {
				const cur = pi.getActiveTools();
				if (!cur.includes("bash") && !cur.includes("edit")) pi.setActiveTools([...ROLE_MAIN_FALLBACK_TOOLS]);
			}
		}
		setRoleMainStatus(ctx);
	});
}
