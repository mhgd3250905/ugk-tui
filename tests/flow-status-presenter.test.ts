import test from "node:test";
import assert from "node:assert/strict";
import { formatFlowActivityCard } from "../extensions/flow/status-presenter.ts";

test("formatFlowActivityCard renders a prominent running card", () => {
	const lines = formatFlowActivityCard([
		{
			taskId: "x",
			runId: "run-001",
			status: "running",
			step: "starting",
			summary: "prove driver running",
		},
	]);

	assert.deepEqual(lines, [
		"╭─ Flow Activity ─────────────────────────────",
		"│ ● x/run-001",
		"│   status: running / starting",
		"│   next: waiting for driver result",
		"╰─────────────────────────────────────────────",
	]);
});

test("formatFlowActivityCard renders review state over stale validation next step", () => {
	const lines = formatFlowActivityCard([
		{
			taskId: "x",
			runId: "run-001",
			status: "done",
			step: "validated",
			summary: "PASS: ok",
			validation: {
				result: "PASS",
				summary: "ok",
				nextStep: "/flow task review x/run-001",
			},
			review: { status: "accepted" },
			task: { status: "verified", nextStep: "/flow run x" },
		},
	]);

	assert.deepEqual(lines, [
		"╭─ Flow Activity ─────────────────────────────",
		"│ ✓ x/run-001",
		"│   status: done / validated",
		"│   result: PASS - ok",
		"│   review: accepted",
		"│   task: verified",
		"│   next: /flow run x",
		"╰─────────────────────────────────────────────",
	]);
});
