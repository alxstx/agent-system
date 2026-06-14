/**
 * secret-redaction — scrub secrets from MAIN-SESSION tool output before the model ingests it
 * (ext-secret-redaction.md). Mutates `event.content` text blocks in place on `tool_result`.
 *
 * Scope: main-session tool output only (bash, the arXiv MCP via pi-mcp-adapter, other
 * main-session tools). It does NOT see /monitor's subprocess output or its
 * memory/runs/<runId>.log tee — those run in a --no-extensions subprocess where this hook is
 * not even loaded, so they are scrubbed by the RUNNER calling the SAME redact() in runFixedTee.
 * Two call sites, one pattern source (harness/pi/shared/redact.ts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// The shared module is the ONE implementation: all replacement logic (incl. capture-group-
// preserving rules like Authorization: header -> "<name> [REDACTED]") lives in redact.ts.
// The hook does NO loop of its own — it just calls the configured redact(). Same function the
// runner's runFixedTee uses -> no drift.
import { loadRedactor } from "../shared/redact.js";

export default function secretRedaction(pi: ExtensionAPI) {
	const redact = loadRedactor(process.cwd()); // configured redact(text) (defaults + harness/redaction.json)

	pi.on("tool_result", (event) => {
		// event.content is the mutable content-block array the model will see (verified type).
		for (const block of event.content) {
			if (block.type === "text" && typeof block.text === "string") {
				block.text = redact(block.text); // mutate IN PLACE via the SHARED redactor
			}
		}
		// returning nothing = keep the (now-mutated) result
	});
}
