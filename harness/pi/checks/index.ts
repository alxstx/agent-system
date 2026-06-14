/**
 * /checks — run the harness/checks.json allowlist INLINE in the main session and print a
 * green/red widget, with NO Verifier sub-agent and NO model tokens (ext-slash-checks.md).
 *
 * Imports the SAME check-running core as the Verifier's run_check (../shared/checks-core.ts), so
 * the main session and the sub-agent can never run a different allowlist — a green /checks
 * predicts a clean /verify run.
 *
 * `/checks`        runs the project checks (Object.keys(cfg.checks); git checks excluded from
 *                  "all" since they always pass — noise).
 * `/checks <name>` runs ONE check (any project check, test-file, or a git check by name).
 *
 * Decision: results go to the UI only (widget + notify) — they are NOT fed to the model. This
 * is a zero-token operator smoke test; escalate to /verify when you want the model to act.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { allCheckNames, findRepoRoot, loadConfig, resolveCheck, runFixed } from "../shared/checks-core.js";

export default function checks(pi: ExtensionAPI) {
	pi.registerCommand("checks", {
		description: "Run allowlisted checks inline (green/red widget; UI-only, no model). Usage: /checks [name]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const repoRoot = findRepoRoot(ctx.cwd);
			const cfg = loadConfig(repoRoot);
			const one = args.trim();
			if (one && !allCheckNames(cfg).includes(one)) {
				ctx.ui.notify(`Unknown check '${one}'. Allowed: ${allCheckNames(cfg).join(", ")}`, "error");
				return;
			}
			const names = one ? [one] : Object.keys(cfg.checks); // default: project checks only, not git
			if (!names.length) {
				ctx.ui.notify("No checks defined in harness/checks.json.", "warning");
				return;
			}

			const rows: string[] = [];
			let failed = 0;
			for (const name of names) {
				// ctx.signal is undefined when no agent turn is active (command fired while idle); the
				// optional chaining makes Esc-cancel a graceful no-op there and a real abort when present.
				if (ctx.signal?.aborted) break;
				const r = resolveCheck(cfg, repoRoot, name, undefined); // test-file/probes need a path -> refused in "all"
				if ("refused" in r) {
					rows.push(`  ?  ${name.padEnd(14)} ${r.reason}`);
					continue;
				}
				if ("inline" in r) {
					// env-dump (TS read of process.env, no subprocess) — always "passes".
					rows.push(`  ✓  ${name.padEnd(14)} ok (inline)`);
					continue;
				}
				ctx.ui.setStatus("checks", `running ${name}…`);
				const o = await runFixed(repoRoot, cfg, r.cmd, r.args, r.timeoutMs, ctx.signal, undefined);
				const ok = o.exitCode === 0 && !o.timedOut;
				if (!ok) failed++;
				rows.push(`  ${ok ? "✓" : "✗"}  ${name.padEnd(14)} ${o.timedOut ? "TIMEOUT" : `exit ${o.exitCode ?? "?"}`}`);
			}
			ctx.ui.setStatus("checks", "");
			ctx.ui.setWidget("checks", ["checks:", ...rows], { placement: "belowEditor" });
			// "success" is not in the confirmed notify enum — use info/warning only.
			ctx.ui.notify(failed ? `${failed} check(s) failed` : "all checks passed", failed ? "warning" : "info");
		},
	});
}
