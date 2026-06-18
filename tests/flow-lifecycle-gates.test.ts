import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	isTransientDriverStatus,
	readTaskMetadata,
	validateTaskForDriver,
} from "../extensions/flow/lifecycle-gates.ts";
import { acceptFlowReview } from "../extensions/flow/review-store.ts";
import { writeFlowTask } from "../extensions/flow/task-store.ts";

const REQUIRED_ASSETS = ["task.json", "SKILL.md", "todo.template.md", "validator.md", "input.schema.json", "output.schema.json"];

function makeTempCwd(): string {
	return mkdtempSync(path.join(tmpdir(), "flow-gates-"));
}

/** 写一个完整的 task(含全部资产),返回 taskDir。 */
function writeFullTask(
	cwd: string,
	taskId: string,
	meta: Record<string, unknown> = {},
): string {
	const taskDir = path.join(cwd, ".flow", "tasks", taskId);
	mkdirSync(taskDir, { recursive: true });
	writeFlowTask(cwd, taskId, { id: taskId, version: 1, status: "draft", ...meta });
	for (const asset of REQUIRED_ASSETS) {
		if (asset === "task.json") continue;
		if (asset.endsWith(".json")) {
			writeFileSync(path.join(taskDir, asset), "{}\n");
		} else {
			writeFileSync(path.join(taskDir, asset), `# ${asset}\n`);
		}
	}
	return taskDir;
}

function writeAcceptedReview(taskDir: string, runId: string, taskVersion: number): void {
	const runDir = path.join(taskDir, "runs", runId);
	mkdirSync(runDir, { recursive: true });
	acceptFlowReview({ taskId: path.basename(taskDir), runId, runDir, taskVersion });
}

// ---- isTransientDriverStatus ----

test("isTransientDriverStatus flags in-flight statuses and accepts terminal ones", () => {
	for (const status of ["starting", "running", "waiting", "waiting-for-user", "validating"] as const) {
		assert.equal(isTransientDriverStatus(status), true, `${status} should be transient`);
	}
	for (const status of ["done", "failed", "needs-human", "paused"] as const) {
		assert.equal(isTransientDriverStatus(status), false, `${status} should NOT be transient`);
	}
});

// ---- readTaskMetadata ----

test("readTaskMetadata rejects invalid task ids", () => {
	const cwd = makeTempCwd();
	const result = readTaskMetadata(cwd, "../../outside");
	assert.equal(result.ok, false);
	assert.match((result as { message: string }).message, /Invalid task id/);
});

test("readTaskMetadata reports missing task", () => {
	const cwd = makeTempCwd();
	const result = readTaskMetadata(cwd, "ghost-task");
	assert.equal(result.ok, false);
	assert.match((result as { message: string }).message, /not found/);
});

test("readTaskMetadata reads status, version and latest review run", () => {
	const cwd = makeTempCwd();
	writeFullTask(cwd, "demo-task", {
		version: 3,
		status: "verified",
		latest_review_run: "run-002",
	});
	const result = readTaskMetadata(cwd, "demo-task") as Extract<
		ReturnType<typeof readTaskMetadata>,
		{ ok: true }
	>;
	assert.equal(result.ok, true);
	assert.equal(result.status, "verified");
	assert.equal(result.version, 3);
	assert.equal(result.latestReviewRun, "run-002");
});

test("readTaskMetadata treats malformed task.json as invalid metadata", () => {
	const cwd = makeTempCwd();
	const taskDir = path.join(cwd, ".flow", "tasks", "broken-task");
	mkdirSync(taskDir, { recursive: true });
	writeFileSync(path.join(taskDir, "task.json"), "{ not valid json");
	const result = readTaskMetadata(cwd, "broken-task");
	assert.equal(result.ok, false);
	assert.match((result as { message: string }).message, /invalid/);
});

// ---- validateTaskForDriver: prove ----

test("validateTaskForDriver prove passes when all required assets exist", () => {
	const cwd = makeTempCwd();
	writeFullTask(cwd, "demo-task");
	const result = validateTaskForDriver("prove", cwd, "demo-task") as Extract<
		TaskGuardOk,
		{ ok: true }
	>;
	assert.equal(result.ok, true);
});

test("validateTaskForDriver prove fails when required assets are missing", () => {
	const cwd = makeTempCwd();
	const taskDir = path.join(cwd, ".flow", "tasks", "incomplete-task");
	mkdirSync(taskDir, { recursive: true });
	writeFileSync(path.join(taskDir, "task.json"), `${JSON.stringify({ id: "incomplete-task", version: 1, status: "draft" }, null, "\t")}\n`);
	// 缺 SKILL.md / todo.template.md / validator.md / schema 等
	const result = validateTaskForDriver("prove", cwd, "incomplete-task");
	assert.equal(result.ok, false);
	assert.match((result as { message: string }).message, /Runtime gate failed/);
});

// ---- validateTaskForDriver: run ----

type TaskGuardOk = ReturnType<typeof validateTaskForDriver>;

test("validateTaskForDriver run rejects non-runnable status", () => {
	const cwd = makeTempCwd();
	writeFullTask(cwd, "demo-task", { status: "draft" });
	const result = validateTaskForDriver("run", cwd, "demo-task");
	assert.equal(result.ok, false);
	assert.match((result as { message: string }).message, /requires ready/);
});

test("validateTaskForDriver run accepts legacy verified/active/approved as ready", () => {
	const cwd = makeTempCwd();
	// 旧状态名 verified 应被归一为 ready 并放行(只要 review 已接受)
	const taskDir = writeFullTask(cwd, "demo-task", { status: "verified", latest_review_run: "run-001" });
	writeAcceptedReview(taskDir, "run-001", 1);
	const result = validateTaskForDriver("run", cwd, "demo-task") as Extract<
		ReturnType<typeof validateTaskForDriver>,
		{ ok: true }
	>;
	assert.equal(result.ok, true);
});

test("validateTaskForDriver run rejects runnable task without accepted review", () => {
	const cwd = makeTempCwd();
	writeFullTask(cwd, "demo-task", { status: "verified" });
	const result = validateTaskForDriver("run", cwd, "demo-task");
	assert.equal(result.ok, false);
	assert.match((result as { message: string }).message, /no accepted review/);
});

test("validateTaskForDriver run passes when accepted review matches task version", () => {
	const cwd = makeTempCwd();
	const taskDir = writeFullTask(cwd, "demo-task", { status: "verified", latest_review_run: "run-001" });
	writeAcceptedReview(taskDir, "run-001", 1);
	const result = validateTaskForDriver("run", cwd, "demo-task") as Extract<
		TaskGuardOk,
		{ ok: true }
	>;
	assert.equal(result.ok, true);
});

test("validateTaskForDriver run fails when accepted review is stale vs task version", () => {
	const cwd = makeTempCwd();
	// task 升到 version 2,但 review 只认 version 1 → 失败
	const taskDir = writeFullTask(cwd, "demo-task", {
		version: 2,
		status: "verified",
		latest_review_run: "run-001",
	});
	writeAcceptedReview(taskDir, "run-001", 1);
	const result = validateTaskForDriver("run", cwd, "demo-task");
	assert.equal(result.ok, false);
	assert.match((result as { message: string }).message, /not valid for version 2/);
});
