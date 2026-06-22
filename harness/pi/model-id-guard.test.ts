/**
 * Repo-wide model-id guard (dual-mode slice 2). Offline + runs in the normal `npm test` gate.
 *
 * Policy (owner decision, memory/plan-subagent-dual-mode.md): EVERY model the harness selects resolves
 * through the GitHub Copilot login — ids are fully-qualified `github-copilot/<id>`. A direct
 * provider-qualified id (`openai/<id>` or `anthropic/<id>`) resolves to the DIRECT provider, which needs
 * its own key/auth — so none may appear in ANY tracked file. This test greps the whole tracked tree via
 * `git grep` and FAILS listing every offender.
 *
 * Repo-wide on purpose (not harness/-scoped): a narrower scan would pass green while a tracked file
 * elsewhere (e.g. the formerly-tracked tmp/ scratch) still carried a forbidden id. node_modules/ is
 * excluded (vendored, and not tracked anyway); pi-ai/dist lives under node_modules so it's covered.
 *
 * The forbidden substring is assembled from PARTS below, so THIS guard file never contains a literal
 * `<provider>/<id>` and can't flag itself (it's also excluded by path, belt-and-suspenders).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// The two DIRECT providers whose qualified ids are banned. Built as parts → the joined "<p>/<char>"
// shape never appears literally in this source.
const DIRECT_PROVIDERS = ["openai", "anthropic"];
const FORBIDDEN = `(${DIRECT_PROVIDERS.join("|")})/[a-z0-9]`; // e.g. matches a real direct id like <provider>/gpt-...

const SELF = "harness/pi/model-id-guard.test.ts"; // exclude this guard from its own scan

test("repo-wide guard: no direct provider-qualified model ids in tracked files (github-copilot/ only)", () => {
	const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" });
	assert.equal(top.status, 0, `must run inside a git repo: ${top.stderr || top.error?.message}`);
	const root = top.stdout.trim();

	// `git grep` over the whole tracked tree from the repo root. Exit codes: 0 = matches found (FAIL),
	// 1 = no matches (PASS), >=2 = error. -I skips binary files.
	const res = spawnSync(
		"git",
		["-C", root, "grep", "-nIE", FORBIDDEN, "--", ":(exclude)harness/pi/node_modules", `:(exclude)${SELF}`],
		{ encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
	);

	if (res.status === 1) return; // clean — no direct ids anywhere
	if (res.status === 0) {
		assert.fail(
			"Direct provider-qualified model id(s) found in tracked files — policy is github-copilot/<id> only.\n" +
				"Replace with the github-copilot/ form (or untrack the file):\n" +
				res.stdout.trimEnd(),
		);
	}
	assert.fail(`git grep failed (status ${res.status}): ${res.stderr || res.error?.message}`);
});
