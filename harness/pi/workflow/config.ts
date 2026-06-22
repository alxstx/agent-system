/**
 * workflow/config — PURE, OFFLINE parse of the `workflow` block (memory/plan-workflow.md, slice 1).
 * verdict.ts rigor (NOT loadConfig laxity, R5-MAJOR): every numeric is clamped to [1, ceiling] (so an
 * `maxParallel: 500` can't nullify the cost governor and `concurrency: 0` can't hang the pool), booleans
 * are typed, and a non-object / array block is inert (`{}` = active-with-defaults; `workflow: []` must NOT
 * activate). The checks.json root is resolved by `findChecksRoot` (shared with delegate — workflow
 * depends on delegate), so the block, the worker reads, and the `memory/workflow/` writes share one root.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// Parent-walk to the dir holding the nearest harness/checks.json (the "workflow root"), or undefined.
// Inlined (not imported from delegate) so this module imports only node:* and stays bare-node unit-testable
// — the same standalone-module pattern checks-core/redact/delegate each follow for their own root walk.
export function findChecksRoot(cwd: string): string | undefined {
	let dir = path.resolve(cwd);
	for (;;) {
		if (fs.existsSync(path.join(dir, "harness", "checks.json"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export interface WorkflowConfig {
	/** Hard cap on kept tasks / total spawns — the cost-governor kill-switch. Clamped [1, MAX_PARALLEL_CEILING]. */
	maxParallel: number;
	/** Worker processes run at once. Clamped [1, maxParallel]. */
	concurrency: number;
	/** Workflow tool-calls allowed per main-agent request (reset on agent_start). Clamped [1, 10]. */
	maxWorkflowsPerRequest: number;
	/** Run the LLM right-sizer (else baseline clamp only). */
	useJudge: boolean;
	/** Run the right-sizer only when tasks.length ≥ this (below it the clamp is fine). Default 2×maxParallel. */
	judgeThreshold: number;
	/** Override MODEL_REVIEW for the right-sizer; "" → MODEL_REVIEW (D7). */
	judgeModel: string;
	/** Run one extra synth subagent over the (already-redacted) result files. Default false. */
	synthesize: boolean;
	/** Cap incoming tasks[] BEFORE the right-sizer (so a 500-element array can't bloat its prompt). Clamped [1, 200]. */
	maxInputTasks: number;
	/** Per-worker result-file byte cap (byte-honest). Clamped [1, 262144]. */
	maxResultBytes: number;
	/** Per-worker wall-clock timeout (ms). Clamped [1, TIMEOUT_CEILING]. */
	timeoutMs: number;
}

// LOCKED defaults + ceilings (Decision 5/7). maxParallel's ceiling is the governor's kill-switch.
const MAX_PARALLEL_CEILING = 8;
const DEFAULT_MAX_PARALLEL = 5;
const DEFAULT_MAX_WORKFLOWS = 2;
const MAX_WORKFLOWS_CEILING = 10;
const JUDGE_THRESHOLD_CEILING = 200;
const DEFAULT_MAX_INPUT_TASKS = 30;
const MAX_INPUT_TASKS_CEILING = 200;
const DEFAULT_MAX_RESULT_BYTES = 32 * 1024;
const MAX_RESULT_BYTES_CEILING = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 600_000
const TIMEOUT_CEILING_MS = 30 * 60 * 1000; // 1_800_000

// Clamp to [1, ceiling]; a non-number / non-finite value falls back to `def` — and the DEFAULT is
// clamped too (so e.g. concurrency's default 5 collapses to maxParallel when maxParallel < 5).
function clampInt(v: unknown, def: number, ceil: number): number {
	const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : def;
	return Math.min(Math.max(n, 1), ceil);
}

export function withWorkflowDefaults(a: Record<string, unknown>): WorkflowConfig {
	const maxParallel = clampInt(a.maxParallel, DEFAULT_MAX_PARALLEL, MAX_PARALLEL_CEILING);
	return {
		maxParallel,
		concurrency: clampInt(a.concurrency, DEFAULT_MAX_PARALLEL, maxParallel), // ceiling = maxParallel
		maxWorkflowsPerRequest: clampInt(a.maxWorkflowsPerRequest, DEFAULT_MAX_WORKFLOWS, MAX_WORKFLOWS_CEILING),
		useJudge: typeof a.useJudge === "boolean" ? a.useJudge : true,
		judgeThreshold: clampInt(a.judgeThreshold, 2 * maxParallel, JUDGE_THRESHOLD_CEILING), // default 2×maxParallel
		judgeModel: typeof a.judgeModel === "string" ? a.judgeModel.trim() : "",
		synthesize: typeof a.synthesize === "boolean" ? a.synthesize : false,
		maxInputTasks: clampInt(a.maxInputTasks, DEFAULT_MAX_INPUT_TASKS, MAX_INPUT_TASKS_CEILING),
		maxResultBytes: clampInt(a.maxResultBytes, DEFAULT_MAX_RESULT_BYTES, MAX_RESULT_BYTES_CEILING),
		timeoutMs: clampInt(a.timeoutMs, DEFAULT_TIMEOUT_MS, TIMEOUT_CEILING_MS),
	};
}

// Read the `workflow` block from the nearest harness/checks.json. Fail-safe on a malformed nearest file
// (returns undefined; not walked past). non-object / array → inert; `{}` → active-with-defaults.
export function loadWorkflowConfig(cwd: string): WorkflowConfig | undefined {
	const root = findChecksRoot(cwd);
	if (!root) return undefined;
	try {
		const w = JSON.parse(fs.readFileSync(path.join(root, "harness", "checks.json"), "utf-8"))?.workflow;
		return w && typeof w === "object" && !Array.isArray(w) ? withWorkflowDefaults(w) : undefined;
	} catch {
		return undefined;
	}
}
