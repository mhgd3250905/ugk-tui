import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { autoMigrateIfNeeded, resignAllRecords, resignTaskRecords, resignUnsignedStatusRecords } from "../extensions/flow/flow-resign.ts";
import { readFlowTask, writeFlowTask, getProjectKey } from "../extensions/flow/task-store.ts";
import { verifyRecord } from "../extensions/flow/flow-signing.ts";
import { readDriverStatus, writeDriverStatus } from "../extensions/flow/driver-store.ts";

function makeTempCwd(): string {
	return mkdtempSync(path.join(tmpdir(), "flow-resign-"));
}

function seedTaskDir(cwd: string, taskId: string): string {
	const taskDir = path.join(cwd, ".flow", "tasks", taskId);
	mkdirSync(taskDir, { recursive: true });
	return taskDir;
}

test("resignAllRecords signs unsigned task.json with current key", () => {
	const cwd = makeTempCwd();
	// 手写无签名 task.json(模拟旧数据)
	const taskDir = seedTaskDir(cwd, "legacy-task");
	writeFileSync(
		path.join(taskDir, "task.json"),
		`${JSON.stringify({ id: "legacy-task", version: 1, status: "draft" }, null, "\t")}\n`,
	);

	const result = resignAllRecords(cwd, "test");
	assert.equal(result.tasks, 1);

	// 验证:重签后 task.json 有合法 _sig
	const onDisk = JSON.parse(readFileSync(path.join(taskDir, "task.json"), "utf8"));
	const check = verifyRecord(getProjectKey(cwd), onDisk);
	assert.equal(check.verified, true);
});

test("resignAllRecords handles multiple tasks and run records", () => {
	const cwd = makeTempCwd();
	// task A + task B,各带一个 run 的 review + validation
	for (const taskId of ["task-a", "task-b"]) {
		const taskDir = seedTaskDir(cwd, taskId);
		writeFileSync(path.join(taskDir, "task.json"), `${JSON.stringify({ id: taskId, version: 1, status: "ready" }, null, "\t")}\n`);
		const runDir = path.join(taskDir, "runs", "run-001");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(path.join(runDir, "review.json"), `${JSON.stringify({ taskId, runId: "run-001", status: "accepted" }, null, "\t")}\n`);
		writeFileSync(path.join(runDir, "validation.json"), `${JSON.stringify({ taskId, runId: "run-001", result: "PASS", scope: "structural", createdAt: "t" }, null, "\t")}\n`);
	}

	const result = resignAllRecords(cwd, "test");
	assert.equal(result.tasks, 2);
	assert.equal(result.reviews, 2);
	assert.equal(result.validations, 2);
	assert.equal(result.skipped, 0);
});

test("resignAllRecords skips malformed JSON without throwing", () => {
	const cwd = makeTempCwd();
	const taskDir = seedTaskDir(cwd, "broken-task");
	writeFileSync(path.join(taskDir, "task.json"), "{ not valid json");

	const result = resignAllRecords(cwd, "test");
	assert.equal(result.tasks, 0);
	assert.equal(result.skipped, 1);
});

test("resignAllRecords writes a reset log", () => {
	const cwd = makeTempCwd();
	seedTaskDir(cwd, "x");
	writeFileSync(path.join(cwd, ".flow", "tasks", "x", "task.json"), `${JSON.stringify({ id: "x", version: 1, status: "draft" })}\n`);

	resignAllRecords(cwd, "manual test");
	const log = readFileSync(path.join(cwd, ".flow", ".signing-reset-log"), "utf8");
	assert.match(log, /manual test/);
	assert.match(log, /tasks: 1/);
});

test("autoMigrateIfNeeded re-signs and closes window when in migration window", () => {
	const cwd = makeTempCwd();
	// 手写无签名 task(旧数据),不触发 writeFlowTask(不关窗口)
	const taskDir = seedTaskDir(cwd, "migrate-task");
	writeFileSync(path.join(taskDir, "task.json"), `${JSON.stringify({ id: "migrate-task", version: 1, status: "ready" }, null, "\t")}\n`);

	const result = autoMigrateIfNeeded(cwd);
	assert.ok(result, "autoMigrate should run in migration window");
	assert.equal(result?.tasks, 1);

	// 窗口已关:readFlowTask 验签通过(签名有效)
	const task = readFlowTask(cwd, "migrate-task");
	assert.equal(task?._signatureBroken, undefined);
});

test("autoMigrateIfNeeded is a no-op when window already closed", () => {
	const cwd = makeTempCwd();
	writeFlowTask(cwd, "anchor", { id: "anchor", version: 1, status: "draft" }); // 关窗口

	const result = autoMigrateIfNeeded(cwd);
	assert.equal(result, undefined, "autoMigrate should not run when window closed");
});

test("autoMigrateIfNeeded is a no-op when no tasks exist", () => {
	const cwd = makeTempCwd();
	// .flow/ 存在但无 tasks
	mkdirSync(path.join(cwd, ".flow"), { recursive: true });
	const result = autoMigrateIfNeeded(cwd);
	assert.equal(result, undefined);
});

// repair-signing 核心:agent 把 task.json 写脏(签名 mismatch)后,单 task 重签恢复。
// 不用删 task 重建。resignTaskRecords 只重签指定 task,不动其他 task。
test("resignTaskRecords recovers a single tampered task without touching others", () => {
	const cwd = makeTempCwd();
	// 两个 task,都用 writeFlowTask 正常签名 + 关窗
	writeFlowTask(cwd, "task-a", { id: "task-a", version: 1, status: "reviewing" });
	writeFlowTask(cwd, "task-b", { id: "task-b", version: 1, status: "ready" });

	// 模拟 agent 把 task-a 的 status 写脏(无签名/签名 mismatch)
	const taskADir = path.join(cwd, ".flow", "tasks", "task-a");
	writeFileSync(
		path.join(taskADir, "task.json"),
		`${JSON.stringify({ id: "task-a", version: 1, status: "active" }, null, "\t")}\n`,
	);

	// task-a 现在验不过(窗口已关)
	const brokenTask = readFlowTask(cwd, "task-a");
	assert.equal(brokenTask?._signatureBroken, true);

	// repair:只重签 task-a
	const result = resignTaskRecords(cwd, "task-a");
	assert.equal(result.tasks, 1);

	// task-a 恢复:验过,且信任当前内容(status: active,但归一后等价 ready)
	const recovered = readFlowTask(cwd, "task-a");
	assert.equal(recovered?._signatureBroken, undefined);
	const onDisk = JSON.parse(readFileSync(path.join(taskADir, "task.json"), "utf8"));
	assert.equal(verifyRecord(getProjectKey(cwd), onDisk).verified, true);

	// task-b 不受影响(仍验过)
	const taskB = readFlowTask(cwd, "task-b");
	assert.equal(taskB?._signatureBroken, undefined);
});

test("resignTaskRecords returns empty counts for missing task", () => {
	const cwd = makeTempCwd();
	const result = resignTaskRecords(cwd, "nonexistent");
	assert.equal(result.tasks, 0);
	assert.equal(result.reviews, 0);
});

// P1 回归:升级兼容。PR #9 之前 status.json 不签名,引入签名后旧 run 的 unsigned
// status 在窗口外被 readDriverStatus 拒绝→run 从菜单消失。resignUnsignedStatusRecords
// 在启动期一次性补签,让升级不破坏现有数据。已签的跳过(不重复写)。
test("resignUnsignedStatusRecords re-signs legacy unsigned status.json (upgrade compat)", () => {
	const cwd = makeTempCwd();
	// 模拟升级前用户:writeFlowTask 关窗口(有签名记录),但 status.json 是旧的 unsigned。
	writeFlowTask(cwd, "legacy-task", { id: "legacy-task", version: 1, status: "ready" });
	const runDir = path.join(cwd, ".flow", "tasks", "legacy-task", "runs", "run-001");
	mkdirSync(runDir, { recursive: true });
	writeFileSync(path.join(runDir, "status.json"), `${JSON.stringify({
		taskId: "legacy-task",
		runId: "run-001",
		status: "done",
		updatedAt: "2026-06-01T00:00:00.000Z",
	}, null, "\t")}\n`);

	// 升级前(窗口已关):unsigned status 读不出来→run 不可见。
	assert.equal(readDriverStatus(runDir, cwd), undefined);

	// 启动期补签。
	const resigned = resignUnsignedStatusRecords(cwd);
	assert.equal(resigned, 1);

	// 补签后:status 可读,run 恢复可见。
	const status = readDriverStatus(runDir, cwd);
	assert.equal(status?.status, "done");
	assert.equal(status?.runId, "run-001");
});

test("resignUnsignedStatusRecords skips already-signed status (no rewrite)", () => {
	const cwd = makeTempCwd();
	writeFlowTask(cwd, "signed-task", { id: "signed-task", version: 1, status: "ready" });
	const runDir = path.join(cwd, ".flow", "tasks", "signed-task", "runs", "run-001");
	mkdirSync(runDir, { recursive: true });
	// 用 writeDriverStatus 写一个已签名的 status。
	writeDriverStatus(runDir, { taskId: "signed-task", runId: "run-001", status: "done" }, cwd);
	const beforeMtime = statSync(path.join(runDir, "status.json")).mtimeMs;

	// 补签:已签的应跳过(mtime 不变)。
	const resigned = resignUnsignedStatusRecords(cwd);
	assert.equal(resigned, 0);
	const afterMtime = statSync(path.join(runDir, "status.json")).mtimeMs;
	assert.equal(afterMtime, beforeMtime);
	// 仍可读。
	assert.equal(readDriverStatus(runDir, cwd)?.status, "done");
});
