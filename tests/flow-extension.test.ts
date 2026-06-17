import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerFlow } from "../extensions/flow/index.ts";

function makePi() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const sentMessages: Array<{ message: any; options?: any }> = [];
	const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
	return {
		commands,
		handlers,
		sentMessages,
		entries,
		pi: {
			registerCommand(name: string, options: any) {
				commands.set(name, options);
			},
			on(event: string, handler: Function) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			sendMessage(message: any, options?: any) {
				sentMessages.push({ message, options });
			},
			appendEntry(customType: string, data: unknown) {
				entries.push({ type: "custom", customType, data });
			},
		},
	};
}

function makeCtx(cwd = process.cwd()) {
	const notifications: Array<{ message: string; type?: string }> = [];
	const status = new Map<string, string | undefined>();
	const widgets = new Map<string, unknown>();
	const statusCalls: Array<{ key: string; value: string | undefined }> = [];
	const widgetCalls: Array<{ key: string; value: unknown }> = [];
	return {
		notifications,
		status,
		widgets,
		statusCalls,
		widgetCalls,
		ctx: {
			cwd,
			isIdle() {
				return true;
			},
			sessionManager: {
				getEntries() {
					return [];
				},
			},
			ui: {
				notify(message: string, type?: string) {
					notifications.push({ message, type });
				},
				select(_title: string, options: string[]) {
					return options[0];
				},
				setStatus(key: string, value: string | undefined) {
					status.set(key, value);
					statusCalls.push({ key, value });
				},
				setWidget(key: string, value: unknown) {
					widgets.set(key, value);
					widgetCalls.push({ key, value });
				},
				theme: {
					fg(_name: string, text: string) {
						return text;
					},
				},
			},
		},
	};
}

function makeTempFlowProject(
	drivers: Array<{
		taskId: string;
		runId: string;
		status: string;
		step?: string;
		summary?: string;
		updatedAt?: string;
	}>,
) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flow-extension-"));
	for (const driver of drivers) {
		const runDir = path.join(cwd, ".flow", "tasks", driver.taskId, "runs", driver.runId);
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(
			path.join(runDir, "status.json"),
			`${JSON.stringify(
				{
					taskId: driver.taskId,
					runId: driver.runId,
					status: driver.status,
					step: driver.step,
					summary: driver.summary,
					updatedAt: driver.updatedAt ?? "2026-06-17T00:00:00.000Z",
				},
				null,
				"\t",
			)}\n`,
		);
		fs.writeFileSync(path.join(runDir, "feedback.md"), "# User Feedback\n\n");
	}
	return cwd;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("registerFlow registers /flow command", () => {
	const { pi, commands } = makePi();

	registerFlow(pi as any);

	assert.ok(commands.has("flow"));
	assert.match(commands.get("flow").description, /Flow/);
});

test('/flow task create "..." queues request and injects hidden task context', async () => {
	const { pi, commands, sentMessages } = makePi();
	const { ctx, notifications } = makeCtx();
	registerFlow(pi as any);

	await commands.get("flow").handler('task create "整理代码审查流程"', ctx);

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].type, "info");
	assert.match(notifications[0].message, /创建 Task 草案/);
	assert.match(notifications[0].message, /整理代码审查流程/);

	assert.equal(sentMessages.length, 1);
	assert.equal(sentMessages[0].message.customType, "flow-task-context");
	assert.equal(sentMessages[0].message.display, false);
	assert.match(sentMessages[0].message.content, /\[FLOW TASK CREATE\]/);
	assert.match(sentMessages[0].message.content, /整理代码审查流程/);
	assert.match(sentMessages[0].message.content, /\[FLOW CONTEXT ID: flow-1\]/);
	assert.deepEqual(sentMessages[0].options, { triggerTurn: true });
});

test("/flow help only notifies and does not send request", async () => {
	const { pi, commands, sentMessages } = makePi();
	const { ctx, notifications } = makeCtx();
	registerFlow(pi as any);

	await commands.get("flow").handler("", ctx);

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].type, "info");
	assert.match(notifications[0].message, /\[FLOW HELP\]/);
	assert.equal(sentMessages.length, 0);
});

test("flow command does not run while agent is busy", async () => {
	const { pi, commands, sentMessages } = makePi();
	const { ctx } = makeCtx();
	ctx.isIdle = () => false;
	registerFlow(pi as any);

	await commands.get("flow").handler("status", ctx);

	assert.equal(sentMessages.length, 0);
});

test("context filter preserves current injected flow context and removes stale contexts", async () => {
	const { pi, commands, handlers, sentMessages } = makePi();
	const { ctx } = makeCtx();
	registerFlow(pi as any);

	await commands.get("flow").handler("status", ctx);
	const current = sentMessages[0].message;
	const stale = {
		customType: "flow-task-context",
		content: "[FLOW TASK RUN]\nold",
		display: false,
	};

	const result = await handlers.get("context")![0]({
		messages: [stale, current, { role: "user", content: "正常用户消息" }],
	});

	assert.deepEqual(result.messages, [current, { role: "user", content: "正常用户消息" }]);
});

test("context filter keeps current flow context through agent_end and removes it on the next idle input", async () => {
	const { pi, commands, handlers, sentMessages } = makePi();
	const { ctx } = makeCtx();
	registerFlow(pi as any);

	await commands.get("flow").handler("status", ctx);
	const current = sentMessages[0].message;

	for (const handler of handlers.get("turn_end") ?? []) {
		await handler();
	}
	const afterTurnEnd = await handlers.get("context")![0]({ messages: [current] });

	for (const handler of handlers.get("agent_end") ?? []) {
		await handler();
	}
	const afterAgentEnd = await handlers.get("context")![0]({ messages: [current] });

	await handlers.get("input")![0]({ text: "下一条普通消息", source: "interactive" });
	const afterNextInput = await handlers.get("context")![0]({ messages: [current] });

	assert.deepEqual(afterTurnEnd.messages, [current]);
	assert.deepEqual(afterAgentEnd.messages, [current]);
	assert.deepEqual(afterNextInput.messages, []);
});

test("context filter keeps current flow context for streaming follow-up input", async () => {
	const { pi, commands, handlers, sentMessages } = makePi();
	const { ctx } = makeCtx();
	registerFlow(pi as any);

	await commands.get("flow").handler("status", ctx);
	const current = sentMessages[0].message;

	await handlers.get("input")![0]({ text: "补充说明", source: "interactive", streamingBehavior: "followUp" });
	const result = await handlers.get("context")![0]({ messages: [current] });

	assert.deepEqual(result.messages, [current]);
});

test("/flow status queues a status request", async () => {
	const { pi, commands, sentMessages } = makePi();
	const { ctx, notifications } = makeCtx();
	registerFlow(pi as any);

	await commands.get("flow").handler("status", ctx);

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].type, "info");
	assert.match(notifications[0].message, /查看状态/);
	assert.match(sentMessages[0].message.content, /\[FLOW STATUS\]/);
});

test("/flow attach with no args opens picker and focuses selected driver", async () => {
	const updatedAt = new Date().toISOString();
	const cwd = makeTempFlowProject([
		{
			taskId: "task-a",
			runId: "run-001",
			status: "running",
			step: "step 1",
			updatedAt,
		},
		{
			taskId: "task-b",
			runId: "run-004",
			status: "waiting",
			step: "step 4",
			updatedAt,
		},
		{
			taskId: "task-done",
			runId: "run-009",
			status: "done",
			step: "complete",
			updatedAt,
		},
	]);
	const { pi, commands, sentMessages, entries } = makePi();
	const { ctx, notifications, status } = makeCtx(cwd);
	let pickerOptions: string[] = [];
	ctx.ui.select = async (_title: string, options: string[]) => {
		pickerOptions = options;
		await sleep(1100);
		return options[1];
	};
	registerFlow(pi as any);

	await commands.get("flow").handler("attach", ctx);

	assert.equal(notifications.at(-1)?.type, "info");
	assert.match(notifications.at(-1)?.message ?? "", /Flow driver attached/);
	assert.match(notifications.at(-1)?.message ?? "", /task-b\/run-004/);
	assert.ok(pickerOptions.some((option) => option.includes("done") && option.includes("run-009")));
	assert.deepEqual(entries.at(-1)?.data, { focus: "driver", taskId: "task-b", runId: "run-004" });
	assert.equal(status.get("flow-driver"), "driver:run-004");
	assert.equal(sentMessages.length, 0);
});

test("/flow attach <run-id> warns when run id is ambiguous", async () => {
	const cwd = makeTempFlowProject([
		{ taskId: "task-a", runId: "run-001", status: "running", updatedAt: "2026-06-17T00:00:01.000Z" },
		{ taskId: "task-b", runId: "run-001", status: "waiting", updatedAt: "2026-06-17T00:00:02.000Z" },
	]);
	const { pi, commands, sentMessages, entries } = makePi();
	const { ctx, notifications } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("attach run-001", ctx);

	assert.equal(notifications.at(-1)?.type, "warning");
	assert.match(notifications.at(-1)?.message ?? "", /ambiguous/);
	assert.match(notifications.at(-1)?.message ?? "", /run-001/);
	assert.equal(sentMessages.length, 0);
	assert.equal(entries.length, 0);
});

test("/flow attach <task-id>/<run-id> directly attaches an exact driver", async () => {
	const cwd = makeTempFlowProject([
		{ taskId: "task-a", runId: "run-001", status: "running", updatedAt: "2026-06-17T00:00:01.000Z" },
		{ taskId: "task-b", runId: "run-001", status: "waiting", updatedAt: "2026-06-17T00:00:02.000Z" },
	]);
	const { pi, commands, sentMessages, entries } = makePi();
	const { ctx, notifications } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("attach task-b/run-001", ctx);

	assert.equal(notifications.at(-1)?.type, "info");
	assert.match(notifications.at(-1)?.message ?? "", /task-b\/run-001/);
	assert.deepEqual(entries.at(-1)?.data, { focus: "driver", taskId: "task-b", runId: "run-001" });
	assert.equal(sentMessages.length, 0);
});

test("/flow attach <run-id> direct attach", async () => {
	const cwd = makeTempFlowProject([
		{ taskId: "task-a", runId: "run-001", status: "running", updatedAt: "2026-06-17T00:00:01.000Z" },
	]);
	const { pi, commands, sentMessages } = makePi();
	const { ctx, notifications } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("attach run-001", ctx);

	assert.equal(notifications.at(-1)?.type, "info");
	assert.match(notifications.at(-1)?.message ?? "", /Flow driver attached/);
	assert.match(notifications.at(-1)?.message ?? "", /task-a\/run-001/);
	assert.equal(sentMessages.length, 0);
});

test("/flow attach missing warns", async () => {
	const cwd = makeTempFlowProject([
		{ taskId: "task-a", runId: "run-001", status: "running", updatedAt: "2026-06-17T00:00:01.000Z" },
	]);
	const { pi, commands, sentMessages } = makePi();
	const { ctx, notifications } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("attach run-missing", ctx);

	assert.equal(notifications.at(-1)?.type, "warning");
	assert.match(notifications.at(-1)?.message ?? "", /run-missing/);
	assert.equal(sentMessages.length, 0);
});

test("/flow detach clears focused driver", async () => {
	const cwd = makeTempFlowProject([
		{ taskId: "task-a", runId: "run-001", status: "running", updatedAt: "2026-06-17T00:00:01.000Z" },
	]);
	const { pi, commands, sentMessages, entries } = makePi();
	const { ctx, notifications, status, widgets } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("attach run-001", ctx);
	await commands.get("flow").handler("detach", ctx);

	assert.match(notifications.at(-1)?.message ?? "", /Flow driver detached/);
	assert.deepEqual(entries.at(-1)?.data, { focus: "main" });
	assert.equal(status.get("flow-driver"), undefined);
	assert.equal(widgets.get("flow-driver-view"), undefined);
	assert.equal(sentMessages.length, 0);
});

test("/flow driver status lists drivers", async () => {
	const cwd = makeTempFlowProject([
		{
			taskId: "task-a",
			runId: "run-001",
			status: "running",
			step: "step 1",
			summary: "loading",
			updatedAt: "2026-06-17T00:00:01.000Z",
		},
		{
			taskId: "task-b",
			runId: "run-004",
			status: "waiting",
			step: "step 4",
			summary: "needs input",
			updatedAt: "2026-06-17T00:00:02.000Z",
		},
	]);
	const { pi, commands, sentMessages } = makePi();
	const { ctx, notifications } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("driver status", ctx);

	assert.equal(notifications.at(-1)?.type, "info");
	assert.match(notifications.at(-1)?.message ?? "", /run-001/);
	assert.match(notifications.at(-1)?.message ?? "", /run-004/);
	assert.equal(sentMessages.length, 0);
});

test("driver focus input is handled instead of reaching main", async () => {
	const cwd = makeTempFlowProject([
		{
			taskId: "task-a",
			runId: "run-001",
			status: "running",
			step: "首屏加载",
			updatedAt: "2026-06-17T00:00:01.000Z",
		},
	]);
	const { pi, commands, handlers } = makePi();
	const { ctx, notifications } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("attach run-001", ctx);
	const result = await handlers.get("input")![0]({ text: "停，先等首屏加载", source: "interactive" }, ctx);

	const feedback = fs.readFileSync(
		path.join(cwd, ".flow", "tasks", "task-a", "runs", "run-001", "feedback.md"),
		"utf8",
	);
	assert.deepEqual(result, { action: "handled" });
	assert.match(feedback, /停，先等首屏加载/);
	assert.match(feedback, /affected step: 首屏加载/);
	assert.match(notifications.at(-1)?.message ?? "", /Sent to Flow driver run-001/);
});

test("driver focus input writes feedback to the focused task when run ids collide", async () => {
	const cwd = makeTempFlowProject([
		{
			taskId: "task-a",
			runId: "run-001",
			status: "running",
			step: "wrong task",
			updatedAt: "2026-06-17T00:00:01.000Z",
		},
		{
			taskId: "task-b",
			runId: "run-001",
			status: "waiting",
			step: "right task",
			updatedAt: "2026-06-17T00:00:02.000Z",
		},
	]);
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("attach task-b/run-001", ctx);
	const result = await handlers.get("input")![0]({ text: "只发给 task-b", source: "interactive" }, ctx);

	const taskAFeedback = fs.readFileSync(
		path.join(cwd, ".flow", "tasks", "task-a", "runs", "run-001", "feedback.md"),
		"utf8",
	);
	const taskBFeedback = fs.readFileSync(
		path.join(cwd, ".flow", "tasks", "task-b", "runs", "run-001", "feedback.md"),
		"utf8",
	);
	assert.deepEqual(result, { action: "handled" });
	assert.equal(taskAFeedback, "# User Feedback\n\n");
	assert.match(taskBFeedback, /只发给 task-b/);
	assert.match(taskBFeedback, /affected step: right task/);
});

test("slash input while focused returns continue and does not append feedback", async () => {
	const cwd = makeTempFlowProject([
		{ taskId: "task-a", runId: "run-001", status: "running", updatedAt: "2026-06-17T00:00:01.000Z" },
	]);
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("attach run-001", ctx);
	const result = await handlers.get("input")![0]({ text: "/flow status", source: "interactive" }, ctx);

	const feedback = fs.readFileSync(
		path.join(cwd, ".flow", "tasks", "task-a", "runs", "run-001", "feedback.md"),
		"utf8",
	);
	assert.deepEqual(result, { action: "continue" });
	assert.equal(feedback, "# User Feedback\n\n");
});

test("session_start clears and persists stale focused driver", async () => {
	const cwd = makeTempFlowProject([]);
	const { pi, handlers, entries } = makePi();
	const { ctx, status, widgets } = makeCtx(cwd);
	ctx.sessionManager.getEntries = () => [
		{
			type: "custom",
			customType: "flow-focus",
			data: { focus: "driver", taskId: "task-stale", runId: "run-stale" },
		},
	];
	registerFlow(pi as any);

	await handlers.get("session_start")![0]({ reason: "startup" }, ctx);

	assert.deepEqual(entries.at(-1)?.data, { focus: "main" });
	assert.equal(status.get("flow-driver"), undefined);
	assert.equal(widgets.get("flow-driver-view"), undefined);
});

test("driver commands without drivers notify strings and do not queue hidden prompts", async () => {
	for (const flowCommand of ["attach", "detach", "driver status"]) {
		const cwd = makeTempFlowProject([]);
		const { pi, commands, sentMessages } = makePi();
		const { ctx, notifications } = makeCtx(cwd);
		registerFlow(pi as any);

		await commands.get("flow").handler(flowCommand, ctx);

		assert.equal(notifications.length, 1);
		assert.equal(typeof notifications[0].message, "string");
		assert.doesNotMatch(notifications[0].message, /\[object Object\]/);
		assert.equal(sentMessages.length, 0);
	}
});

test("flow context filter removes stale flow task messages when no request is pending", async () => {
	const { pi, handlers } = makePi();
	registerFlow(pi as any);

	const normalMessage = { role: "user", content: "正常用户消息" };
	const plainMentionMessage = { role: "user", content: "普通用户消息提到 [FLOW TASK RUN] 但不是旧 prompt" };
	const arrayMentionMessage = { role: "user", content: [{ type: "text", text: "说明文字 [FLOW TASK REVIEW]" }] };
	const plainDriverMentionMessage = { role: "user", content: "普通用户消息提到 [FLOW DRIVER ATTACH] 但不是旧 prompt" };
	const arrayDriverMentionMessage = { role: "user", content: [{ type: "text", text: "说明文字 [FLOW DRIVER STATUS]" }] };

	const result = await handlers.get("context")![0]({
		messages: [
			{ customType: "flow-task-context", content: "[FLOW TASK CREATE]", display: false },
			{ role: "user", content: "[FLOW TASK RUN]\nold" },
			{ role: "user", content: "  [FLOW STATUS]\nold status" },
			{ role: "user", content: [{ type: "text", text: "\n[FLOW TASK PROVE]\nold prove" }] },
			{ role: "user", content: "[FLOW DRIVER ATTACH]\nold attach" },
			{ role: "user", content: "  [FLOW DRIVER DETACH]\nold detach" },
			{ role: "user", content: [{ type: "text", text: "\n[FLOW DRIVER STATUS]\nold driver status" }] },
			normalMessage,
			plainMentionMessage,
			arrayMentionMessage,
			plainDriverMentionMessage,
			arrayDriverMentionMessage,
		],
	});

	assert.deepEqual(result.messages, [
		normalMessage,
		plainMentionMessage,
		arrayMentionMessage,
		plainDriverMentionMessage,
		arrayDriverMentionMessage,
	]);
});
