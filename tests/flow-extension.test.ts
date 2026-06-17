import test from "node:test";
import assert from "node:assert/strict";
import { registerFlow } from "../extensions/flow/index.ts";

function makePi() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const sentMessages: Array<{ message: any; options?: any }> = [];
	return {
		commands,
		handlers,
		sentMessages,
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
		},
	};
}

function makeCtx() {
	const notifications: Array<{ message: string; type?: string }> = [];
	return {
		notifications,
		ctx: {
			isIdle() {
				return true;
			},
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

test("flow context filter removes stale flow task messages when no request is pending", async () => {
	const { pi, handlers } = makePi();
	registerFlow(pi as any);

	const normalMessage = { role: "user", content: "正常用户消息" };
	const plainMentionMessage = { role: "user", content: "普通用户消息提到 [FLOW TASK RUN] 但不是旧 prompt" };
	const arrayMentionMessage = { role: "user", content: [{ type: "text", text: "说明文字 [FLOW TASK REVIEW]" }] };

	const result = await handlers.get("context")![0]({
		messages: [
			{ customType: "flow-task-context", content: "[FLOW TASK CREATE]", display: false },
			{ role: "user", content: "[FLOW TASK RUN]\nold" },
			{ role: "user", content: "  [FLOW STATUS]\nold status" },
			{ role: "user", content: [{ type: "text", text: "\n[FLOW TASK PROVE]\nold prove" }] },
			normalMessage,
			plainMentionMessage,
			arrayMentionMessage,
		],
	});

	assert.deepEqual(result.messages, [normalMessage, plainMentionMessage, arrayMentionMessage]);
});
