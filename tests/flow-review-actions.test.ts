import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acceptReview, rejectReview, startReview } from "../extensions/flow/review-actions.ts";
import { validateFlowRun } from "../extensions/flow/run-validation.ts";
import { startFlowReview } from "../extensions/flow/review-store.ts";
import { writeFlowTask } from "../extensions/flow/task-store.ts";
import type { FlowDriverSummary } from "../extensions/flow/types.ts";

function makeTempCwd(): string {
	return mkdtempSync(path.join(tmpdir(), "flow-review-actions-"));
}

/** 造一个完整 PASS 的 run,返回 taskDir/runDir 和 driver 摘要。 */
function makePassRun(cwd: string, taskId = "demo-task", runId = "run-001"): {
	taskDir: string;
	runDir: string;
	driver: FlowDriverSummary;
} {
	const taskDir = path.join(cwd, ".flow", "tasks", taskId);
	const runDir = path.join(taskDir, "runs", runId);
	mkdirSync(path.join(runDir, "output"), { recursive: true });
	mkdirSync(path.join(runDir, "evidence"), { recursive: true });
	writeFileSync(path.join(taskDir, "output.schema.json"), "{}\n");
	writeFileSync(path.join(taskDir, "validator.md"), "# Validator\n");
	writeFileSync(path.join(runDir, "output", "result.json"), JSON.stringify({ summary: "ok" }, null, "\t"));
	writeFileSync(path.join(runDir, "evidence", "e.txt"), "evidence\n");
	writeFileSync(path.join(runDir, "progress.md"), "# Progress\n");
	validateFlowRun({ taskId, runId, taskDir, runDir, phase: "prove" });
	const driver: FlowDriverSummary = {
		taskId,
		runId,
		status: "done",
		step: "validated",
		runDir,
	};
	return { taskDir, runDir, driver };
}

function makeFailRun(cwd: string, taskId = "demo-task", runId = "run-001"): FlowDriverSummary {
	const taskDir = path.join(cwd, ".flow", "tasks", taskId);
	const runDir = path.join(taskDir, "runs", runId);
	mkdirSync(runDir, { recursive: true });
	// 不写 result.json/evidence/progress → validateFlowRun 必 FAIL
	validateFlowRun({ taskId, runId, taskDir, runDir, phase: "prove" });
	return { taskId, runId, status: "failed", runDir };
}

// ---- startReview ----

test("startReview fails when driver is still running", () => {
	const cwd = makeTempCwd();
	const { driver } = makePassRun(cwd);
	const outcome = startReview({ driver, driverLive: true });
	assert.equal(outcome.ok, false);
	assert.match((outcome as { reason: string }).reason, /cannot start while the Flow driver is still running/);
});

test("startReview fails when validation is not PASS", () => {
	const cwd = makeTempCwd();
	const driver = makeFailRun(cwd);
	const outcome = startReview({ driver, driverLive: false });
	assert.equal(outcome.ok, false);
	assert.match((outcome as { reason: string }).reason, /cannot be start because validation is not PASS/);
});

test("startReview succeeds and produces a reviewing next-step intent", () => {
	const cwd = makeTempCwd();
	const { driver } = makePassRun(cwd);
	const outcome = startReview({ driver, driverLive: false });
	assert.equal(outcome.ok, true);
	assert.equal((outcome as { kind: string }).kind, "started");
	assert.match((outcome as { taskNextStep: string }).taskNextStep, /main reviewing demo-task\/run-001/);
});

// ---- acceptReview ----

test("acceptReview fails when no review has started", () => {
	const cwd = makeTempCwd();
	const { driver, taskDir } = makePassRun(cwd);
	writeFlowTask(cwd, "demo-task", { id: "demo-task", version: 1, status: "reviewing" });
	void taskDir;
	const outcome = acceptReview({ driver, driverLive: false }, cwd);
	assert.equal(outcome.ok, false);
	assert.match((outcome as { reason: string }).reason, /Flow review has not started/);
});

test("acceptReview uses 'cannot change' wording for live driver (not 'start')", () => {
	const cwd = makeTempCwd();
	const { driver } = makePassRun(cwd);
	startFlowReview({ taskId: "demo-task", runId: "run-001", runDir: driver.runDir });
	writeFlowTask(cwd, "demo-task", { id: "demo-task", version: 1, status: "reviewing" });
	const outcome = acceptReview({ driver, driverLive: true }, cwd);
	assert.equal(outcome.ok, false);
	// 关键:accept 走 'change' 文案,不是 'start'
	assert.match((outcome as { reason: string }).reason, /cannot change while the Flow driver is still running/);
});

test("acceptReview succeeds and transitions task to verified", () => {
	const cwd = makeTempCwd();
	const { driver, runDir } = makePassRun(cwd);
	startFlowReview({ taskId: "demo-task", runId: "run-001", runDir });
	writeFlowTask(cwd, "demo-task", { id: "demo-task", version: 1, status: "reviewing" });
	const outcome = acceptReview({ driver, driverLive: false }, cwd);
	assert.equal(outcome.ok, true);
	const ok = outcome as { kind: string; taskTransition: { status: string; fields: Record<string, unknown> } };
	assert.equal(ok.kind, "accepted");
	assert.equal(ok.taskTransition.status, "verified");
	assert.equal(ok.taskTransition.fields.latest_review_run, "run-001");
	assert.match(String(ok.taskTransition.fields.next_step), /\/flow run demo-task/);
});

test("acceptReview fails when task metadata is unreadable", () => {
	const cwd = makeTempCwd();
	const { driver, runDir } = makePassRun(cwd);
	startFlowReview({ taskId: "demo-task", runId: "run-001", runDir });
	// 故意不写 task.json → readTaskMetadata 报 not found
	const outcome = acceptReview({ driver, driverLive: false }, cwd);
	assert.equal(outcome.ok, false);
});

// ---- rejectReview ----

test("rejectReview fails when no review has started", () => {
	const cwd = makeTempCwd();
	const { driver } = makePassRun(cwd);
	const outcome = rejectReview({ driver, driverLive: false });
	assert.equal(outcome.ok, false);
	assert.match((outcome as { reason: string }).reason, /Flow review has not started/);
});

test("rejectReview succeeds and transitions task to needs-human", () => {
	const cwd = makeTempCwd();
	const { driver, runDir } = makePassRun(cwd);
	startFlowReview({ taskId: "demo-task", runId: "run-001", runDir });
	const outcome = rejectReview({ driver, driverLive: false }, "证据不足");
	assert.equal(outcome.ok, true);
	const ok = outcome as { kind: string; taskTransition: { status: string; fields: Record<string, unknown> } };
	assert.equal(ok.kind, "rejected");
	assert.equal(ok.taskTransition.status, "needs-human");
	assert.match(String(ok.taskTransition.fields.next_step), /fix demo-task\/run-001/);
});

test("rejectReview uses 'cannot change' wording for live driver", () => {
	const cwd = makeTempCwd();
	const { driver, runDir } = makePassRun(cwd);
	startFlowReview({ taskId: "demo-task", runId: "run-001", runDir });
	const outcome = rejectReview({ driver, driverLive: true });
	assert.equal(outcome.ok, false);
	assert.match((outcome as { reason: string }).reason, /cannot change while the Flow driver is still running/);
});
