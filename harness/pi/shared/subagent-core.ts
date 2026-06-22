/**
 * Shared subagent core — the ONE implementation of "spawn an isolated pi subagent subprocess".
 *
 * Extracted from subagents/index.ts (the 6 human-invoked roles) so the SAME plumbing serves:
 *   - the 6 roles (/plan /verify /triage /monitor /report /research), and
 *   - the model-callable tools `delegate` (memory/plan-general-subagent.md) and
 *     `workflow` (memory/plan-workflow.md), which reuse this worker core directly.
 * auto-judge's single-shot judge also re-invokes pi via the SAME getPiInvocation (its local copy is
 * deleted in favour of this one), so the re-invocation logic can never drift across call sites.
 *
 * Also hosts the cross-cutting safety helpers both new tools need (so neither re-implements them):
 *   - cleanDetails  — enforce the metadata-only `details` rule (secret-redaction never scrubs details).
 *   - redactOnWrite — redact at the source before any fs write (disk writes bypass the redaction hook).
 *   - a live-children Set + registerShutdownGuard(pi) — SIGTERM→SIGKILL spawned children on
 *     session_shutdown (/reload|quit mid-execute orphans them otherwise; ctx.signal covers only abort).
 *
 * registerShutdownGuard is an EXPORTED function the FACTORY calls — NOT a top-level pi.on — so this
 * module stays side-effect-free and safe to import from an `-e`-loaded worker.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Per-role model & thinking policy (one place; don't scatter ids). Reviewing/adversarial-judge agents
// (/verify, auto-judge, the workflow right-sizer) run on GPT-5.5 (MODEL_REVIEW per decisions.md D7);
// every other sub-agent — and the delegate/workflow WORKERS — runs on Opus 4.8 (MODEL_DEFAULT), both
// at "xhigh" thinking.
//
// POLICY (owner decision): every model resolves through the GitHub Copilot login — the ids are
// fully-qualified `github-copilot/<id>`. NO direct-provider-qualified ids anywhere (those resolve to the
// direct provider and need separate keys). The repo-wide guard (harness/pi/model-id-guard.test.ts)
// enforces this. To switch the model, edit ONLY the two constants below.
//
// LIVE FLAG (2026-06-21): these exact strings are UNVERIFIED. `pi --list-models` on the dev node shows
// only `anthropic` + `ollama` providers (no `github-copilot`), so the Copilot catalog ids could not be
// confirmed — including the id FORMAT (here `claude-opus-4.8` dotted; the live anthropic catalog uses the
// dashed `claude-opus-4-8`, and Copilot's spelling may differ). Confirm both via `pi --list-models` on a
// Copilot-authenticated node and correct these two lines if the catalog differs.
export const EFFORT = "xhigh";
export const MODEL_DEFAULT = "github-copilot/claude-opus-4.8"; // plan, monitor, triage, research, report, delegate/workflow workers
export const MODEL_REVIEW = "github-copilot/gpt-5.5"; // the reviewing/adversarial-judge agents (verify, auto-judge, right-sizer)

// ---------------------------------------------------------------------------
// Subprocess plumbing (canonical subagent pattern)
// ---------------------------------------------------------------------------

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
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

export interface SubagentResult {
	exitCode: number;
	finalText: string;
	stopReason?: string;
	errorMessage?: string;
	stderr: string;
	turns: number;
}

export interface RunSubagentOptions {
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
	/**
	 * Optional abort signal (delegate/workflow thread ctx.signal here so an operator abort kills the
	 * child). Net-new vs the 6 roles, which pass none and are byte-for-byte unaffected. Kills the child
	 * immediately if already aborted at entry (mirrors checks-core spawnFixed), else on the abort event.
	 */
	signal?: AbortSignal;
}

// Live spawned children, tracked module-wide so the shutdown guard can reclaim them on /reload|quit.
// A Set (not an array) so close/error can delete in O(1); shared across importers in one process.
const liveChildren = new Set<ChildProcess>();
let shutdownGuardRegistered = false;

/**
 * Register ONE session_shutdown handler that SIGTERM→SIGKILLs any still-live subagent children.
 * A tool's execute() runs DURING streaming, so a /reload or quit mid-call tears down the runtime with
 * children still burning tokens — ctx.signal covers operator-abort but NOT shutdown. The 6 roles run
 * inside command handlers (reload-mid-call isn't a normal path) and don't call this; delegate/workflow
 * factories do. Idempotent: multiple factories sharing this module register the handler only once.
 */
export function registerShutdownGuard(pi: ExtensionAPI): void {
	if (shutdownGuardRegistered) return;
	shutdownGuardRegistered = true;
	pi.on("session_shutdown", () => {
		const survivors = [...liveChildren];
		for (const child of survivors) {
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
		}
		// Escalate any that ignore SIGTERM; unref so this timer never keeps the process alive.
		setTimeout(() => {
			for (const child of survivors) {
				try {
					child.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			}
		}, 2000).unref?.();
	});
}

export async function runSubagent(opts: RunSubagentOptions): Promise<SubagentResult> {
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
		liveChildren.add(proc);

		// Operator-abort: SIGTERM the child (the shutdown guard owns the SIGTERM→SIGKILL ladder for
		// /reload|quit). Kill immediately if the signal is ALREADY aborted at entry.
		const onAbort = () => {
			try {
				proc.kill("SIGTERM");
			} catch {
				/* already gone */
			}
		};
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}
		const cleanup = () => {
			opts.signal?.removeEventListener("abort", onAbort);
			liveChildren.delete(proc);
		};

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
			cleanup();
			result.exitCode = code ?? 0;
			resolve();
		});
		proc.on("error", (err) => {
			cleanup();
			result.stderr += `\n[spawn error] ${err.message}`;
			result.exitCode = 1;
			resolve();
		});
	});
	return result;
}

export function subagentFailed(r: SubagentResult): boolean {
	return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted" || !r.finalText.trim();
}

// ---------------------------------------------------------------------------
// Single-shot judge subprocess (the auto-judge gate + the workflow right-sizer reuse this)
// ---------------------------------------------------------------------------
// Co-located with getPiInvocation (which it calls) so the two can't drift. The CALLER supplies the
// systemPrompt + parses the reply — this only spawns `pi … --no-tools` and returns the raw final text
// (auto-judge's ALLOW/DENY grammar and the workflow right-sizer's KEEP/MERGE grammar are NOT here).

export interface JudgeOutcome {
	text: string; // final assistant text (the verdict reply)
	failed: boolean; // spawn error / non-zero exit / timeout / no output
	why: string; // short reason when failed (for the block message / status)
}

export interface RunJudgeOptions {
	cwd: string;
	model: string;
	thinking: string;
	systemPrompt: string;
	userTurn: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

// Spawn the single-shot judge: same flag set as runSubagent plus `--no-tools` (cli/args.js: disables
// ALL tools — the judge decides from the prompt alone), with a hard timeout.
export async function runJudge(opts: RunJudgeOptions): Promise<JudgeOutcome> {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"-nc", // no AGENTS.md/CLAUDE.md auto-load
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-extensions", // judge cannot re-enter this hook or any ambient extension
		"--no-tools", // single-shot: no tool surface; judge from the provided context only
		"--append-system-prompt",
		opts.systemPrompt,
		"--model",
		opts.model,
		"--thinking",
		opts.thinking,
		opts.userTurn, // positional prompt = the only user turn
	];

	let finalText = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let exitCode = 0;
	let timedOut = false;
	let spawnErr = "";

	await new Promise<void>((resolve) => {
		const inv = getPiInvocation(args);
		// stderr is intentionally discarded, NOT surfaced: a judge subprocess error line could carry
		// file paths / credentials, and the block `reason` reaches the model's context. We report only
		// pi's structured errorMessage / stopReason / exit code instead (see the failure `why` below).
		const proc = spawn(inv.command, inv.args, { cwd: opts.cwd, shell: false, stdio: ["ignore", "pipe", "ignore"] });
		let buffer = "";
		let settled = false;
		let hardKillTimer: NodeJS.Timeout | undefined;
		const done = () => {
			if (!settled) {
				settled = true;
				resolve();
			}
		};

		const killTimer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGTERM");
			// Escalate to SIGKILL only if SIGTERM is ignored; cleared by cleanup() once the process closes.
			hardKillTimer = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			}, 2000);
			hardKillTimer.unref();
		}, opts.timeoutMs);

		const onAbort = () => proc.kill("SIGTERM"); // operator aborted the turn
		opts.signal?.addEventListener("abort", onAbort, { once: true }); // { once } auto-removes; cleanup() is belt-and-suspenders
		const cleanup = () => {
			clearTimeout(killTimer);
			if (hardKillTimer) clearTimeout(hardKillTimer);
			opts.signal?.removeEventListener("abort", onAbort);
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let ev: { type?: string; message?: { role?: string; content?: { type: string; text?: string }[]; stopReason?: string; errorMessage?: string } };
			try {
				ev = JSON.parse(line);
			} catch {
				return;
			}
			if (ev.type === "message_end" && ev.message?.role === "assistant") {
				let text = "";
				for (const part of ev.message.content ?? []) if (part.type === "text") text += part.text ?? "";
				if (text.trim()) finalText = text;
				if (ev.message.stopReason) stopReason = ev.message.stopReason;
				if (ev.message.errorMessage) errorMessage = ev.message.errorMessage;
			}
		};

		proc.stdout.on("data", (d) => {
			buffer += d.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const l of lines) processLine(l);
		});
		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			cleanup();
			exitCode = code ?? 0;
			done();
		});
		proc.on("error", (err) => {
			cleanup();
			spawnErr = err.message;
			exitCode = 1;
			done();
		});
	});

	if (timedOut) return { text: "", failed: true, why: `judge timed out after ${Math.round(opts.timeoutMs / 1000)}s` };
	if (spawnErr) return { text: "", failed: true, why: `spawn error: ${spawnErr}` };
	const failed = exitCode !== 0 || stopReason === "error" || stopReason === "aborted" || !finalText.trim();
	if (failed) {
		const why = errorMessage || stopReason || `exit ${exitCode}`;
		return { text: finalText, failed: true, why };
	}
	return { text: finalText, failed: false, why: "" };
}

// ---------------------------------------------------------------------------
// SUMMARY extraction (only this crosses back into the main session for the 6 roles)
// ---------------------------------------------------------------------------

export function extractSummary(text: string, maxLines: number): string {
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
// Cross-cutting safety helpers for the model-callable tools (delegate/workflow)
// ---------------------------------------------------------------------------

/**
 * Enforce the metadata-only `details` rule (delegate Decision 3 / R3-MAJOR). The secret-redaction
 * hook scrubs only a tool_result's `content`, never its `details` — so `details` reaches the model
 * UNREDACTED. A tool MUST therefore put only small, self-authored metadata here (turns/mode/model/
 * status), never worker-derived text. This keeps only primitive (string|number|boolean) values and
 * drops objects/arrays, so an accidental result blob can't be smuggled through the un-redacted channel.
 */
export function cleanDetails(meta: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(meta)) {
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
	}
	return out;
}

/**
 * Redact-at-the-source before a disk write (R3-BLOCKER). The secret-redaction tool_result hook NEVER
 * sees fs writes (it scrubs tool RESULTS, not disk) — exactly why /monitor redacts in runFixedTee. So
 * any subagent output written to disk MUST be scrubbed here first. `redact` is the injected
 * loadRedactor(root) closure (this module needs no dependency on redact.ts). Redact THEN byte-cap
 * (so a full-length secret can't be split across the cut), slicing on a Buffer so the cap is honored
 * in UTF-8 bytes — not UTF-16 code units. Ensures a trailing newline.
 */
export function redactOnWrite(redact: (s: string) => string, absPath: string, text: string, maxBytes?: number): void {
	let safe = redact(text);
	if (maxBytes !== undefined) {
		const buf = Buffer.from(safe, "utf-8");
		if (buf.length > maxBytes) {
			safe = `${buf.subarray(0, maxBytes).toString("utf-8")}\n\n[truncated at ${maxBytes} bytes]`;
		}
	}
	fs.writeFileSync(absPath, safe.endsWith("\n") ? safe : `${safe}\n`, "utf-8");
}

function readIfExists(p: string): string | undefined {
	try {
		return fs.readFileSync(p, "utf-8");
	} catch {
		return undefined;
	}
}
