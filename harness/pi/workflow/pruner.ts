/**
 * workflow/pruner — the runJudge-backed right-sizer (memory/plan-workflow.md, slice 1). IMPURE (spawns
 * the single-shot judge), so it lives apart from the pure, bare-node-testable `right-size.ts`. Runs the
 * right-sizer ONLY at tasks.length ≥ judgeThreshold (below it the baseline clamp is fine), parses
 * leniently, and **fails OPEN to the clamp** — a governor shrinks, it doesn't block. ALWAYS clamps to
 * maxParallel, even on a successful reply (MAJOR-3). On MODEL_REVIEW per D7 (judgeModel overrides).
 * Integration-tested live (slice 4), not in unit tests.
 */

import { EFFORT, MODEL_REVIEW, runJudge } from "../shared/subagent-core.js";
import { buildRightSizerUserTurn, clampKept, parseRightSizerReply, RIGHT_SIZER_SYSTEM_PROMPT } from "./right-size.js";

export interface RightSizeResult {
	kept: string[];
	rationale: string;
	judged: boolean;
}

export async function rightSize(
	objective: string,
	tasks: string[],
	cfg: { maxParallel: number; useJudge: boolean; judgeThreshold: number; judgeModel: string; timeoutMs: number },
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<RightSizeResult> {
	// Baseline: below the threshold (or judge disabled) the agent's own priority order makes a blind clamp
	// fine — the judge (~1 worker's cost at MODEL_REVIEW) would be pure overhead.
	if (!cfg.useJudge || tasks.length < cfg.judgeThreshold) {
		return {
			kept: clampKept(tasks, cfg.maxParallel),
			rationale: cfg.useJudge
				? `${tasks.length} task(s) < judgeThreshold ${cfg.judgeThreshold}: baseline clamp to ${cfg.maxParallel}`
				: `useJudge=false: baseline clamp to ${cfg.maxParallel}`,
			judged: false,
		};
	}
	const outcome = await runJudge({
		cwd,
		model: cfg.judgeModel || MODEL_REVIEW, // D7
		thinking: EFFORT,
		systemPrompt: RIGHT_SIZER_SYSTEM_PROMPT,
		userTurn: buildRightSizerUserTurn(objective, tasks, cfg.maxParallel),
		timeoutMs: cfg.timeoutMs,
		signal,
	});
	if (outcome.failed) {
		return { kept: clampKept(tasks, cfg.maxParallel), rationale: `right-sizer unavailable (${outcome.why}); fell open to clamp ${cfg.maxParallel}`, judged: true };
	}
	const parsed = parseRightSizerReply(outcome.text);
	if (!parsed) {
		return { kept: clampKept(tasks, cfg.maxParallel), rationale: `right-sizer reply unparseable; fell open to clamp ${cfg.maxParallel}`, judged: true };
	}
	// ALWAYS clamp — even a successful reply (an injected/over-eager "keep all" can't exceed maxParallel).
	return { kept: clampKept(parsed, cfg.maxParallel), rationale: `right-sizer kept ${Math.min(parsed.length, cfg.maxParallel)} of ${tasks.length}`, judged: true };
}
