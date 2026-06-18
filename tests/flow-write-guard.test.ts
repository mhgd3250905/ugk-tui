import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, writeFileSync as writeSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { lockTaskAssets } from "../extensions/flow/flow-write-guard.ts";
import { writeFlowTask } from "../extensions/flow/task-store.ts";

const PROTECTED_ASSETS = ["SKILL.md", "todo.template.md", "validator.md", "input.schema.json", "output.schema.json"];

function makeTempCwd(): string {
	return mkdtempSync(path.join(tmpdir(), "flow-write-guard-"));
}

function seedTaskWithAssets(cwd: string, taskId: string): string {
	const taskDir = path.join(cwd, ".flow", "tasks", taskId);
	mkdirSync(taskDir, { recursive: true });
	writeFlowTask(cwd, taskId, { id: taskId, version: 1, status: "proving" });
	for (const asset of PROTECTED_ASSETS) {
		if (asset.endsWith(".json")) {
			writeFileSync(path.join(taskDir, asset), "{}\n");
		} else {
			writeFileSync(path.join(taskDir, asset), `# ${asset}\n`);
		}
	}
	return taskDir;
}

test("lockTaskAssets makes design assets readonly (write fails with EPERM)", () => {
	const cwd = makeTempCwd();
	seedTaskWithAssets(cwd, "demo-task");
	const guard = lockTaskAssets(cwd, "demo-task");

	try {
		assert.ok(guard.lockedPaths.length >= PROTECTED_ASSETS.length);
		for (const protectedFile of PROTECTED_ASSETS) {
			const filePath = path.join(cwd, ".flow", "tasks", "demo-task", protectedFile);
			assert.throws(
				() => writeSync(filePath, "tampered"),
				(err) => (err as NodeJS.ErrnoException).code === "EPERM" || (err as NodeJS.ErrnoException).code === "EACCES",
				`${protectedFile} should be readonly`,
			);
		}
	} finally {
		guard.unlock();
	}
});

test("unlock restores writability", () => {
	const cwd = makeTempCwd();
	seedTaskWithAssets(cwd, "demo-task");
	const guard = lockTaskAssets(cwd, "demo-task");
	guard.unlock();

	// 恢复后所有文件应可写
	for (const protectedFile of PROTECTED_ASSETS) {
		const filePath = path.join(cwd, ".flow", "tasks", "demo-task", protectedFile);
		writeFileSync(filePath, "restored content");
		assert.equal(readFileSync(filePath, "utf8"), "restored content");
	}
});

test("unlock is idempotent", () => {
	const cwd = makeTempCwd();
	seedTaskWithAssets(cwd, "demo-task");
	const guard = lockTaskAssets(cwd, "demo-task");
	guard.unlock();
	// 二次 unlock 不抛错
	assert.doesNotThrow(() => guard.unlock());
});

test("task.json is NOT locked (runtime writes status during driver)", () => {
	const cwd = makeTempCwd();
	seedTaskWithAssets(cwd, "demo-task");
	const guard = lockTaskAssets(cwd, "demo-task");
	try {
		// task.json 必须保持可写 — runtime 的 transition 在 driver 期间要写 status
		const taskJson = path.join(cwd, ".flow", "tasks", "demo-task", "task.json");
		assert.doesNotThrow(() => writeFileSync(taskJson, JSON.stringify({ status: "proved" })));
	} finally {
		guard.unlock();
	}
});

test("lockTaskAssets skips missing assets without throwing", () => {
	const cwd = makeTempCwd();
	// 只写 task.json,不写设计资产
	const taskDir = path.join(cwd, ".flow", "tasks", "partial-task");
	mkdirSync(taskDir, { recursive: true });
	writeFlowTask(cwd, "partial-task", { id: "partial-task", version: 1, status: "proving" });

	const guard = lockTaskAssets(cwd, "partial-task");
	assert.equal(guard.lockedPaths.length, 0); // 没有设计资产可锁
	guard.unlock();
});
