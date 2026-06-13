/**
 * Verifier command runner — loaded ONLY into the Verifier subprocess via `pi -e runner.ts`.
 *
 * Registers a single `run_check` tool whose surface is a CLOSED SET of named checks.
 * Each check maps to a FIXED argv vector that is executed with `shell:false`, so there is
 * no shell to chain into: `;`, `&&`, `||`, `|`, backticks, `$( )`, redirects, and newlines
 * are structurally impossible — the model never gets to assemble a command string.
 *
 * GENERIC / REUSABLE: the project-specific checks (test, lint, typecheck, …) are NOT
 * hard-coded here. They are read from `<repoRoot>/harness/checks.json` (see that file's
 * schema note). This runner contributes only the universal, always-available git checks
 * (git-diff, git-diff-stat, git-status, git-log) so the tool works in ANY git repo even
 * with no config. Drop the engine into a new project and supply a `harness/checks.json`
 * to teach it that project's checks — no code change required.
 *
 * The only free-text input is the `path` for `test-file` (when configured), which is
 * strictly validated (config-supplied regex, must stay under the configured root dir, no
 * `..` escape) before use. When in doubt, the tool REFUSES and reports — it never edits and
 * never runs anything off the list.
 *
 * This file deliberately registers no other tools. The Verifier subprocess is started with
 * `--tools read,grep,find,ls,run_check`, so write/edit/bash are simply not present.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_OUTPUT_BYTES = 30 * 1024;

// Universal checks available in any git repo, regardless of harness/checks.json.
const GIT_CHECKS = ["git-diff", "git-diff-stat", "git-status", "git-log"] as const;
type GitCheck = (typeof GIT_CHECKS)[number];

// ---------------------------------------------------------------------------
// Config (harness/checks.json) — the project-specific check definitions.
// ---------------------------------------------------------------------------

interface FixedCheck {
	cmd: string;
	args: string[];
	timeoutMs: number;
}

interface TestFileSpec {
	cmd: string;
	argsPrefix: string[];
	rootDir: string;
	pathRegex: string;
	timeoutMs: number;
}

interface ChecksConfig {
	diffBases: string[];
	env: { venvBinDir?: string; virtualEnvDir?: string };
	testFile?: TestFileSpec;
	checks: Record<string, FixedCheck>;
}

// Walk up from a starting dir to the repo root: the first ancestor that has a
// harness/checks.json OR the harness/prompts/plan.md + memory/MEMORY.md markers.
function findRepoRoot(startCwd: string): string {
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

function loadConfig(repoRoot: string): ChecksConfig {
	const empty: ChecksConfig = { diffBases: ["main", "HEAD~1"], env: {}, checks: {} };
	try {
		const raw = fs.readFileSync(path.join(repoRoot, "harness", "checks.json"), "utf-8");
		const parsed = JSON.parse(raw) as Partial<ChecksConfig>;
		return {
			diffBases: Array.isArray(parsed.diffBases) && parsed.diffBases.length ? parsed.diffBases : empty.diffBases,
			env: parsed.env ?? {},
			testFile: parsed.testFile,
			checks: parsed.checks ?? {},
		};
	} catch {
		return empty;
	}
}

// The Verifier subprocess is spawned with cwd = repoRoot, so process.cwd() is the repo.
// Resolve config once at module load to build the allowlist for the tool schema.
const REPO_ROOT = findRepoRoot(process.cwd());
const CONFIG = loadConfig(REPO_ROOT);

// Ordered list of every allowed check name, for the StringEnum schema + description.
function allCheckNames(cfg: ChecksConfig): string[] {
	const names = [...Object.keys(cfg.checks)];
	if (cfg.testFile) names.push("test-file");
	names.push(...GIT_CHECKS);
	return names;
}

// ---------------------------------------------------------------------------
// git base resolution (for the universal git checks)
// ---------------------------------------------------------------------------

function resolveGitBase(repoRoot: string, bases: string[]): string {
	for (const base of bases) {
		const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", base], {
			cwd: repoRoot,
			encoding: "utf-8",
		});
		if (r.status === 0) return base;
	}
	return bases[0] ?? "main";
}

function gitCheckSpec(check: GitCheck, base: string): FixedCheck {
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

function validateTestPath(
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

// ---------------------------------------------------------------------------
// Process execution (shell:false, fixed argv)
// ---------------------------------------------------------------------------

function buildEnv(repoRoot: string): NodeJS.ProcessEnv {
	const env = { ...process.env };
	const venvBinDir = CONFIG.env.venvBinDir;
	if (venvBinDir) {
		const venvBin = path.resolve(repoRoot, venvBinDir);
		if (fs.existsSync(venvBin)) {
			env.PATH = `${venvBin}${path.delimiter}${env.PATH ?? ""}`;
			if (CONFIG.env.virtualEnvDir) env.VIRTUAL_ENV = path.resolve(repoRoot, CONFIG.env.virtualEnvDir);
		}
	}
	return env;
}

interface RunOutcome {
	cmdline: string;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	output: string;
}

function runFixed(
	repoRoot: string,
	cmd: string,
	args: string[],
	timeoutMs: number,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: { content: { type: "text"; text: string }[] }) => void) | undefined,
): Promise<RunOutcome> {
	return new Promise((resolve) => {
		const cmdline = `${cmd} ${args.join(" ")}`;
		const proc = spawn(cmd, args, {
			cwd: repoRoot,
			shell: false, // <- no shell: chaining/redirects are impossible
			env: buildEnv(repoRoot),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let timedOut = false;

		const append = (d: Buffer) => {
			output += d.toString();
			if (output.length > MAX_OUTPUT_BYTES * 2) output = output.slice(-MAX_OUTPUT_BYTES * 2);
			onUpdate?.({ content: [{ type: "text", text: `$ ${cmdline}\n${tail(output)}` }] });
		};
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
			resolve({ cmdline, exitCode: code, signal: sig, timedOut, output });
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ cmdline, exitCode: null, signal: null, timedOut, output: `${output}\n[spawn error] ${err.message}` });
		});
	});
}

function tail(s: string): string {
	if (Buffer.byteLength(s, "utf-8") <= MAX_OUTPUT_BYTES) return s;
	const slice = s.slice(-MAX_OUTPUT_BYTES);
	return `…[output truncated to last ${MAX_OUTPUT_BYTES} bytes]\n${slice}`;
}

export default function verifierRunner(pi: ExtensionAPI) {
	const checkNames = allCheckNames(CONFIG);
	const testFileNote = CONFIG.testFile
		? ` For 'test-file', pass a target under ${CONFIG.testFile.rootDir}/ (file or node id) in 'path'.`
		: "";

	pi.registerTool({
		name: "run_check",
		label: "Run Check",
		description: [
			"Run ONE allowlisted verification check (read-only, no shell).",
			`Allowed: ${checkNames.join(", ")}.${testFileNote}`,
			"Any other command is refused. This tool never edits files.",
		].join(" "),
		parameters: Type.Object({
			check: StringEnum(checkNames as string[], { description: "Which allowlisted check to run" }),
			path: Type.Optional(
				Type.String({ description: "target under the test root (only for check='test-file')" }),
			),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const repoRoot = ctx.cwd;
			const check = params.check as string;

			let cmd: string;
			let cmdArgs: string[];
			let timeoutMs: number;

			if ((GIT_CHECKS as readonly string[]).includes(check)) {
				const base = resolveGitBase(repoRoot, CONFIG.diffBases);
				const spec = gitCheckSpec(check as GitCheck, base);
				cmd = spec.cmd;
				cmdArgs = spec.args;
				timeoutMs = spec.timeoutMs;
			} else if (check === "test-file") {
				if (!CONFIG.testFile) {
					return {
						content: [{ type: "text", text: "Refused: 'test-file' is not configured in harness/checks.json." }],
						details: { check, refused: true },
						isError: true,
					};
				}
				const v = validateTestPath(repoRoot, CONFIG.testFile, params.path ?? "");
				if (!v.ok) {
					return {
						content: [{ type: "text", text: `Refused: ${v.reason}` }],
						details: { check, refused: true },
						isError: true,
					};
				}
				cmd = CONFIG.testFile.cmd;
				cmdArgs = [...CONFIG.testFile.argsPrefix, v.rel];
				timeoutMs = CONFIG.testFile.timeoutMs;
			} else if (check in CONFIG.checks) {
				const spec = CONFIG.checks[check];
				cmd = spec.cmd;
				cmdArgs = spec.args;
				timeoutMs = spec.timeoutMs;
			} else {
				return {
					content: [{ type: "text", text: `Refused: '${check}' is not an allowed check.` }],
					details: { check, refused: true },
					isError: true,
				};
			}

			const outcome = await runFixed(repoRoot, cmd, cmdArgs, timeoutMs, signal, onUpdate);
			const status = outcome.timedOut
				? `TIMED OUT after ${Math.round(timeoutMs / 1000)}s`
				: outcome.exitCode === 0
					? "exit 0 (pass)"
					: `exit ${outcome.exitCode ?? "?"}${outcome.signal ? ` (signal ${outcome.signal})` : ""}`;

			const text = `$ ${outcome.cmdline}\n[${status}]\n\n${tail(outcome.output) || "(no output)"}`;
			return {
				content: [{ type: "text", text }],
				details: { check, exitCode: outcome.exitCode, timedOut: outcome.timedOut, cmdline: outcome.cmdline },
				isError: outcome.exitCode !== 0,
			};
		},
	});
}
