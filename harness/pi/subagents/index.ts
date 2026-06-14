/**
 * Planner -> Implement -> Verify subagents for the token-minimizing harness.
 *
 * Replicates the "tokenminimizer" workflow inside Pi:
 *   /plan <feature> "<task>"  -> Planner subagent (isolated) -> writes/updates the durable
 *                       overall plan memory/plan-<feature>.md AND the current slice memory/tasks.md
 *                       -> posts a <=10-line SUMMARY + paths back to the main session.
 *   /implement         -> just work normally in the main session (no subagent here).
 *   /verify [feature] [note]   -> Verifier subagent (allowlisted runner, isolated)
 *                       -> judges the diff against BOTH the overall plan and the task slice,
 *                       writes memory/verdict.md ITSELF -> posts PASS/FAIL + <=10-line SUMMARY + path.
 *
 * Overall plan vs task slice:
 *   - memory/plan-<feature>.md is the DURABLE roadmap for a feature; new on the first /plan for that
 *     feature, updated/extended on subsequent ones. memory/.active-plan points at the last feature so
 *     /verify can locate it. memory/tasks.md is the single ACTIVE slice (overwritten each /plan).
 *
 * Core rule honored: "index in context, detail on disk."
 *   - Stable methodology lives in the subagent's system prompt (your AGENTS.md brief +
 *     harness/prompts/{plan,verify-change}.md), appended to Pi's default prompt.
 *   - Variable inputs (MEMORY.md index, task, diff, current tasks.md) go in the first user turn.
 *   - Detail files under memory/** are read on demand by the subagent, never preloaded.
 *   - Only the SUMMARY (+ file path) crosses back into the main session.
 *
 * Isolation + tool restriction (the safety core):
 *   - Each subagent is a SEPARATE `pi` subprocess (its own context window, torn down on exit):
 *       --mode json -p --no-session
 *   - It inherits your default model from your pi settings (no API key needed for the subagent).
 *   - Tools are an explicit allowlist via --tools. Each subagent gets `write` so it can author
 *     its OWN output file, but NOT `edit` and NOT a general shell (structural, not advisory):
 *       Planner:  read,grep,find,ls,write
 *       Verifier: read,grep,find,ls,run_check,write   (run_check = named-check allowlist, see runner.ts)
 *     The handoff instructs each agent to write exactly one file (memory/tasks.md or memory/verdict.md).
 *   - The subprocess loads NO ambient config (--no-extensions/-nc/--no-skills/--no-prompt-templates),
 *     so it can't re-enter this extension. The Verifier loads ONLY runner.ts via -e.
 *
 * Each subagent authors its own markdown file directly. The PARENT command keeps a fallback:
 * if a subagent failed to write the file, the parent persists the returned text instead, and it
 * always surfaces only the SUMMARY to the main session.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const RUNNER_PATH = path.join(import.meta.dirname ?? __dirname, "runner.ts");

const MAX_DIFF_BYTES = 150 * 1024;

// Phase 0.5 — per-role model & thinking policy (one place; don't scatter ids).
// Reviewing/adversarial-judge agents run on GPT-5.5; every other sub-agent runs on
// Opus 4.8; both at "xhigh" thinking. Passed to runSubagent per role (see the role map
// in the README). The exact model-id strings are FLAG-to-verify on a live pi
// (`pi --list-models`); if one isn't listed, update ONLY the constant below.
const EFFORT = "xhigh";
const MODEL_DEFAULT = "anthropic/opus-4.8"; // plan, monitor, triage, research, report
const MODEL_REVIEW = "openai/gpt-5.5"; // the reviewing/adversarial-judge agents (verify)

// Universal git checks the Verifier can always run (mirrors runner.ts).
const GIT_CHECKS = ["git-diff", "git-diff-stat", "git-status", "git-log"];

// Build the human-readable list of checks the Verifier is allowed to run, derived
// from <repoRoot>/harness/checks.json (project-specific checks + test-file) plus the
// universal git checks. Kept in sync with runner.ts, which enforces the same set.
function listVerifyChecks(repoRoot: string): string {
	const names: string[] = [];
	try {
		const raw = fs.readFileSync(path.join(repoRoot, "harness", "checks.json"), "utf-8");
		const cfg = JSON.parse(raw) as { checks?: Record<string, unknown>; testFile?: unknown };
		if (cfg.checks) names.push(...Object.keys(cfg.checks));
		if (cfg.testFile) names.push("test-file");
	} catch {
		/* no config: only git checks are available */
	}
	names.push(...GIT_CHECKS);
	return names.join(", ");
}

function handoffPlan(planPath: string, tasksPath: string, isNewFeature: boolean): string {
	return [
		"---",
		"HARNESS HANDOFF (read this):",
		"- You have read AND write tools. You will write TWO files with the write tool:",
		`    1. OVERALL PLAN (durable roadmap for this feature) -> ${planPath}`,
		`    2. TASK SLICE   (the concrete next batch to implement) -> ${tasksPath}`,
		isNewFeature
			? "- The overall plan file does NOT exist yet (NEW feature): author a fresh, complete overall plan."
			: "- The overall plan file ALREADY exists (SAME feature): read it first, then UPDATE/EXTEND it in place — preserve still-valid content and prior decisions, refine what changed, append new sections. Supersede old decisions explicitly rather than silently dropping them.",
		"- The OVERALL PLAN is the durable roadmap spanning the whole feature, not just the next step. Include: Goal, Context, Approach/architecture, Key decisions, Milestones/phases, Risks/unknowns, Out of scope.",
		"- The TASK SLICE (tasks file) is the concrete, actionable batch to implement NEXT, derived from the overall plan: numbered steps, Files to touch, and a Test plan. Overwrite this file fully each run; it is the CURRENT SLICE of the overall plan above.",
		"- Keep the task slice consistent with the overall plan.",
		"- Load detail from memory/** with your read/grep/find/ls tools ONLY as needed; do not dump the repo.",
		"- AFTER BOTH files are written, your final message must be a line exactly `## SUMMARY` followed by AT MOST 10 lines: a one-line goal, then the numbered task headlines for the current slice. Nothing else after it.",
		"- The harness reads the files you wrote and surfaces only the SUMMARY to the main session.",
	].join("\n");
}

function handoffVerify(verdictPath: string, hasOverallPlan: boolean, verifyChecks: string): string {
	return [
		"---",
		"HARNESS HANDOFF (read this):",
		"- You have read AND write tools, but you NEVER touch source code: you report problems, you do not fix them.",
		hasOverallPlan
			? "- Judge the change against BOTH the overall plan AND the current task slice provided above: does it advance the roadmap, honor its decisions, and complete the slice?"
			: "- Judge the change against the current task slice provided above.",
		`- Write your COMPLETE verdict as a full markdown document to this exact file with the write tool: ${verdictPath}`,
		"- The verdict file must follow your output contract above (Verdict + per-criterion findings with file:line + severity + concrete fix + test excerpts). Make it a standalone report, not a summary.",
		`- To run checks, use the run_check tool. Allowed checks ONLY: ${verifyChecks}.`,
		"  (Anything outside that set is refused. There is no general shell.)",
		"- Load surrounding code from the repo with read/grep/find/ls as needed; do not dump the repo.",
		"- The ONLY file you may write is the verdict file above. Do not write or edit anything else.",
		"- AFTER the file is written, your final message must be a line exactly `## SUMMARY` whose FIRST token is PASS, or `PASS WITH NITS`, or FAIL, followed by AT MOST 10 lines of the key findings. Nothing else after it.",
		"- The harness reads the file you wrote and surfaces only the SUMMARY to the main session.",
	].join("\n");
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

// Turn an operator-supplied feature name into a safe, stable file slug.
function slugify(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

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
// Subprocess plumbing (canonical subagent pattern)
// ---------------------------------------------------------------------------

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

interface SubagentResult {
	exitCode: number;
	finalText: string;
	stopReason?: string;
	errorMessage?: string;
	stderr: string;
	turns: number;
}

interface RunSubagentOptions {
	repoRoot: string;
	agentsPath: string;
	promptBodyPath: string;
	tools: string;
	runnerPath?: string;
	/** Phase 0.5: per-role model id (e.g. MODEL_DEFAULT / MODEL_REVIEW). Omit to inherit the operator's default. */
	model?: string;
	/** Phase 0.5: thinking level; defaults to EFFORT ("xhigh"). */
	thinking?: string;
	userTurn: string;
	onProgress?: (turns: number, lastTool: string | undefined) => void;
}

async function runSubagent(opts: RunSubagentOptions): Promise<SubagentResult> {
	// Build the stable system-prompt addition: AGENTS.md brief + methodology body.
	// Appended to Pi's default prompt (per the chosen "append to default" mode).
	const brief = readIfExists(opts.agentsPath) ?? "";
	const body = readIfExists(opts.promptBodyPath) ?? "";
	const combined = `${brief.trim()}\n\n---\n\n${body.trim()}\n`;

	const args: string[] = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"-nc", // no AGENTS.md/CLAUDE.md auto-load: we inject the brief explicitly
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-extensions", // do not re-enter this extension or any ambient one
	];
	if (opts.runnerPath) args.push("-e", opts.runnerPath); // explicit -e still loads under --no-extensions
	args.push("--append-system-prompt", combined);
	if (opts.model) args.push("--model", opts.model); // Phase 0.5: per-role model
	args.push("--thinking", opts.thinking ?? EFFORT); // Phase 0.5: xhigh by default
	args.push("--tools", opts.tools);
	args.push(opts.userTurn); // positional prompt = first (only) user turn

	const result: SubagentResult = {
		exitCode: 0,
		finalText: "",
		stderr: "",
		turns: 0,
	};

	await new Promise<void>((resolve) => {
		const inv = getPiInvocation(args);
		const proc = spawn(inv.command, inv.args, {
			cwd: opts.repoRoot,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buffer = "";

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const msg = event.message;
				result.turns++;
				let text = "";
				let lastTool: string | undefined;
				for (const part of msg.content ?? []) {
					if (part.type === "text") text += part.text;
					else if (part.type === "toolCall") lastTool = part.name;
				}
				if (text.trim()) result.finalText = text; // keep the latest substantive assistant text
				if (msg.stopReason) result.stopReason = msg.stopReason;
				if (msg.errorMessage) result.errorMessage = msg.errorMessage;
				opts.onProgress?.(result.turns, lastTool);
			}
		};

		proc.stdout.on("data", (d) => {
			buffer += d.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const l of lines) processLine(l);
		});
		proc.stderr.on("data", (d) => {
			result.stderr += d.toString();
		});
		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			result.exitCode = code ?? 0;
			resolve();
		});
		proc.on("error", (err) => {
			result.stderr += `\n[spawn error] ${err.message}`;
			result.exitCode = 1;
			resolve();
		});
	});
	return result;
}

function subagentFailed(r: SubagentResult): boolean {
	return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted" || !r.finalText.trim();
}

// ---------------------------------------------------------------------------
// SUMMARY extraction (only this crosses back into the main session)
// ---------------------------------------------------------------------------

function extractSummary(text: string, maxLines: number): string {
	const re = /^[ \t]*#{1,6}[ \t]*SUMMARY\b.*$/gim;
	let lastIdx = -1;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) lastIdx = m.index + m[0].length;

	let body: string;
	if (lastIdx >= 0) {
		body = text.slice(lastIdx);
	} else {
		// No SUMMARY block emitted — fall back to the first non-empty lines.
		body = text;
	}
	const lines = body
		.split("\n")
		.map((l) => l.replace(/\s+$/, ""))
		.filter((l, i) => !(i === 0 && l.trim() === ""));
	// trim leading blank lines
	while (lines.length && lines[0].trim() === "") lines.shift();
	const trimmed = lines.slice(0, maxLines);
	while (trimmed.length && trimmed[trimmed.length - 1].trim() === "") trimmed.pop();
	const out = trimmed.join("\n").trim();
	return out || "(subagent produced no summary)";
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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export default function subagents(pi: ExtensionAPI) {
	pi.registerCommand("plan", {
		description:
			"Planner subagent (isolated) -> writes overall memory/plan-<feature>.md + memory/tasks.md, returns a <=10-line summary",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const raw = args.trim();
			// Syntax: /plan <feature> <task description...>
			// The first whitespace-delimited token names the feature (scopes the overall plan file).
			const firstSpace = raw.search(/\s/);
			const featureRaw = firstSpace === -1 ? raw : raw.slice(0, firstSpace);
			const task = firstSpace === -1 ? "" : raw.slice(firstSpace + 1).trim();
			const slug = slugify(featureRaw);
			if (!slug || !task) {
				ctx.ui.notify('Usage: /plan <feature-name> <task description>  (e.g. /plan health-endpoint add a /health route)', "warning");
				return;
			}
			const repo = findRepoRoot(ctx.cwd);
			if (!repo) {
				ctx.ui.notify(
					"Not inside the harness repo (need harness/prompts/plan.md + memory/MEMORY.md above cwd).",
					"error",
				);
				return;
			}

			const planPath = planFilePath(repo, slug);
			const existingPlan = readIfExists(planPath);
			const isNewFeature = !existingPlan || !existingPlan.trim();

			const memory = readIfExists(repo.memory) ?? "(memory/MEMORY.md missing)";
			const prevTasks = readIfExists(repo.tasks) ?? "(none yet)";
			const userTurn = [
				"# Current memory index (memory/MEMORY.md)",
				memory,
				"---",
				`# Feature: ${slug}`,
				isNewFeature
					? `(no existing overall plan at memory/plan-${slug}.md — this is a NEW feature)`
					: `# Existing overall plan (memory/plan-${slug}.md — UPDATE/EXTEND this)\n\n${existingPlan}`,
				"---",
				"# Current memory/tasks.md (previous task slice, for reference)",
				prevTasks,
				"---",
				"# TASK TO PLAN (the next slice to work on)",
				task,
				"",
				handoffPlan(planPath, repo.tasks, isNewFeature),
			].join("\n\n");

			ctx.ui.setStatus("subagents", "planner: starting…");
			const tasksSigBefore = fileSig(repo.tasks);
			const planSigBefore = fileSig(planPath);
			let res: SubagentResult;
			try {
				res = await runSubagent({
					repoRoot: repo.root,
					agentsPath: repo.agents,
					promptBodyPath: repo.planPrompt,
					tools: "read,grep,find,ls,write",
					model: MODEL_DEFAULT, // Phase 0.5: Planner runs on Opus 4.8 (xhigh)
					userTurn,
					onProgress: (turns, lastTool) =>
						ctx.ui.setStatus("subagents", `planner: turn ${turns}${lastTool ? ` (${lastTool})` : ""}…`),
				});
			} finally {
				ctx.ui.setStatus("subagents", "");
			}

			if (subagentFailed(res)) {
				const why = res.errorMessage || res.stopReason || res.stderr.trim() || "no output";
				ctx.ui.notify(`Planner failed: ${why}`, "error");
				pi.sendMessage(
					{
						customType: "subagent-plan",
						content: `Planner FAILED (${res.stopReason ?? `exit ${res.exitCode}`}): ${why}`,
						display: true,
					},
					{ deliverAs: "nextTurn" },
				);
				return;
			}

			// The planner writes both files itself (write tool). Only fall back to persisting
			// the returned text into tasks.md if it did not write that file.
			const wroteTasks = fileSig(repo.tasks) !== tasksSigBefore && (readIfExists(repo.tasks)?.trim()?.length ?? 0) > 0;
			if (!wroteTasks) {
				fs.writeFileSync(repo.tasks, res.finalText.endsWith("\n") ? res.finalText : `${res.finalText}\n`, "utf-8");
			}
			const wrotePlan = fileSig(planPath) !== planSigBefore && (readIfExists(planPath)?.trim()?.length ?? 0) > 0;
			writeActivePlan(repo, slug);

			const summary = extractSummary(res.finalText, 10);
			const planNote = wrotePlan
				? `Overall plan -> memory/plan-${slug}.md`
				: `WARNING: planner did not write memory/plan-${slug}.md`;
			pi.sendMessage(
				{
					customType: "subagent-plan",
					content: `Planner summary (feature: ${slug}, ${res.turns} turns):\n\n${summary}\n\n${planNote}\nTask slice -> memory/tasks.md`,
					display: true,
				},
				{ deliverAs: "nextTurn" },
			);
			ctx.ui.notify(
				`Plan written: memory/plan-${slug}.md + memory/tasks.md`,
				wrotePlan ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("verify", {
		description: "Verifier subagent (allowlisted runner, isolated) -> writes its own memory/verdict.md, returns PASS/FAIL",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const repo = findRepoRoot(ctx.cwd);
			if (!repo) {
				ctx.ui.notify(
					"Not inside the harness repo (need harness/prompts/verify-change.md + memory/MEMORY.md above cwd).",
					"error",
				);
				return;
			}
			const tasks = readIfExists(repo.tasks);
			if (!tasks || !tasks.trim()) {
				ctx.ui.notify("No memory/tasks.md to verify against — run /plan first.", "error");
				return;
			}

			// Resolve which overall plan to check against. Syntax: /verify [feature] [note...]
			// If the first token names an existing plan-<feature>.md, use it (and strip it from
			// the note). Otherwise fall back to the active plan recorded by the last /plan.
			const rawArgs = args.trim();
			const tokens = rawArgs.length ? rawArgs.split(/\s+/) : [];
			let slug: string | undefined;
			let note = rawArgs;
			if (tokens.length) {
				const maybe = slugify(tokens[0]);
				if (maybe && fs.existsSync(planFilePath(repo, maybe))) {
					slug = maybe;
					note = tokens.slice(1).join(" ").trim();
				}
			}
			if (!slug) {
				const active = readActivePlan(repo);
				if (active && fs.existsSync(planFilePath(repo, active))) {
					slug = active;
				} else {
					const all = listPlanSlugs(repo);
					if (all.length === 1) slug = all[0];
				}
			}
			const overallPlan = slug ? readIfExists(planFilePath(repo, slug)) : undefined;
			const hasOverallPlan = !!overallPlan?.trim();

			const memory = readIfExists(repo.memory) ?? "(memory/MEMORY.md missing)";
			const { text: diff, label: diffLabel } = computeDiff(repo.root);
			const userTurn = [
				"# Current memory index (memory/MEMORY.md)",
				memory,
				"---",
				...(hasOverallPlan
					? [`# Overall plan for this feature (memory/plan-${slug}.md)`, overallPlan as string, "---"]
					: []),
				"# Current task slice / done-condition (memory/tasks.md)",
				tasks,
				"---",
				`# Change under review (${diffLabel})`,
				"```diff",
				diff,
				"```",
				...(note ? ["---", `# Reviewer note from operator`, note] : []),
				"",
				handoffVerify(repo.verdict, hasOverallPlan, listVerifyChecks(repo.root)),
			].join("\n\n");

			ctx.ui.setStatus("subagents", "verifier: starting…");
			const sigBefore = fileSig(repo.verdict);
			let res: SubagentResult;
			try {
				res = await runSubagent({
					repoRoot: repo.root,
					agentsPath: repo.agents,
					promptBodyPath: repo.verifyPrompt,
					tools: "read,grep,find,ls,run_check,write",
					runnerPath: RUNNER_PATH,
					model: MODEL_REVIEW, // Phase 0.5: Verifier (reviewer class) runs on GPT-5.5 (xhigh)
					userTurn,
					onProgress: (turns, lastTool) =>
						ctx.ui.setStatus("subagents", `verifier: turn ${turns}${lastTool ? ` (${lastTool})` : ""}…`),
				});
			} finally {
				ctx.ui.setStatus("subagents", "");
			}

			if (subagentFailed(res)) {
				const why = res.errorMessage || res.stopReason || res.stderr.trim() || "no output";
				ctx.ui.notify(`Verifier failed: ${why}`, "error");
				pi.sendMessage(
					{
						customType: "subagent-verify",
						content: `Verifier FAILED (${res.stopReason ?? `exit ${res.exitCode}`}): ${why}`,
						display: true,
					},
					{ deliverAs: "nextTurn" },
				);
				return;
			}

			// The verifier writes memory/verdict.md itself (write tool). Fall back to
			// persisting its returned text only if it did not actually write the file.
			const wroteItself = fileSig(repo.verdict) !== sigBefore && (readIfExists(repo.verdict)?.trim()?.length ?? 0) > 0;
			if (!wroteItself) {
				fs.writeFileSync(repo.verdict, res.finalText.endsWith("\n") ? res.finalText : `${res.finalText}\n`, "utf-8");
			}
			const summary = extractSummary(res.finalText, 10);
			const verdictWord = /\bFAIL\b/i.test(summary.split("\n")[0]) ? "FAIL" : "PASS";
			pi.sendMessage(
				{
					customType: "subagent-verify",
					content: `Verifier verdict (${res.turns} turns):\n\n${summary}\n\nFull verdict -> memory/verdict.md`,
					display: true,
					details: { verdict: verdictWord },
				},
				{ deliverAs: "nextTurn" },
			);
			ctx.ui.notify(`Verifier: ${verdictWord} — written to memory/verdict.md`, verdictWord === "FAIL" ? "warning" : "info");
		},
	});
}
