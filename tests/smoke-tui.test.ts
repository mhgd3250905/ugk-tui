import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, hasCrashText } from "../scripts/smoke-tui.mjs";

test("smoke report marks failed scenarios and crash text", () => {
	const scenarios = [
		{ name: "startup", ok: true },
		{ name: "doctor", ok: false, detail: "timeout" },
	];
	const report = buildReport(scenarios, { exitCode: 1, timedOut: false, stderr: "TypeError: stale ctx" });

	assert.equal(hasCrashText("TypeError: stale ctx"), true);
	assert.match(report, /^# UGK TUI Smoke Report/);
	assert.match(report, /- ✅ startup/);
	assert.match(report, /- ❌ doctor — timeout/);
	assert.match(report, /Crash text: detected/);
	assert.match(report, /Exit code: 1/);
});
