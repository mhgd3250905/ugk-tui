import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acceptReview, rejectReview, startReview } from "../extensions/flow/review-actions.ts";
import { validateFlowRun } from "../extensions/flow/run-validation.ts";
import { startFlowReview } from "../extensions/flow/review-store.ts";
import { readFlowTask, writeFlowTask } from "../extensions/flow/task-store.ts";
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
	validateFlowRun({ taskId, runId, taskDir, runDir, phase: "prove" });
	return { taskId, runId, status: "failed", runDir };
}

/** seed task 到指定状态(transition 的前置)。 */
function seedTask(cwd: string, taskId: string, status: string): void {
	writeFlowTask(cwd, taskId, { id: taskId, version: 1, status });
}

// ---- startReview ----

test("startReview fails when driver is still running", () => {
	const cwd = makeTempCwd();
	const { driver } = makePassRun(cwd);
	seedTask(cwd, "demo-task", "proved");
	const outcome = startReview({ driver, driverLive: true }, cwd);
	assert.equal(outcome.ok, false);
	assert.match((outcome as { reason: string }).reason, /cannot start while the Flow driver is still running/);
});

test("startReview fails when validation is not PASS", () => {
	const cwd = makeTempCwd();
	const driver = makeFailRun(cwd);
	seedTask(cwd, "demo-task", "proved");
	const outcome = startReview({ driver, driverLive: false }, cwd);
	assert.equal(outcome.ok, false);
	assert.match((outcome as { reason: string }).reason, /cannot be start because validation is not PASS/);
});

test("startReview succeeds and transitions task to reviewing", () => {
	const cwd = makeTempCwd();
	const { driver } = makePassRun(cwd);
	seedTask(cwd, "demo-task", "proved");
	const outcome = startReview({ driver, driverLive: false }, cwd);
	assert.equal(outcome.ok, true);
	assert.equal((outcome as { kind: string }).kind, "started");
	// 状态已落盘:proved → reviewing
	assert.equal(readFlowTask(cwd, "demo-task")?.status, "reviewing");
});

test("startReview is rejected by the state machine when task is not proved, and leaves no review.json", () => {
	const cwd = makeTempCwd();
	const { driver, runDir } = makePassRun(cwd);
	seedTask(cwd, "demo-task", "draft"); // draft 不能直接 review-start
	const outcome = startReview({ driver, driverLive: false }, cwd);
	assert.equal(outcome.ok, false);
	assert.match((outcome as { reason: string }).reason, /Illegal transition/);
	// 关键:transition 失败时 review.json 不应落盘(无半提交)
	assert.equal(existsSync(path.join(runDir, "review.json")), false);
});

// ---- acceptReview ----

test("acceptReview fails when no review has started", () => {
	const cwd = makeTempCwd();
	const { driver } = makePassRun(cwd);
	seedTask(cwd, "demo-task", "reviewing");
	const outcome = acceptReview({ driver, driverLive: false }, cwd);
	assert.equal(outcome.ok, false);
	assert.match((outcome as { reason: string }).reason, /Flow review has not started/);
});

test("acceptReview uses 'cannot change' wording for live driver (not 'start')", () => {
	const cwd = makeTempCwd();
	const { driver, runDir } = makePassRun(cwd);
	startFlowReview({ taskId: "demo-task", runId: "run-001", runDir });
	seedTask(cwd, "demo-task", "reviewing");
	const outcome = acceptReview({ driver, driverLive: true }, cwd);
	assert.equal(outcome.ok, false);
	assert.match((outcome as { reason: string }).reason, /cannot change while the Flow driver is still running/);
});

test("acceptReview succeeds and transitions task to ready", () => {
	const cwd = makeTempCwd();
	const { driver, runDir } = makePassRun(cwd);
	startFlowReview({ taskId: "demo-task", runId: "run-001", runDir });
	seedTask(cwd, "demo-task", "reviewing");
	const outcome = acceptReview({ driver, driverLive: false }, cwd);
	assert.equal(outcome.ok, true);
	assert.equal((outcome as { kind: string }).kind, "accepted");
	assert.equal(readFlowTask(cwd, "demo-task")?.status, "ready");
	assert.equal((readFlowTask(cwd, "demo-task") as { ready_origin?: string }).ready_origin, "local-proved");
});

test("acceptReview fails when task metadata is unreadable", () => {
	const cwd = makeTempCwd();
	const { driver, runDir } = makePassRun(cwd);
	startFlowReview({ taskId: "demo-task", runId: "run-001", runDir });
	// 故意不写 task.json → acceptReview 在 acceptFlowReview 前就拒绝
	const outcome = acceptReview({ driver, driverLive: false }, cwd);
	assert.equal(outcome.ok, false);
	assert.match((outcome as { reason: string }).reason, /not found/);
});

test("acceptReview leaves review.json unchanged when state machine rejects the transition", () => {
	const cwd = makeTempCwd();
	const { driver, runDir } = makePassRun(cwd);
	startFlowReview({ taskId: "demo-task", runId: "run-001", runDir });
	// task 在 proved(不是 reviewing)→ transition(review-accept)非法。
	// review.json 此时是 in-review;accept 必须不把它改成 accepted。
	seedTask(cwd, "demo-task", "proved");
	const outcome = acceptReview({ driver, driverLive: false }, cwd);
	assert.equal(outcome.ok, false);
	assert.match((outcome as { reason: string }).reason, /Illegal transition/);
	const onDisk = JSON.parse(readFileSync(path.join(runDir, "review.json"), "utf8"));
	assert.equal(onDisk.status, "in-review", "review.json must stay in-review, not accepted");
});

// ---- rejectReview ----

test("rejectReview fails when no review has started", () => {
	const cwd = makeTempCwd();
	const { driver } = makePassRun(cwd);
	seedTask(cwd, "demo-task", "reviewing");
	const outcome = rejectReview({ driver, driverLive: false }, cwd);
	assert.equal(outcome.ok, false);
	assert.match((outcome as { reason: string }).reason, /Flow review has not started/);
});

test("rejectReview succeeds and transitions task to needs-work", () => {
	const cwd = makeTempCwd();
	const { driver, runDir } = makePassRun(cwd);
	startFlowReview({ taskId: "demo-task", runId: "run-001", runDir });
	seedTask(cwd, "demo-task", "reviewing");
	const outcome = rejectReview({ driver, driverLive: false }, cwd, "证据不足");
	assert.equal(outcome.ok, true);
	assert.equal((outcome as { kind: string }).kind, "rejected");
	assert.equal(readFlowTask(cwd, "demo-task")?.status, "needs-work");
});

test("rejectReview uses 'cannot change' wording for live driver", () => {
	const cwd = makeTempCwd();
	const { driver, runDir } = makePassRun(cwd);
	startFlowReview({ taskId: "demo-task", runId: "run-001", runDir });
	seedTask(cwd, "demo-task", "reviewing");
	const outcome = rejectReview({ driver, driverLive: true }, cwd);
	assert.equal(outcome.ok, false);
	assert.match((outcome as { reason: string }).reason, /cannot change while the Flow driver is still running/);
});
