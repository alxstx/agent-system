/**
 * Shared check-running core — the ONE source of "what may run, with what argv, and how".
 *
 * Extracted verbatim-in-behavior from runner.ts (IMPLEMENTATION-PLAN.md P2.0b) so that BOTH
 *   - the Verifier's `run_check` tool (runner.ts, loaded into the isolated subprocess), and
 *   - the main-session `/checks` command (harness/pi/checks/index.ts)
 * execute the SAME allowlisted commands from the SAME harness/checks.json — they can never diverge.
 *
 * Nothing here opens a shell: every command is a fixed argv run with `shell:false`, so `;`,
 * `&&`, `||`, `|`, backticks, `$( )`, redirects and newlines are structurally impossible.
 *
 * Also hosts `runFixedTee` (runFixed + a redacted disk tee) used by /monitor's `run_experiment`,
 * and `validateLogFile` for confining per-run logs under memory/runs/.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";

export const MAX_OUTPUT_BYTES = 30 * 1024;

// Universal checks available in any git repo, regardless of harness/checks.json.
export const GIT_CHECKS = ["git-diff", "git-diff-stat", "git-status", "git-log"] as const;
export type GitCheck = (typeof GIT_CHECKS)[number];

// ---------------------------------------------------------------------------
// Config (harness/checks.json) — the project-specific check definitions.
// ---------------------------------------------------------------------------

export interface FixedCheck {
	cmd: string;
	args: string[];
	timeoutMs: number;
}

export interface TestFileSpec {
	cmd: string;
	argsPrefix: string[];
	rootDir: string;
	pathRegex: string;
	timeoutMs: number;
}

// A long-lived experiment the Monitor may launch (closed allowlist, fixed argv).
// NO logFile field: the log path is per-RUN (memory/runs/<runId>.log), from the runId
// the parent passes to run_experiment — a per-experiment logFile would clobber repeats.
export interface ExperimentSpec {
	cmd: string;
	args: string[];
	timeoutMs: number;
}

export interface ChecksConfig {
	diffBases: string[];
	env: { venvBinDir?: string; virtualEnvDir?: string };
	testFile?: TestFileSpec;
	checks: Record<string, FixedCheck>;
	experiments: Record<string, ExperimentSpec>;
}

// Walk up from a starting dir to the repo root: the first ancestor that has a
// harness/checks.json OR the harness/prompts/plan.md + memory/MEMORY.md markers.
export function findRepoRoot(startCwd: string): string {
	let dir = path.resolve(startCwd);
	while (true) {
		if (
			fs.existsSync(path.join(dir, "harness", "checks.json")) ||
			(fs.existsSync(path.join(dir, "harness", "prompts", "plan.md")) &&
				fs.existsSync(path.join(dir, "memory", "MEMORY.md")))
		) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return path.resolve(startCwd);
		dir = parent;
	}
}

export function loadConfig(repoRoot: string): ChecksConfig {
	const empty: ChecksConfig = { diffBases: ["main", "HEAD~1"], env: {}, checks: {}, experiments: {} };
	try {
		const raw = fs.readFileSync(path.join(repoRoot, "harness", "checks.json"), "utf-8");
		const parsed = JSON.parse(raw) as Partial<ChecksConfig>;
		return {
			diffBases: Array.isArray(parsed.diffBases) && parsed.diffBases.length ? parsed.diffBases : empty.diffBases,
			env: parsed.env ?? {},
			testFile: parsed.testFile,
			checks: parsed.checks ?? {},
			experiments: parsed.experiments ?? {},
		};
	} catch {
		return empty;
	}
}

// Ordered list of every allowed check name, for the StringEnum schema + description.
export function allCheckNames(cfg: ChecksConfig): string[] {
	const names = [...Object.keys(cfg.checks)];
	if (cfg.testFile) names.push("test-file");
	names.push(...GIT_CHECKS);
	return names;
}

// ---------------------------------------------------------------------------
// git base resolution (for the universal git checks)
// ---------------------------------------------------------------------------

export function resolveGitBase(repoRoot: string, bases: string[]): string {
	for (const base of bases) {
		const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", base], {
			cwd: repoRoot,
			encoding: "utf-8",
		});
		if (r.status === 0) return base;
	}
	return bases[0] ?? "main";
}

export function gitCheckSpec(check: GitCheck, base: string): FixedCheck {
	switch (check) {
		case "git-diff":
			return { cmd: "git", args: ["diff", base], timeoutMs: 60_000 };
		case "git-diff-stat":
			return { cmd: "git", args: ["diff", "--stat", base], timeoutMs: 60_000 };
		case "git-status":
			return { cmd: "git", args: ["status", "--porcelain"], timeoutMs: 60_000 };
		case "git-log":
			return { cmd: "git", args: ["log", "--oneline", "-20", `${base}..HEAD`], timeoutMs: 60_000 };
	}
}

// ---------------------------------------------------------------------------
// test-file path validation (only free-text argument, when test-file is configured)
// ---------------------------------------------------------------------------

export function validateTestPath(
	repoRoot: string,
	spec: TestFileSpec,
	p: string,
): { ok: true; rel: string } | { ok: false; reason: string } {
	const raw = p.trim();
	if (!raw) return { ok: false, reason: "empty path" };
	let re: RegExp;
	try {
		re = new RegExp(spec.pathRegex);
	} catch {
		return { ok: false, reason: "invalid pathRegex in harness/checks.json" };
	}
	if (!re.test(raw)) {
		return { ok: false, reason: `path must match ${spec.pathRegex} (no shell metacharacters)` };
	}
	if (raw.includes("..")) return { ok: false, reason: "'..' is not allowed" };
	// Strip an optional ::nodeid suffix before checking the file exists on disk.
	const filePart = raw.split("::")[0];
	const resolved = path.resolve(repoRoot, filePart);
	const root = path.resolve(repoRoot, spec.rootDir);
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		return { ok: false, reason: `path must stay within ${spec.rootDir}/` };
	}
	if (!fs.existsSync(resolved)) return { ok: false, reason: `no such file: ${filePart}` };
	return { ok: true, rel: raw };
}

// Confine a per-run experiment log to <repoRoot>/memory/runs/ (no traversal).
export function validateLogFile(
	repoRoot: string,
	relLog: string,
): { ok: true; abs: string } | { ok: false; reason: string } {
	if (relLog.includes("..")) return { ok: false, reason: "'..' is not allowed in the log path" };
	const abs = path.resolve(repoRoot, relLog);
	const root = path.resolve(repoRoot, "memory", "runs");
	if (abs !== root && !abs.startsWith(root + path.sep)) {
		return { ok: false, reason: "log path must stay within memory/runs/" };
	}
	return { ok: true, abs };
}

// ---------------------------------------------------------------------------
// Check dispatch — resolve a check name (+ optional path) to a fixed argv, or a refusal.
// (Factored out of runner.ts's execute so /checks and run_check dispatch identically.)
// ---------------------------------------------------------------------------

export function resolveCheck(
	cfg: ChecksConfig,
	repoRoot: string,
	check: string,
	p?: string,
): { cmd: string; args: string[]; timeoutMs: number } | { refused: true; reason: string } {
	if ((GIT_CHECKS as readonly string[]).includes(check)) {
		const base = resolveGitBase(repoRoot, cfg.diffBases);
		return gitCheckSpec(check as GitCheck, base);
	}
	if (check === "test-file") {
		if (!cfg.testFile) return { refused: true, reason: "'test-file' is not configured in harness/checks.json." };
		const v = validateTestPath(repoRoot, cfg.testFile, p ?? "");
		if (!v.ok) return { refused: true, reason: v.reason };
		return { cmd: cfg.testFile.cmd, args: [...cfg.testFile.argsPrefix, v.rel], timeoutMs: cfg.testFile.timeoutMs };
	}
	if (check in cfg.checks) {
		const spec = cfg.checks[check];
		return { cmd: spec.cmd, args: spec.args, timeoutMs: spec.timeoutMs };
	}
	return { refused: true, reason: `'${check}' is not an allowed check.` };
}

// ---------------------------------------------------------------------------
// Process execution (shell:false, fixed argv)
// ---------------------------------------------------------------------------

export function buildEnv(cfg: ChecksConfig, repoRoot: string): NodeJS.ProcessEnv {
	const env = { ...process.env };
	const venvBinDir = cfg.env.venvBinDir;
	if (venvBinDir) {
		const venvBin = path.resolve(repoRoot, venvBinDir);
		if (fs.existsSync(venvBin)) {
			env.PATH = `${venvBin}${path.delimiter}${env.PATH ?? ""}`;
			if (cfg.env.virtualEnvDir) env.VIRTUAL_ENV = path.resolve(repoRoot, cfg.env.virtualEnvDir);
		}
	}
	return env;
}

export interface RunOutcome {
	cmdline: string;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	output: string;
}

// Shared spawn/timeout/abort/kill-ladder core. Both runFixed and runFixedTee delegate here so
// the process lifecycle (SIGTERM→SIGKILL, AbortSignal teardown) is defined exactly once.
function spawnFixed(
	repoRoot: string,
	cfg: ChecksConfig,
	cmd: string,
	args: string[],
	timeoutMs: number,
	signal: AbortSignal | undefined,
	onChunk: (chunk: string) => void,
): Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean; spawnError?: string }> {
	return new Promise((resolve) => {
		const proc = spawn(cmd, args, {
			cwd: repoRoot,
			shell: false, // <- no shell: chaining/redirects are impossible
			env: buildEnv(cfg, repoRoot),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let timedOut = false;

		const append = (d: Buffer) => onChunk(d.toString());
		proc.stdout.on("data", append);
		proc.stderr.on("data", append);

		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000);
		}, timeoutMs);

		const onAbort = () => {
			proc.kill("SIGTERM");
		};
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		proc.on("close", (code, sig) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ exitCode: code, signal: sig, timedOut });
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ exitCode: null, signal: null, timedOut, spawnError: err.message });
		});
	});
}

// Run a fixed command, streaming the rolling (capped) output to the agent via onUpdate.
// Behaviour-identical to the original runner.ts runFixed (the /verify regression baseline).
export function runFixed(
	repoRoot: string,
	cfg: ChecksConfig,
	cmd: string,
	args: string[],
	timeoutMs: number,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<unknown> | undefined,
): Promise<RunOutcome> {
	const cmdline = `${cmd} ${args.join(" ")}`;
	let output = "";
	const onChunk = (s: string) => {
		output += s;
		if (output.length > MAX_OUTPUT_BYTES * 2) output = output.slice(-MAX_OUTPUT_BYTES * 2);
		onUpdate?.({ content: [{ type: "text", text: `$ ${cmdline}\n${tail(output)}` }], details: undefined });
	};
	return spawnFixed(repoRoot, cfg, cmd, args, timeoutMs, signal, onChunk).then((r) => {
		if (r.spawnError) {
			return { cmdline, exitCode: null, signal: null, timedOut: r.timedOut, output: `${output}\n[spawn error] ${r.spawnError}` };
		}
		return { cmdline, exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut, output };
	});
}

// runFixed + a redacted disk tee: the FULL (redacted) stream is written to absLogPath, while the
// in-memory `output` stays capped. Redaction is applied PER LINE, before BOTH the agent-visible
// onUpdate AND the disk write, so memory/runs/<runId>.log is scrubbed at the source (a main-session
// hook can never see this subprocess). `redact` is injected (the shared loadRedactor closure) so
// this module needs no dependency on redact.ts. (Cross-line-boundary split secrets are a documented
// residual risk — see monitor-design.md §7.)
export async function runFixedTee(
	repoRoot: string,
	cfg: ChecksConfig,
	cmd: string,
	args: string[],
	timeoutMs: number,
	absLogPath: string,
	redact: (s: string) => string,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<unknown> | undefined,
): Promise<RunOutcome> {
	const cmdline = `${cmd} ${args.join(" ")}`;
	const logStream = fs.createWriteStream(absLogPath, { flags: "w" });
	let output = "";
	let pending = "";

	const flushLine = (line: string) => {
		const safe = redact(line);
		logStream.write(`${safe}\n`);
		output += `${safe}\n`;
		if (output.length > MAX_OUTPUT_BYTES * 2) output = output.slice(-MAX_OUTPUT_BYTES * 2);
	};

	const onChunk = (s: string) => {
		pending += s;
		let idx: number;
		while ((idx = pending.indexOf("\n")) >= 0) {
			flushLine(pending.slice(0, idx));
			pending = pending.slice(idx + 1);
		}
		const live = pending ? `${tail(output)}${redact(pending)}` : tail(output);
		onUpdate?.({ content: [{ type: "text", text: `$ ${cmdline}\n${live}` }], details: undefined });
	};

	const r = await spawnFixed(repoRoot, cfg, cmd, args, timeoutMs, signal, onChunk);
	if (pending) {
		flushLine(pending);
		pending = "";
	}
	await new Promise<void>((res) => logStream.end(() => res()));
	if (r.spawnError) output += `\n[spawn error] ${r.spawnError}`;
	return { cmdline, exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut, output };
}

export function tail(s: string): string {
	if (Buffer.byteLength(s, "utf-8") <= MAX_OUTPUT_BYTES) return s;
	const slice = s.slice(-MAX_OUTPUT_BYTES);
	return `…[output truncated to last ${MAX_OUTPUT_BYTES} bytes]\n${slice}`;
}
