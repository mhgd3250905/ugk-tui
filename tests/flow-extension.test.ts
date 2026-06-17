import test from "node:test";
import assert from "node:assert/strict";
import { registerFlow } from "../extensions/flow/index.ts";

function makePi() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	return {
		commands,
		handlers,
		pi: {
			registerCommand(name: string, options: any) {
				commands.set(name, options);
			},
			on(event: string, handler: Function) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		},
	};
}

function makeCtx() {
	const notifications: Array<{ message: string; type?: string }> = [];
	return {
		notifications,
		ctx: {
			ui: {
				notify(message: string, type?: string) {
					notifications.push({ message, type });
				},
			},
		},
	};
}

test("registerFlow registers /flow command", () => {
	const { pi, commands } = makePi();

	registerFlow(pi as any);

	assert.ok(commands.has("flow"));
	assert.match(commands.get("flow").description, /Flow/);
});

test('/flow task create "..." queues request and injects hidden task context', async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx, notifications } = makeCtx();
	registerFlow(pi as any);

	await commands.get("flow").handler('task create "整理代码审查流程"', ctx);

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].type, "info");
	assert.match(notifications[0].message, /创建 Task 草案/);
	assert.match(notifications[0].message, /整理代码审查流程/);

	const result = await handlers.get("before_agent_start")![0]();

	assert.equal(result.message.customType, "flow-task-context");
	assert.equal(result.message.display, false);
	assert.match(result.message.content, /\[FLOW TASK CREATE\]/);
	assert.match(result.message.content, /整理代码审查流程/);
});

test("/flow help only notifies and does not inject request", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx, notifications } = makeCtx();
	registerFlow(pi as any);

	await commands.get("flow").handler("", ctx);
	const result = await handlers.get("before_agent_start")![0]();

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].type, "info");
	assert.match(notifications[0].message, /\[FLOW HELP\]/);
	assert.equal(result, undefined);
});

test("flow task context is injected once then cleared", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	registerFlow(pi as any);

	await commands.get("flow").handler("status", ctx);

	const first = await handlers.get("before_agent_start")![0]();
	const second = await handlers.get("before_agent_start")![0]();

	assert.match(first.message.content, /\[FLOW STATUS\]/);
	assert.equal(second, undefined);
});

test("flow context filter removes stale flow task messages when no request is pending", async () => {
	const { pi, handlers } = makePi();
	registerFlow(pi as any);

	const result = await handlers.get("context")![0]({
		messages: [
			{ customType: "flow-task-context", content: "[FLOW TASK CREATE]", display: false },
			{ role: "user", content: "[FLOW TASK RUN]\nold" },
			{ role: "user", content: "正常用户消息" },
		],
	});

	assert.deepEqual(result.messages, [{ role: "user", content: "正常用户消息" }]);
});
