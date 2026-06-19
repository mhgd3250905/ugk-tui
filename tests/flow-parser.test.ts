import test from "node:test";
import assert from "node:assert/strict";
import { parseFlowCommand } from "../extensions/flow/parser.ts";

test("parses task create with quoted natural language goal", () => {
	assert.deepEqual(parseFlowCommand('task create "在 X 上搜索指定关键词，收集最近相关帖子并总结"'), {
		kind: "task-create",
		goal: "在 X 上搜索指定关键词，收集最近相关帖子并总结",
	});
});

test("parses task create without quotes as the whole remaining goal", () => {
	assert.deepEqual(parseFlowCommand("task create 在 X 上搜索 Medtrum"), {
		kind: "task-create",
		goal: "在 X 上搜索 Medtrum",
	});
});

test("parses prove run review and status commands", () => {
	assert.deepEqual(parseFlowCommand("task prove x-search-post-collector"), {
		kind: "task-prove",
		taskId: "x-search-post-collector",
		input: undefined,
	});
	assert.deepEqual(parseFlowCommand('task prove x-search-post-collector --input "keyword=Medtrum"'), {
		kind: "task-prove",
		taskId: "x-search-post-collector",
		input: "keyword=Medtrum",
	});
	assert.deepEqual(parseFlowCommand("run x-search-post-collector"), {
		kind: "task-run",
		taskId: "x-search-post-collector",
		input: undefined,
	});
	assert.deepEqual(parseFlowCommand("task start x-search-post-collector"), {
		kind: "task-run",
		taskId: "x-search-post-collector",
		input: undefined,
	});
	assert.deepEqual(parseFlowCommand("task review run-001"), {
		kind: "task-review",
		runId: "run-001",
	});
	assert.deepEqual(parseFlowCommand("task accept run-001"), {
		kind: "task-accept",
		runId: "run-001",
	});
	assert.deepEqual(parseFlowCommand('task reject run-001 "证据不足"'), {
		kind: "task-reject",
		runId: "run-001",
		reason: "证据不足",
	});
	assert.deepEqual(parseFlowCommand("task delete x-search-post-collector"), {
		kind: "task-delete",
		taskId: "x-search-post-collector",
	});
	assert.deepEqual(parseFlowCommand("status"), {
		kind: "status",
	});
});

test("returns help for empty or unsupported flow commands", () => {
	assert.deepEqual(parseFlowCommand(""), { kind: "help" });
	assert.deepEqual(parseFlowCommand("banana"), { kind: "help" });
	assert.deepEqual(parseFlowCommand("task create"), {
		kind: "error",
		message: 'Usage: /flow task create "自然语言目标"',
	});
	assert.deepEqual(parseFlowCommand("task prove"), {
		kind: "error",
		message: "Usage: /flow task prove <task-id> [--input <inline-input>]",
	});
	assert.deepEqual(parseFlowCommand("task start"), {
		kind: "error",
		message: "Usage: /flow task start <task-id> [--input <inline-input>]",
	});
	assert.deepEqual(parseFlowCommand("task delete"), {
		kind: "error",
		message: "Usage: /flow task delete <task-id>",
	});
});

test("parses interactive driver commands", () => {
	assert.deepEqual(parseFlowCommand("attach"), {
		kind: "attach",
		runId: undefined,
	});
	assert.deepEqual(parseFlowCommand("attach run-001"), {
		kind: "attach",
		runId: "run-001",
	});
	assert.deepEqual(parseFlowCommand("detach"), {
		kind: "detach",
	});
	assert.deepEqual(parseFlowCommand("driver status"), {
		kind: "driver-status",
	});
});

test("rejects invalid task ids for task prove and run", () => {
	for (const taskId of ["../x", "..\\x", "x/y", "_x", "x_", "x--y", "X", ""]) {
		const proveCommand = taskId ? `task prove ${taskId}` : "task prove";
		const runCommand = taskId ? `run ${taskId}` : "run";
		const startCommand = taskId ? `task start ${taskId}` : "task start";

		assert.equal(parseFlowCommand(proveCommand).kind, "error");
		assert.equal(parseFlowCommand(runCommand).kind, "error");
		assert.equal(parseFlowCommand(startCommand).kind, "error");
		assert.equal(parseFlowCommand(taskId ? `task delete ${taskId}` : "task delete").kind, "error");
	}
});

test("parses repair-signing with task id", () => {
	assert.deepEqual(parseFlowCommand("repair-signing my-task"), {
		kind: "repair-signing",
		taskId: "my-task",
	});
	// 无参数报 usage
	assert.equal(parseFlowCommand("repair-signing").kind, "error");
	// 非法 task id 报错
	assert.equal(parseFlowCommand("repair-signing ../x").kind, "error");
});
