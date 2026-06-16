import test from "node:test";
import assert from "node:assert/strict";
import { getCronAgentBin } from "../cron/agent-bin.ts";

test("getCronAgentBin prefers ugk when it is available", () => {
	const calls: string[] = [];

	assert.equal(
		getCronAgentBin({
			execSync(command) {
				calls.push(command);
			},
		}),
		"ugk",
	);
	assert.deepEqual(calls, ["ugk --version"]);
});

test("getCronAgentBin falls back to pi when ugk is unavailable", () => {
	assert.equal(
		getCronAgentBin({
			execSync() {
				throw new Error("missing");
			},
		}),
		"pi",
	);
});
