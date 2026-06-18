import test from "node:test";
import assert from "node:assert/strict";
import {
	buildFlowConsoleOptions,
	buildFlowTaskActionOptions,
	buildFlowTaskListOptions,
	buildFlowStageGateOptions,
	parseFlowConsoleSelection,
	parseFlowStageGateSelection,
} from "../extensions/flow/flow-console.ts";

test("buildFlowConsoleOptions opens high-level flow actions", () => {
	const options = buildFlowConsoleOptions({
		tasks: [
			{ id: "draft-task", status: "draft" },
			{ id: "verified-task", status: "verified" },
		],
	});

	assert.deepEqual(options.map((option) => option.label), [
		"Create task",
		"Tasks",
		"Attach driver",
		"Show status",
		"Exit",
	]);
});

test("buildFlowTaskListOptions lists every task for the second menu", () => {
	const options = buildFlowTaskListOptions([
		{ id: "draft-task", status: "draft" },
		{ id: "verified-task", status: "verified" },
	]);

	assert.deepEqual(options.map((option) => option.label), [
		"draft-task [draft]",
		"verified-task [verified]",
		"Back",
	]);
});

test("buildFlowTaskActionOptions lists status-specific task actions and delete", () => {
	const options = buildFlowTaskActionOptions({
		task: { id: "draft-task", status: "draft" },
		drivers: [
			{ taskId: "draft-task", runId: "run-001", status: "done", step: "validated" },
			{ taskId: "other-task", runId: "run-001", status: "done", step: "validated" },
		],
	});

	assert.deepEqual(options.map((option) => option.label), [
		"Prove draft-task",
		"Review draft-task/run-001",
		"Delete draft-task",
		"Back",
	]);
});

test("buildFlowTaskActionOptions offers run for approved tasks and hides accepted reviews", () => {
	const options = buildFlowTaskActionOptions({
		task: { id: "approved-task", status: "approved" },
		drivers: [
			{ taskId: "approved-task", runId: "run-001", status: "done", step: "validated", reviewStatus: "accepted" },
			{ taskId: "approved-task", runId: "run-002", status: "done", step: "validated" },
		],
	});

	assert.deepEqual(options.map((option) => option.label), [
		"Run approved-task",
		"Review approved-task/run-002",
		"Delete approved-task",
		"Back",
	]);
});

test("parseFlowConsoleSelection returns executable flow command text", () => {
	assert.equal(parseFlowConsoleSelection("Tasks")?.command, "tasks");
	assert.equal(parseFlowConsoleSelection("Prove draft-task")?.command, "task prove draft-task");
	assert.equal(parseFlowConsoleSelection("Run verified-task")?.command, "run verified-task");
	assert.equal(parseFlowConsoleSelection("Review draft-task/run-001")?.command, "task review draft-task/run-001");
	assert.equal(parseFlowConsoleSelection("Delete draft-task")?.command, "task delete draft-task");
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
