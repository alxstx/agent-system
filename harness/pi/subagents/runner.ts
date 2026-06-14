/**
 * Verifier command runner — loaded ONLY into the Verifier/Monitor subprocess via `pi -e runner.ts`.
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
 * The check-running CORE (config loading, the closed-set dispatch, argv validation, the
 * shell:false executor) lives in `../shared/checks-core.ts`, shared with the main-session
 * `/checks` command so the two can never run a different allowlist (IMPLEMENTATION-PLAN.md P2.0b).
 *
 * ONE default export rule: every tool this subprocess exposes is registered from the SINGLE
 * `verifierRunner(pi)` default export below (run_check today; run_experiment when /monitor is
 * built, via registerRunExperiment). pi loads ONE default export per `-e` file — a second
 * `export default` would REPLACE this one and silently drop run_check.
 *
 * The only free-text input is the `path` for `test-file` (when configured), which is
 * strictly validated (config-supplied regex, must stay under the configured root dir, no
 * `..` escape) before use. When in doubt, the tool REFUSES and reports — it never edits and
 * never runs anything off the list.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolUpdateCallback, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	allCheckNames,
	type ChecksConfig,
	envDump,
	findRepoRoot,
	loadConfig,
	resolveCheck,
	runFixed,
	tail,
} from "../shared/checks-core.js";

// The Verifier subprocess is spawned with cwd = repoRoot, so process.cwd() is the repo.
// Resolve config once at module load to build the allowlist for the tool schema.
const REPO_ROOT = findRepoRoot(process.cwd());
const CONFIG: ChecksConfig = loadConfig(REPO_ROOT);

function registerRunCheck(pi: ExtensionAPI) {
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
				Type.String({
					description: "file path for check='test-file' (under the test root), 'git-blame', or 'git-log-file'",
				}),
			),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const repoRoot = ctx.cwd;
			const check = params.check as string;

			const resolved = resolveCheck(CONFIG, repoRoot, check, params.path as string | undefined);
			if ("refused" in resolved) {
				return {
					content: [{ type: "text", text: `Refused: ${resolved.reason}` }],
					details: { check, refused: true },
					isError: true,
				};
			}
			if ("inline" in resolved) {
				// env-dump: an allowlisted-prefix slice of process.env, no subprocess.
				return { content: [{ type: "text", text: envDump() }], details: { check }, isError: false };
			}

			const outcome = await runFixed(
				repoRoot,
				CONFIG,
				resolved.cmd,
				resolved.args,
				resolved.timeoutMs,
				signal,
				// pi's onUpdate carries a `details` field our internal streamer omits; the runtime
				// tolerates the narrower partials (it always has) — forward the same callback.
				onUpdate as AgentToolUpdateCallback<unknown> | undefined,
			);
			const status = outcome.timedOut
				? `TIMED OUT after ${Math.round(resolved.timeoutMs / 1000)}s`
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

export default function verifierRunner(pi: ExtensionAPI) {
	registerRunCheck(pi);
}
