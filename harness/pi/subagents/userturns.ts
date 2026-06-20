/**
 * Pure, dependency-free builders for the six sub-agent roles: the slug helper, the per-role
 * `handoff*` contracts, and the per-role first-user-turn assembly.
 *
 * Extracted from index.ts so BOTH entry paths (the `/plan …` command handlers AND the model-callable
 * `subagent_*` tools — see the dual-mode plan, memory/plan-subagent-dual-mode.md) build byte-identical
 * prompts, and so the assembly is unit-testable OFFLINE. This module imports NOTHING (no pi types, no
 * `../shared/*.js` specifiers): that keeps `node --test` able to import it directly (the `.js`→`.ts`
 * specifier remap used elsewhere in the repo is a jiti/Bundler behavior bare `node --test` doesn't do).
 *
 * Nothing here touches the filesystem, git, or a model — callers read files / compute diffs and pass
 * the resulting strings in. Keep these functions pure.
 */

// Turn an operator-supplied feature/topic name into a safe, stable file slug.
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

// ---------------------------------------------------------------------------
// Per-role handoff contracts (the terminal "write exactly one file / reply only ## SUMMARY" block
// appended to each first user turn). Pure string assembly.
// ---------------------------------------------------------------------------

export function handoffPlan(planPath: string, tasksPath: string, isNewFeature: boolean): string {
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

export function handoffVerify(verdictPath: string, hasOverallPlan: boolean, verifyChecks: string): string {
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

export function handoffTriage(triagePath: string, verifyChecks: string): string {
	return [
		"---",
		"HARNESS HANDOFF (read this):",
		"- You have read AND write tools + the run_check probe tool, but you NEVER touch source code: you diagnose, you do not fix.",
		`- Write your COMPLETE triage as a markdown document to this exact file with the write tool: ${triagePath}`,
		"- Follow your output contract above (Failure · ranked Hypotheses with file:line evidence · ONE next probe · Ruled out). Make it a standalone report.",
		`- To gather evidence, use the run_check tool. Allowed checks ONLY: ${verifyChecks}.`,
		"  (Anything outside that set is refused. There is no general shell.)",
		"- Use probes to CONFIRM hypotheses, never to try fixes. Load surrounding code with read/grep/find/ls; do not dump the repo.",
		"- The ONLY file you may write is the triage file above. Do not write or edit anything else.",
		"- AFTER the file is written, your final message must be a line exactly `## SUMMARY` whose FIRST token is the top hypothesis label (an uppercase tag), followed by AT MOST 10 lines. Nothing else after it.",
		"- The harness reads the file you wrote and surfaces only the SUMMARY to the main session.",
	].join("\n");
}

export function handoffMonitor(reportPath: string, expName: string, runId: string, logRel: string): string {
	return [
		"---",
		"HARNESS HANDOFF (read this):",
		"- You have read AND write tools + the run_experiment tool. You did NOT write this experiment; do not try to make it pass — report what actually happened.",
		`- Launch the experiment EXACTLY once: run_experiment({ experiment: "${expName}", runId: "${runId}" }) — pass BOTH args verbatim. There is no shell; you cannot change the command.`,
		`- Watch the streamed output (already redacted). The full stream is tee'd to ${logRel}; cite every error as ${logRel}:<line>.`,
		`- Write your COMPLETE report as a markdown document to this exact file with the write tool: ${reportPath}`,
		"- Report sections: Command (exact argv) · Duration (and whether it hit the cap) · Exit status · Detected errors (each with a log:line citation + excerpt + classification) · Verdict GREEN or RED. Make it standalone.",
		"- The ONLY file you may write is the report file above. Do NOT write or edit anything else (NOT memory/MEMORY.md). If you found a durable lesson (a real flaky signature), name it in your SUMMARY.",
		"- AFTER the file is written, your final message must be a line exactly `## SUMMARY` whose FIRST token is OK or ERROR, followed by AT MOST 10 lines. Nothing else after it.",
		"- The harness reads the file you wrote and surfaces only the SUMMARY to the main session.",
	].join("\n");
}

export function handoffResearch(researchPath: string): string {
	return [
		"---",
		"HARNESS HANDOFF (read this):",
		"- You have read AND write tools + web_search + fetch_content. You touch the WEB, never the repo's code or executables.",
		`- Write your COMPLETE note as a markdown document to this exact file with the write tool: ${researchPath}`,
		"- Corroborate: a claim is VERIFIED only with >=2 independent, primary-leaning sources; one source = UNCERTAIN; conflicting = DISPUTED. Fetch a page before citing it; never cite a search snippet.",
		"- Output per your contract: a Verdict line, then `## Findings` (each claim tagged [VERIFIED|UNCERTAIN|DISPUTED — ref]), `## Open questions`, and a numbered `## Sources` (title — url — accessed date). Every inline ref must resolve in Sources.",
		"- The ONLY file you may write is the note above. Do NOT write or edit anything else (NOT memory/MEMORY.md).",
		"- If web_search is unavailable (pi-web-access not installed), say so and return INCONCLUSIVE — do not invent sources.",
		"- AFTER the file is written, your final message must be a line exactly `## SUMMARY` whose FIRST token is CONFIDENT, MIXED, or INCONCLUSIVE, followed by AT MOST 10 lines. Nothing else after it.",
		"- The harness reads the file you wrote and surfaces only the SUMMARY to the main session.",
	].join("\n");
}

export function handoffReport(reportPath: string, audience: string): string {
	return [
		"---",
		"HARNESS HANDOFF (read this):",
		"- You have read AND write tools. You compose; you run nothing and you fix nothing.",
		`- Write your COMPLETE report as a polished markdown document to this exact file with the write tool: ${reportPath}`,
		`- Audience: ${audience}. Tune register/length to it (team: result + next steps; paper: neutral, method+limits forward, no first person; self: terse lab-notebook).`,
		"- Lead with the result; quantify every claim; cite each figure as file:line / log:line into the artifacts above; be honest about caveats; no marketing fluff.",
		"- Load more detail from the cited artifacts with read/grep as needed. If you can't cite it, don't claim it.",
		"- The ONLY file you may write is the report file above. Do NOT write or edit anything else (NOT memory/MEMORY.md). If a durable lesson emerged, name it in your SUMMARY.",
		"- AFTER the file is written, your final message must be a line exactly `## SUMMARY` followed by AT MOST 10 lines: the one-line headline result, the 2–4 facts a reader most needs, then the report path. Nothing else after it.",
		"- The harness reads the file you wrote and surfaces only the SUMMARY; the DOCUMENT is the deliverable and lives on disk.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Per-role first-user-turn assembly. Each mirrors the original inline construction in index.ts
// EXACTLY (same sections, same order, same `\n\n` join) — extracted verbatim so command-mode and
// tool-mode produce identical prompts. Callers pass already-read strings (memory index, diff, etc.).
// ---------------------------------------------------------------------------

export interface PlanTurnInput {
	memory: string;
	slug: string;
	isNewFeature: boolean;
	existingPlan: string;
	prevTasks: string;
	task: string;
	planPath: string;
	tasksPath: string;
}

export function buildPlanUserTurn(p: PlanTurnInput): string {
	return [
		"# Current memory index (memory/MEMORY.md)",
		p.memory,
		"---",
		`# Feature: ${p.slug}`,
		p.isNewFeature
			? `(no existing overall plan at memory/plan-${p.slug}.md — this is a NEW feature)`
			: `# Existing overall plan (memory/plan-${p.slug}.md — UPDATE/EXTEND this)\n\n${p.existingPlan}`,
		"---",
		"# Current memory/tasks.md (previous task slice, for reference)",
		p.prevTasks,
		"---",
		"# TASK TO PLAN (the next slice to work on)",
		p.task,
		"",
		handoffPlan(p.planPath, p.tasksPath, p.isNewFeature),
	].join("\n\n");
}

export interface VerifyTurnInput {
	memory: string;
	hasOverallPlan: boolean;
	slug?: string;
	overallPlan?: string;
	tasks: string;
	diffLabel: string;
	diff: string;
	note: string;
	verdictPath: string;
	verifyChecks: string;
}

export function buildVerifyUserTurn(p: VerifyTurnInput): string {
	return [
		"# Current memory index (memory/MEMORY.md)",
		p.memory,
		"---",
		...(p.hasOverallPlan
			? [`# Overall plan for this feature (memory/plan-${p.slug}.md)`, p.overallPlan as string, "---"]
			: []),
		"# Current task slice / done-condition (memory/tasks.md)",
		p.tasks,
		"---",
		`# Change under review (${p.diffLabel})`,
		"```diff",
		p.diff,
		"```",
		...(p.note ? ["---", `# Reviewer note from operator`, p.note] : []),
		"",
		handoffVerify(p.verdictPath, p.hasOverallPlan, p.verifyChecks),
	].join("\n\n");
}

export interface TriageTurnInput {
	memory: string;
	slug: string;
	logText: string;
	logLabel: string;
	note: string;
	triagePath: string;
	verifyChecks: string;
}

export function buildTriageUserTurn(p: TriageTurnInput): string {
	return [
		"# Current memory index (memory/MEMORY.md)",
		p.memory,
		"---",
		`# Triage id: ${p.slug}`,
		...(p.logText ? ["---", `# Failing log (${p.logLabel})`, "```", p.logText, "```"] : []),
		...(p.note ? ["---", "# Operator note", p.note] : []),
		"",
		handoffTriage(p.triagePath, p.verifyChecks),
	].join("\n\n");
}

export interface MonitorTurnInput {
	memory: string;
	expName: string;
	exp: { cmd: string; args: string[]; timeoutMs: number };
	run: string;
	logRel: string;
	note: string;
	reportPath: string;
}

export function buildMonitorUserTurn(p: MonitorTurnInput): string {
	return [
		"# Current memory index (memory/MEMORY.md)",
		p.memory,
		"---",
		`# Experiment to run: ${p.expName}`,
		"```",
		`${p.exp.cmd} ${p.exp.args.join(" ")}`,
		"```",
		`(fixed command from harness/checks.json — you cannot change it; timeout ${Math.round(p.exp.timeoutMs / 1000)}s)`,
		`# Run id (pass this verbatim as run_experiment's runId): ${p.run}`,
		`(per-run log will be at ${p.logRel})`,
		...(p.note ? ["---", "# Operator note", p.note] : []),
		"",
		handoffMonitor(p.reportPath, p.expName, p.run, p.logRel),
	].join("\n\n");
}

export interface ReportTurnInput {
	memory: string;
	slug: string;
	audience: string;
	sources: { label: string; content: string }[];
	diffLabel: string;
	diff: string;
	logLabel: string;
	gitlog: string;
	reportPath: string;
}

export function buildReportUserTurn(p: ReportTurnInput): string {
	return [
		"# Current memory index (memory/MEMORY.md)",
		p.memory,
		"---",
		`# Report subject: ${p.slug}  (audience: ${p.audience})`,
		...p.sources.flatMap((s) => ["---", `# Source: ${s.label}`, s.content]),
		"---",
		`# Change under review (${p.diffLabel})`,
		"```diff",
		p.diff,
		"```",
		"---",
		`# Recent commits (${p.logLabel})`,
		"```",
		p.gitlog,
		"```",
		"",
		handoffReport(p.reportPath, p.audience),
	].join("\n\n");
}

export interface ResearchTurnInput {
	memory: string;
	slug: string;
	question: string;
	researchPath: string;
}

export function buildResearchUserTurn(p: ResearchTurnInput): string {
	return [
		"# Current memory index (memory/MEMORY.md)",
		p.memory,
		"---",
		`# Research topic: ${p.slug}`,
		"---",
		"# QUESTION TO RESEARCH",
		p.question,
		"",
		handoffResearch(p.researchPath),
	].join("\n\n");
}
