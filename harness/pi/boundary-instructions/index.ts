/**
 * boundary-instructions — bring Copilot's path-scoped `.github/instructions/*.instructions.md`
 * rules to pi (ext-boundary-instructions.md). When the model is about to edit/write a file that
 * matches a rule's `applyTo` glob, steer that rule's body into context so it follows the rule —
 * realizing "progressive disclosure": rules cost zero tokens until a matching file is touched.
 *
 * Matching is REPO-ROOT-relative (globs like src/api/**\/*.ts are written relative to the repo
 * root), so it works even when pi is launched from a subdirectory. Fires at most once per
 * file per session. Main-session only (sub-agents run --no-extensions).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findRepoRoot } from "../shared/checks-core.js";

interface Rule {
	applyToRe: RegExp[]; // compiled globs (repo-root-relative)
	title: string;
	body: string;
	file: string;
}

let RULES: Rule[] = [];
let REPO_ROOT = "";
const SURFACED = new Set<string>(); // fire at most once per file::rule per session

// Tiny glob -> RegExp matcher (no dep). Supports the Copilot subset actually used:
//   **/  (zero or more dirs)   **  *  ([^/]*)   ?  ([^/])   and comma-separated alternatives
//   (handled by splitting applyTo into multiple globs at load). Braces {a,b} are out of scope.
function globToRegExp(glob: string): RegExp {
	let re = "";
	let i = 0;
	while (i < glob.length) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			if (glob[i + 2] === "/") {
				re += "(?:.*/)?"; // **/ -> any number of leading dirs, including none
				i += 3;
			} else {
				re += ".*";
				i += 2;
			}
		} else if (c === "*") {
			re += "[^/]*";
			i++;
		} else if (c === "?") {
			re += "[^/]";
			i++;
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
			i++;
		}
	}
	return new RegExp(`^${re}$`);
}

// ~10-line frontmatter reader: split on the first two --- fences; pull applyTo + description.
function parseRule(file: string, content: string): Rule | null {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
	if (!m) return null;
	const [, frontmatter, body] = m;
	const applyToM = /applyTo:\s*["']?([^"'\n]+)["']?/.exec(frontmatter);
	if (!applyToM) return null; // a file with no applyTo is skipped
	const globs = applyToM[1]
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (!globs.length) return null;
	const descM = /description:\s*["']?([^"'\n]+)["']?/.exec(frontmatter);
	const title = descM ? descM[1].trim() : path.basename(file);
	return { applyToRe: globs.map(globToRegExp), title, body, file };
}

function loadInstructions(dir: string): Rule[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir).filter((f) => f.endsWith(".instructions.md"));
	} catch {
		return []; // missing dir -> no rules
	}
	const rules: Rule[] = [];
	for (const f of entries) {
		try {
			const rule = parseRule(f, fs.readFileSync(path.join(dir, f), "utf-8"));
			if (rule) rules.push(rule);
		} catch {
			/* skip unreadable/garbled file */
		}
	}
	return rules;
}

function reload(cwd: string): void {
	REPO_ROOT = findRepoRoot(cwd);
	RULES = loadInstructions(path.join(REPO_ROOT, ".github", "instructions"));
	SURFACED.clear();
}

export default function boundaryInstructions(pi: ExtensionAPI) {
	pi.on("session_start", (_e, ctx) => {
		reload(ctx.cwd);
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return; // verified: toolName
		if (!REPO_ROOT) reload(ctx.cwd); // lazy init if session_start hasn't fired
		const input = (event.input ?? {}) as Record<string, unknown>;
		const p = String(input.path ?? input.file_path ?? ""); // verified: built-in edit/write use input.path
		if (!p) return;

		const abs = path.resolve(ctx.cwd, p); // resolve against the CALLER's cwd…
		const rel = path.relative(REPO_ROOT, abs); // …but match/dedupe/display REPO-ROOT-relative
		if (rel.startsWith("..") || path.isAbsolute(rel)) return; // edit outside the repo -> no repo rules apply

		const hits = RULES.filter(
			(r) => r.applyToRe.some((re) => re.test(rel)) && !SURFACED.has(`${r.file}::${rel}`),
		);
		if (!hits.length) return;
		for (const r of hits) SURFACED.add(`${r.file}::${rel}`);

		const text = hits.map((h) => `### Rule for \`${rel}\` (${h.title})\n${h.body.trim()}`).join("\n\n");
		// Steer the rule text into context so the model follows it. NOTE (FLAG): deliverAs:"steer"
		// is delivered after the current turn's tool calls, so a live test must confirm it reaches
		// the model BEFORE the edit lands; if not, switch to returning { block: true, reason: text }
		// here so the model re-issues the edit having seen the rule. Decide on a live pi.
		pi.sendMessage(
			{
				customType: "boundary-rule",
				content: `Path-scoped rules apply to ${rel}. Follow them in this edit:\n\n${text}`,
				display: true,
			},
			{ deliverAs: "steer" },
		);
		ctx.ui.notify(`Loaded ${hits.length} path-scoped rule(s) for ${rel}`, "info");
	});
}
