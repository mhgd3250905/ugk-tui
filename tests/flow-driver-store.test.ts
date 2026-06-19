import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	appendDriverFeedback,
	createRunArtifacts,
	listDriverSummaries,
	nextRunId,
	readDriverStatus,
	writeDriverStatus,
} from "../extensions/flow/driver-store.ts";
import { closeMigrationWindow } from "../extensions/flow/task-store.ts";

function makeTempCwd(): string {
	return mkdtempSync(path.join(tmpdir(), "flow-driver-store-"));
}

test("createRunArtifacts creates run directory and base files", () => {
	const cwd = makeTempCwd();
	const taskDir = path.join(cwd, ".flow", "tasks", "demo-task");
	mkdirSync(taskDir, { recursive: true });
	writeFileSync(path.join(taskDir, "todo.template.md"), "# Template Todo\n\n- prove it\n");

	const artifacts = createRunArtifacts(cwd, "demo-task", "keyword=UGK", "run-001");

	assert.equal(artifacts.taskId, "demo-task");
	assert.equal(artifacts.runId, "run-001");
	assert.equal(artifacts.taskDir, taskDir);
	assert.equal(artifacts.runDir, path.join(taskDir, "runs", "run-001"));

	assert.equal(readFileSync(path.join(artifacts.runDir, "input.json"), "utf8"), '{\n\t"input": "keyword=UGK"\n}\n');
	assert.match(readFileSync(path.join(artifacts.runDir, "prompt.md"), "utf8"), /Driver Prompt/);
	assert.equal(readFileSync(path.join(artifacts.runDir, "todo.md"), "utf8"), "# Template Todo\n\n- prove it\n");
	assert.match(readFileSync(path.join(artifacts.runDir, "progress.md"), "utf8"), /# Progress/);
	assert.match(readFileSync(path.join(artifacts.runDir, "progress.md"), "utf8"), /Status: starting/);
	assert.equal(readFileSync(path.join(artifacts.runDir, "feedback.md"), "utf8"), "# User Feedback\n\n");

	const status = readDriverStatus(artifacts.runDir, cwd);
	assert.equal(status?.taskId, "demo-task");
	assert.equal(status?.runId, "run-001");
	assert.equal(status?.status, "starting");
	assert.equal(status?.step, "not started");
	assert.equal(status?.summary, "driver created");
});

test("listDriverSummaries reads status files and sorts active runs first", () => {
	const cwd = makeTempCwd();
	const doneRunDir = path.join(cwd, ".flow", "tasks", "demo-task", "runs", "run-done");
	const runningRunDir = path.join(cwd, ".flow", "tasks", "demo-task", "runs", "run-running");
	writeDriverStatus(doneRunDir, {
		taskId: "demo-task",
		runId: "run-done",
		status: "done",
		updatedAt: "2026-06-17T10:00:00.000Z",
	}, cwd);
	writeDriverStatus(runningRunDir, {
		taskId: "demo-task",
		runId: "run-running",
		status: "running",
		updatedAt: "2026-06-17T09:00:00.000Z",
	}, cwd);

	const summaries = listDriverSummaries(cwd);

	assert.deepEqual(
		summaries.map((summary) => summary.runId),
		["run-running", "run-done"],
	);
	assert.equal(summaries[0].status, "running");
	assert.equal(summaries[0].runDir, runningRunDir);
});

test("appendDriverFeedback records user intervention", () => {
	const cwd = makeTempCwd();
	const { runDir } = createRunArtifacts(cwd, "demo-task", undefined, "run-001");

	appendDriverFeedback(
		runDir,
		{
			message: "请改用方案 B",
			driverResponse: "已暂停并等待复核",
			affectedStep: "step 2",
		},
		new Date("2026-06-17T12:00:00.000Z"),
	);

	const feedback = readFileSync(path.join(runDir, "feedback.md"), "utf8");
	assert.match(feedback, /2026-06-17T12:00:00.000Z/);
	assert.match(feedback, /focus: driver/);
	assert.match(feedback, /请改用方案 B/);
	assert.match(feedback, /已暂停并等待复核/);
	assert.match(feedback, /affected step: step 2/);
	assert.match(feedback, /should review for skill update: unknown/);
});

test("readDriverStatus returns undefined for invalid JSON and falls back unknown status", () => {
	const cwd = makeTempCwd();
	const runDir = path.join(cwd, ".flow", "tasks", "demo-task", "runs", "run-001");
	mkdirSync(runDir, { recursive: true });
	writeFileSync(path.join(runDir, "status.json"), "{not-json");

	assert.equal(readDriverStatus(runDir, cwd), undefined);

	writeFileSync(path.join(runDir, "status.json"), '{ "status": "mystery" }\n');

	const status = readDriverStatus(runDir, cwd);
	assert.equal(status?.taskId, "demo-task");
	assert.equal(status?.runId, "run-001");
	assert.equal(status?.status, "paused");
	assert.equal(status?.updatedAt, new Date(0).toISOString());
});

test("readDriverStatus treats completed as a done status alias", () => {
	const cwd = makeTempCwd();
	const runDir = path.join(cwd, ".flow", "tasks", "demo-task", "runs", "run-001");
	mkdirSync(runDir, { recursive: true });
	writeFileSync(path.join(runDir, "status.json"), '{ "status": "completed", "summary": "PASS" }\n');

	const status = readDriverStatus(runDir, cwd);

	assert.equal(status?.taskId, "demo-task");
	assert.equal(status?.runId, "run-001");
	assert.equal(status?.status, "done");
	assert.equal(status?.summary, "PASS");
});

test("store helpers reject task ids that would escape the flow tasks directory", () => {
	const cwd = makeTempCwd();
	const outsideDir = path.resolve(cwd, "outside", "runs");

	assert.throws(() => nextRunId(cwd, "../../outside"), /Invalid task id/);
	assert.throws(() => createRunArtifacts(cwd, "../../outside", undefined, "run-001"), /Invalid task id/);
	assert.equal(existsSync(outsideDir), false);
});

// 回归:status.json 状态分裂。status.json 驱动 driverLive / session_shutdown / picker
// 排序等决策,agent 可手写(driver 工作区够得着)。迁移窗口关闭后,手写无签名 status.json
// 必须读为 undefined(不返回伪造状态);runtime 写的带签名记录正常返回。
test("readDriverStatus rejects unsigned forged status after migration window closes (state-split regression)", () => {
	const cwd = makeTempCwd();
	const runDir = path.join(cwd, ".flow", "tasks", "demo-task", "runs", "run-001");
	mkdirSync(runDir, { recursive: true });
	closeMigrationWindow(cwd);

	// 模拟 agent 手写伪造 status.json(无 _sig,status: done——可骗过 driverLive 判定)
	writeFileSync(
		path.join(runDir, "status.json"),
		`${JSON.stringify(
			{
				taskId: "demo-task",
				runId: "run-001",
				status: "done",
				step: "validated",
				summary: "forged PASS",
				updatedAt: "2026-06-19T00:00:00.000Z",
			},
			null,
			"\t",
		)}\n`,
	);

	// 伪造记录被挡:返回 undefined,不返回假 done。
	assert.equal(readDriverStatus(runDir, cwd), undefined);

	// 对照:runtime 用 writeDriverStatus 写的带签名记录正常返回。
	writeDriverStatus(runDir, {
		taskId: "demo-task",
		runId: "run-001",
		status: "done",
		step: "validated",
		summary: "real PASS",
	}, cwd);
	const status = readDriverStatus(runDir, cwd);
	assert.equal(status?.status, "done");
	assert.equal(status?.summary, "real PASS");
});
