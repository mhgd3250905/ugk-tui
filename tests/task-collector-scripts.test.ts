import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

test("custom-source collector retries only failed or empty-CDP sources", () => {
	const script = path.join(process.cwd(), "tests", "fixtures", "taskbooks", "diabetes-device-custom-source-news", "scripts", "collect.mjs");
	const result = spawnSync(process.execPath, [script], {
		encoding: "utf8",
		env: { ...process.env, UGK_COLLECTOR_SELFTEST: "1" },
	});

	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.match(result.stdout, /PASS/);
});
