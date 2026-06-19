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
		"│   structure: PASS - ok",
		"│   review: accepted",
		"│   task: verified",
		"│   next: /flow run x",
		"╰─────────────────────────────────────────────",
	]);
});

test("formatFlowActivityCard points accepted approved tasks to the next run", () => {
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
			task: { status: "approved", nextStep: "main reviewing x/run-001" },
		},
	]);

	assert.deepEqual(lines, [
		"╭─ Flow Activity ─────────────────────────────",
		"│ ✓ x/run-001",
		"│   status: done / validated",
		"│   structure: PASS - ok",
		"│   review: accepted",
		"│   task: approved",
		"│   next: /flow run x",
		"╰─────────────────────────────────────────────",
	]);
});

test("activity card truncates overly long validation summary", () => {
	const longSummary = "x".repeat(6513);
	const lines = formatFlowActivityCard([
		{
			taskId: "zhihu-hot-list",
			runId: "run-001",
			status: "done",
			step: "validated",
			validation: { result: "PASS", summary: longSummary, nextStep: "review" },
			review: { status: "in-review" },
			task: { status: "reviewing", nextStep: "reviewing" },
		},
	]);
	const summaryLine = lines.find((l) => l.includes("structure: PASS"));
	assert.ok(summaryLine, "structure line must exist");
	assert.ok(summaryLine.length < 150, `summary line must be short, got ${summaryLine.length} chars`);
	assert.ok(summaryLine.endsWith("…"), "truncated summary must end with ellipsis");
});
