/**
 * command-guard — structural enforcement of AGENTS.md "Boundaries" + "pause before
 * irreversible changes" in the MAIN session (ext-command-guard.md).
 *
 * One `pi.on('tool_call')` pre-execution gate that BLOCKS:
 *   - destructive `bash` commands (rm -rf, git push --force/-f [but NOT --force-with-lease],
 *     git reset --hard, git clean -fd, truncating `>` redirects), and
 *   - `write`/`edit` whose target matches a configured boundary path,
 * plus a `/guard on|off` session toggle (the override — a PI_GUARD_OFF=1 cmd prefix would be
 * part of event.input.command, NOT pi's process.env, so it could never disarm the guard).
 *
 * Spawns no subprocess. Sub-agents are immune (they run --no-extensions), so this governs
 * exactly the human-driven main session, which is the surface that needs it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Fixed safety floor (NOT per-project): destructive shell patterns. Tolerant of whitespace
// runs; this is a guardrail against accidents, not a sandbox — the real isolation is the
// Verifier's closed allowlist. Override an intentional one with `/guard off`.
const DESTRUCTIVE: { re: RegExp; why: string }[] = [
	// rm with an -r or -f flag (flag token MUST start with `-`, so `rm file.txt` is NOT matched).
	{ re: /\brm\s+(?:-[-a-zA-Z]*\s+)*-[-a-zA-Z]*[rf]/i, why: "recursive/forced rm" },
	// git push --force or -f, but allow --force-with-lease.
	{ re: /\bgit\s+push\b[^\n]*(?:--force\b(?!-with-lease)|\s-f\b)/i, why: "git push --force" },
	{ re: /\bgit\s+reset\s+--hard\b/i, why: "git reset --hard" },
	{ re: /\bgit\s+clean\s+-[a-zA-Z]*[fd]/i, why: "git clean -f/-d" },
	// Truncating redirect `>` (not `>>` append, not `>&`/`2>&1` fd-dup).
	{ re: /(^|[^>])>(?!>|&)\s*\S/, why: "truncating redirect (>)" },
];

// Compile a boundary regex defensively — an invalid pattern must not crash the guard.
function matches(pattern: string, value: string): boolean {
	try {
		return new RegExp(pattern).test(value);
	} catch {
		return false;
	}
}

// Walk up to the repo root (where harness/checks.json lives) and read its `boundaries` array.
// repoRoot is returned so path matching can be made repo-root-relative (see the handler).
function loadBoundaries(cwd: string): { repoRoot: string; boundaries: string[] } {
	let dir = path.resolve(cwd);
	for (;;) {
		try {
			const cfg = JSON.parse(fs.readFileSync(path.join(dir, "harness", "checks.json"), "utf-8"));
			if (Array.isArray(cfg.boundaries)) return { repoRoot: dir, boundaries: cfg.boundaries as string[] };
		} catch {
			/* keep walking */
		}
		const parent = path.dirname(dir);
		if (parent === dir) return { repoRoot: path.resolve(cwd), boundaries: [] };
		dir = parent;
	}
}

export default function commandGuard(pi: ExtensionAPI) {
	let armed = true; // default on

	pi.registerCommand("guard", {
		description: "Toggle command-guard for this session: /guard on|off",
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			if (a === "off") armed = false;
			else if (a === "on") armed = true;
			else {
				ctx.ui.notify(`command-guard is ${armed ? "ARMED" : "OFF"} (usage: /guard on|off)`, "info");
				return;
			}
			ctx.ui.notify(`command-guard ${armed ? "ARMED" : "OFF"}`, armed ? "info" : "warning");
		},
	});

	pi.on("tool_call", (event, ctx) => {
		if (!armed) return; // operator disarmed via /guard off
		const name = event.toolName; // verified: toolName (string union; CustomToolCallEvent.toolName is string)
		const input = (event.input ?? {}) as Record<string, unknown>; // verified: input is mutable, keyed per tool

		if (name === "bash" || name === "shell") {
			const cmd = String(input.command ?? ""); // verified: bash input.command
			const hit = DESTRUCTIVE.find((d) => d.re.test(cmd));
			if (hit) {
				return {
					block: true,
					reason: `command-guard: ${hit.why} blocked by AGENTS.md "pause before irreversible changes". Run /guard off to override.`,
				};
			}
		}

		if (name === "write" || name === "edit") {
			// verified: built-in write/edit use input.path; tolerate file_path for custom tools.
			const p = String(input.path ?? input.file_path ?? "");
			if (!p) return;
			// Boundaries are REPO-ROOT-relative: resolve the target against the caller's cwd, then match
			// against its path relative to where harness/checks.json lives — NOT ctx.cwd — so launching pi
			// inside e.g. migrations/ and writing 0001.sql still trips the (^|/)migrations/ boundary.
			const abs = path.resolve(ctx.cwd, p);
			const { repoRoot, boundaries } = loadBoundaries(ctx.cwd);
			const inRepo = abs === repoRoot || abs.startsWith(repoRoot + path.sep);
			const rel = inRepo ? path.relative(repoRoot, abs) : abs; // repo-relative inside the repo; absolute outside
			const bad = boundaries.find((g) => matches(g, rel) || matches(g, p));
			if (bad) {
				return {
					block: true,
					reason: `command-guard: ${p} matches AGENTS.md Boundary "${bad}". Propose a plan first (/guard off to override).`,
				};
			}
		}
	});
}
