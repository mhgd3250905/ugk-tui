import test from "node:test";
import assert from "node:assert/strict";
import {
	buildFlowConsoleOptions,
	buildFlowStageGateOptions,
	parseFlowConsoleSelection,
	parseFlowStageGateSelection,
} from "../extensions/flow/flow-console.ts";

test("buildFlowConsoleOptions lists menu actions instead of raw help only", () => {
	const options = buildFlowConsoleOptions({
		tasks: [
			{ id: "draft-task", status: "draft" },
			{ id: "verified-task", status: "verified" },
		],
		drivers: [{ taskId: "draft-task", runId: "run-001", status: "done", step: "validated" }],
	});

	assert.deepEqual(options.map((option) => option.label), [
		"Create task",
		"Prove draft-task",
		"Run verified-task",
		"Review draft-task/run-001",
		"Attach driver",
		"Show status",
		"Exit",
	]);
});

test("parseFlowConsoleSelection returns executable flow command text", () => {
	assert.equal(parseFlowConsoleSelection("Prove draft-task")?.command, "task prove draft-task");
	assert.equal(parseFlowConsoleSelection("Run verified-task")?.command, "run verified-task");
	assert.equal(parseFlowConsoleSelection("Review draft-task/run-001")?.command, "task review draft-task/run-001");
	assert.equal(parseFlowConsoleSelection("Show status")?.command, "status");
	assert.equal(parseFlowConsoleSelection("Exit"), undefined);
});

test("buildFlowStageGateOptions offers fixed next actions", () => {
	assert.deepEqual(buildFlowStageGateOptions({ phase: "create", taskId: "x" }).map((item) => item.label), [
		"Continue: prove x",
		"Stop here",
	]);
	assert.deepEqual(buildFlowStageGateOptions({ phase: "prove-pass", taskId: "x", runId: "run-001" }).map((item) => item.label), [
		"Continue: review x/run-001",
		"Stop here",
	]);
	assert.deepEqual(buildFlowStageGateOptions({ phase: "run-pass", taskId: "x", runId: "run-002" }).map((item) => item.label), [
		"Continue: review x/run-002",
		"Stop here",
	]);
	assert.deepEqual(buildFlowStageGateOptions({ phase: "review-accepted", taskId: "x", runId: "run-001" }).map((item) => item.label), [
		"Continue: run x",
		"Stop here",
	]);
});

test("parseFlowStageGateSelection returns the forced next command", () => {
	assert.equal(
		parseFlowStageGateSelection("Continue: review x/run-001", {
			phase: "prove-pass",
			taskId: "x",
			runId: "run-001",
		})?.command,
		"task review x/run-001",
	);
	assert.equal(
		parseFlowStageGateSelection("Continue: run x", {
			phase: "review-accepted",
			taskId: "x",
			runId: "run-001",
		})?.command,
		"run x",
	);
	assert.equal(parseFlowStageGateSelection("Stop here", { phase: "create", taskId: "x" }), undefined);
});
