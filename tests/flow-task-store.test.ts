import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deleteFlowTask, readFlowTask, signFlowTaskOnDiskIfUnsigned, updateFlowTaskStatus, writeFlowTask } from "../extensions/flow/task-store.ts";

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

test("deleteFlowTask removes a task directory and reports whether it existed", () => {
	const cwd = makeTempCwd();
	const taskDir = writeTask(cwd, "demo-task");

	assert.equal(deleteFlowTask(cwd, "demo-task"), true);
	assert.equal(existsSync(taskDir), false);
	assert.equal(deleteFlowTask(cwd, "demo-task"), false);
});

test("task store rejects invalid task ids", () => {
	const cwd = makeTempCwd();

	assert.throws(() => readFlowTask(cwd, "../../outside"), /Invalid task id/);
	assert.throws(() => updateFlowTaskStatus(cwd, "../../outside", "proved"), /Invalid task id/);
	assert.throws(() => deleteFlowTask(cwd, "../../outside"), /Invalid task id/);
});

// ---- 签名链:task.json 完整性 ----

test("writeFlowTask signs task.json and closes the migration window", () => {
	const cwd = makeTempCwd();
	writeFlowTask(cwd, "signed-task", { id: "signed-task", version: 1, status: "draft" });
	// 写入后 task.json 应带 _sig,迁移窗口应关闭
	const onDisk = JSON.parse(readFileSync(path.join(cwd, ".flow", "tasks", "signed-task", "task.json"), "utf8"));
	assert.ok(onDisk._sig, "task.json must carry a _sig after write");
	assert.ok(Array.isArray(onDisk._sig.covered));
	// 窗口关闭的行为验证:再手写一个无 _sig 的 task,应被标记损坏
	const forgedDir = path.join(cwd, ".flow", "tasks", "forged-after-close");
	mkdirSync(forgedDir, { recursive: true });
	writeFileSync(
		path.join(forgedDir, "task.json"),
		`${JSON.stringify({ id: "forged-after-close", version: 1, status: "ready" }, null, "\t")}\n`,
	);
	assert.equal(readFlowTask(cwd, "forged-after-close")?._signatureBroken, true, "unsigned record after window close must be broken");
	// 关键:删 .flow/.migrated 不能重开窗口(标记不在 .flow/ 里)
	const dotFlow = path.join(cwd, ".flow");
	// .flow/ 里不该有 .migrated
	assert.equal(existsSync(path.join(dotFlow, ".migrated")), false, "marker must NOT live inside .flow/");
});

test("readFlowTask trusts signed records after the migration window closes", () => {
	const cwd = makeTempCwd();
	writeFlowTask(cwd, "ok-task", { id: "ok-task", version: 1, status: "draft" });
	// writeFlowTask 已签名 + 关闭窗口;正常读不应标记损坏
	const task = readFlowTask(cwd, "ok-task");
	assert.equal(task?._signatureBroken, undefined);
	assert.equal(task?.status, "draft");
});

test("readFlowTask flags a tampered status as broken after the window closes", () => {
	const cwd = makeTempCwd();
	writeFlowTask(cwd, "tampered-task", { id: "tampered-task", version: 1, status: "ready" });
	// agent 直接改文件(绕过 runtime),改 status 但保留旧 _sig
	const taskJsonPath = path.join(cwd, ".flow", "tasks", "tampered-task", "task.json");
	const onDisk = JSON.parse(readFileSync(taskJsonPath, "utf8"));
	onDisk.status = "needs-work"; // 篡改
	writeFileSync(taskJsonPath, `${JSON.stringify(onDisk, null, "\t")}\n`);

	const task = readFlowTask(cwd, "tampered-task");
	assert.equal(task?._signatureBroken, true, "tampered record must be flagged broken");
});

test("readFlowTask flags a record with no _sig as broken once the window closed", () => {
	const cwd = makeTempCwd();
	writeFlowTask(cwd, "anchor-task", { id: "anchor-task", version: 1, status: "draft" }); // 触发窗口关闭
	// 现在直接手写一个无 _sig 的 task(模拟 agent 伪造)
	const fakeDir = path.join(cwd, ".flow", "tasks", "forged-task");
	mkdirSync(fakeDir, { recursive: true });
	writeFileSync(
		path.join(fakeDir, "task.json"),
		`${JSON.stringify({ id: "forged-task", version: 1, status: "ready" }, null, "\t")}\n`,
	);

	const task = readFlowTask(cwd, "forged-task");
	assert.equal(task?._signatureBroken, true, "unsigned record after window close must be broken");
});

test("unsigned records are trusted inside the migration window (legacy data)", () => {
	const cwd = makeTempCwd();
	// 不触发 writeFlowTask(不关闭窗口),直接手写旧格式 task
	const legacyDir = path.join(cwd, ".flow", "tasks", "legacy-task");
	mkdirSync(legacyDir, { recursive: true });
	writeFileSync(
		path.join(legacyDir, "task.json"),
		`${JSON.stringify({ id: "legacy-task", version: 1, status: "active" }, null, "\t")}\n`,
	);

	const task = readFlowTask(cwd, "legacy-task");
	assert.equal(task?._signatureBroken, undefined, "legacy unsigned record trusted inside window");
	assert.equal(task?.status, "active");
});

// P1-c 回归:asset repair 路径的 signFlowTaskOnDiskIfUnsigned 不得把既有 task(已签名)
// 的篡改洗白。既有 task 的 task.json 已有签名,repair 期间 agent 若改了 status,该函数
// 不应重签(交给验签挡住 + 显式 repair-signing)。只对完全无签名的新建 task 首签。
test("signFlowTaskOnDiskIfUnsigned skips already-signed task (does not legitimize tampering)", () => {
	const cwd = makeTempCwd();
	const taskDir = path.join(cwd, ".flow", "tasks", "existing-task");
	mkdirSync(taskDir, { recursive: true });
	// 既有 task:runtime 已签名(status: reviewing)。
	writeFlowTask(cwd, "existing-task", { id: "existing-task", version: 1, status: "reviewing" });
	// 模拟 repair 期间 agent 篡改:改 status 为 ready,保留旧 _sig(签名算不出 → mismatch)。
	const onDisk = JSON.parse(readFileSync(path.join(taskDir, "task.json"), "utf8"));
	onDisk.status = "ready";
	writeFileSync(path.join(taskDir, "task.json"), `${JSON.stringify(onDisk, null, "\t")}\n`);

	// repair 路径调 signFlowTaskOnDiskIfUnsigned:既有签名 → 不动(返回 false)。
	const signed = signFlowTaskOnDiskIfUnsigned(cwd, "existing-task");
	assert.equal(signed, false);
	// task.json 仍是被篡改状态,验签挡住(readFlowTask 标 _signatureBroken)。
	const task = readFlowTask(cwd, "existing-task");
	assert.equal(task?._signatureBroken, true);
});

test("signFlowTaskOnDiskIfUnsigned signs unsigned new task and forces draft status", () => {
	const cwd = makeTempCwd();
	const taskDir = path.join(cwd, ".flow", "tasks", "new-task");
	mkdirSync(taskDir, { recursive: true });
	// 新建 task:agent 手写(无 _sig),且违规写了 status: ready。
	writeFileSync(
		path.join(taskDir, "task.json"),
		`${JSON.stringify({ id: "new-task", version: 1, status: "ready", goal: "test" }, null, "\t")}\n`,
	);

	// 首签:无签名 → 签,但强制 status=draft(create 阶段不该有非 draft 状态)。
	const signed = signFlowTaskOnDiskIfUnsigned(cwd, "new-task");
	assert.equal(signed, true);
	const task = readFlowTask(cwd, "new-task");
	assert.equal(task?.status, "draft");
	assert.equal(task?._signatureBroken, undefined);
});
