import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFlowTask, updateFlowTaskStatus } from "../extensions/flow/task-store.ts";

function makeTempCwd(): string {
	return mkdtempSync(path.join(tmpdir(), "flow-task-store-"));
}

function writeTask(cwd: string, taskId: string, data: Record<string, unknown> = {}): string {
	const taskDir = path.join(cwd, ".flow", "tasks", taskId);
	mkdirSync(taskDir, { recursive: true });
	writeFileSync(
		path.join(taskDir, "task.json"),
		`${JSON.stringify({ id: taskId, version: 1, status: "draft", ...data }, null, "\t")}\n`,
	);
	return taskDir;
}

test("readFlowTask reads task metadata with task directory", () => {
	const cwd = makeTempCwd();
	const taskDir = writeTask(cwd, "demo-task", { goal: "demo" });

	const task = readFlowTask(cwd, "demo-task");

	assert.equal(task?.id, "demo-task");
	assert.equal(task?.status, "draft");
	assert.equal(task?.version, 1);
	assert.equal(task?.taskDir, taskDir);
	assert.equal(task?.goal, "demo");
});

test("updateFlowTaskStatus preserves metadata and records lifecycle fields", () => {
	const cwd = makeTempCwd();
	const taskDir = writeTask(cwd, "demo-task", { goal: "demo", created_at: "2026-06-18T00:00:00.000Z" });

	updateFlowTaskStatus(cwd, "demo-task", "proved", {
		proven_at: "2026-06-18T01:00:00.000Z",
		latest_prove_run: "run-001",
		next_step: "/flow task review run-001",
	});

	const saved = JSON.parse(readFileSync(path.join(taskDir, "task.json"), "utf8"));
	assert.equal(saved.id, "demo-task");
	assert.equal(saved.goal, "demo");
	assert.equal(saved.created_at, "2026-06-18T00:00:00.000Z");
	assert.equal(saved.status, "proved");
	assert.equal(saved.proven_at, "2026-06-18T01:00:00.000Z");
	assert.equal(saved.latest_prove_run, "run-001");
	assert.equal(saved.next_step, "/flow task review run-001");
});

test("task store rejects invalid task ids", () => {
	const cwd = makeTempCwd();

	assert.throws(() => readFlowTask(cwd, "../../outside"), /Invalid task id/);
	assert.throws(() => updateFlowTaskStatus(cwd, "../../outside", "proved"), /Invalid task id/);
});
