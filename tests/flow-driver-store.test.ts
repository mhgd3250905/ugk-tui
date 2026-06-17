import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	appendDriverFeedback,
	createRunArtifacts,
	listDriverSummaries,
	readDriverStatus,
	writeDriverStatus,
} from "../extensions/flow/driver-store.ts";

async function makeTempCwd(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "flow-driver-store-"));
}

test("createRunArtifacts creates run directory and base files", async () => {
	const cwd = await makeTempCwd();
	const taskDir = path.join(cwd, ".flow", "tasks", "demo-task");
	await mkdir(taskDir, { recursive: true });
	await writeFile(path.join(taskDir, "todo.template.md"), "# Template Todo\n\n- prove it\n");

	const artifacts = await createRunArtifacts(cwd, "demo-task", "keyword=UGK", "run-001");

	assert.equal(artifacts.taskId, "demo-task");
	assert.equal(artifacts.runId, "run-001");
	assert.equal(artifacts.taskDir, taskDir);
	assert.equal(artifacts.runDir, path.join(taskDir, "runs", "run-001"));

	assert.equal(await readFile(path.join(artifacts.runDir, "input.json"), "utf8"), '{\n\t"input": "keyword=UGK"\n}\n');
	assert.match(await readFile(path.join(artifacts.runDir, "prompt.md"), "utf8"), /Driver Prompt/);
	assert.equal(await readFile(path.join(artifacts.runDir, "todo.md"), "utf8"), "# Template Todo\n\n- prove it\n");
	assert.match(await readFile(path.join(artifacts.runDir, "progress.md"), "utf8"), /# Progress/);
	assert.match(await readFile(path.join(artifacts.runDir, "progress.md"), "utf8"), /Status: starting/);
	assert.equal(await readFile(path.join(artifacts.runDir, "feedback.md"), "utf8"), "# User Feedback\n\n");

	const status = await readDriverStatus(artifacts.runDir);
	assert.equal(status?.taskId, "demo-task");
	assert.equal(status?.runId, "run-001");
	assert.equal(status?.status, "starting");
	assert.equal(status?.step, "not started");
	assert.equal(status?.summary, "driver created");
});

test("listDriverSummaries reads status files and sorts active runs first", async () => {
	const cwd = await makeTempCwd();
	const doneRunDir = path.join(cwd, ".flow", "tasks", "demo-task", "runs", "run-done");
	const runningRunDir = path.join(cwd, ".flow", "tasks", "demo-task", "runs", "run-running");
	await writeDriverStatus(doneRunDir, {
		taskId: "demo-task",
		runId: "run-done",
		status: "done",
		updatedAt: "2026-06-17T10:00:00.000Z",
	});
	await writeDriverStatus(runningRunDir, {
		taskId: "demo-task",
		runId: "run-running",
		status: "running",
		updatedAt: "2026-06-17T09:00:00.000Z",
	});

	const summaries = await listDriverSummaries(cwd);

	assert.deepEqual(
		summaries.map((summary) => summary.runId),
		["run-running", "run-done"],
	);
	assert.equal(summaries[0].status, "running");
	assert.equal(summaries[0].runDir, runningRunDir);
});

test("appendDriverFeedback records user intervention", async () => {
	const cwd = await makeTempCwd();
	const { runDir } = await createRunArtifacts(cwd, "demo-task", undefined, "run-001");

	await appendDriverFeedback(
		runDir,
		{
			message: "请改用方案 B",
			driverResponse: "已暂停并等待复核",
			affectedStep: "step 2",
		},
		new Date("2026-06-17T12:00:00.000Z"),
	);

	const feedback = await readFile(path.join(runDir, "feedback.md"), "utf8");
	assert.match(feedback, /2026-06-17T12:00:00.000Z/);
	assert.match(feedback, /focus: driver/);
	assert.match(feedback, /请改用方案 B/);
	assert.match(feedback, /已暂停并等待复核/);
	assert.match(feedback, /affected step: step 2/);
	assert.match(feedback, /should review for skill update: unknown/);
});

test("readDriverStatus returns undefined for invalid JSON and falls back unknown status", async () => {
	const cwd = await makeTempCwd();
	const runDir = path.join(cwd, ".flow", "tasks", "demo-task", "runs", "run-001");
	await mkdir(runDir, { recursive: true });
	await writeFile(path.join(runDir, "status.json"), "{not-json");

	assert.equal(await readDriverStatus(runDir), undefined);

	await writeFile(path.join(runDir, "status.json"), '{ "status": "mystery" }\n');

	const status = await readDriverStatus(runDir);
	assert.equal(status?.taskId, "demo-task");
	assert.equal(status?.runId, "run-001");
	assert.equal(status?.status, "paused");
	assert.equal(status?.updatedAt, new Date(0).toISOString());
});
