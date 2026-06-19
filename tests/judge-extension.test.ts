import test from "node:test";
import assert from "node:assert/strict";
import { registerJudge } from "../extensions/judge/judge.ts";
import { ALIGN_PROMPT } from "../extensions/judge/judge-prompts.ts";

function makePi() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const tools: any[] = [];
	const activeTools: string[][] = [];
	const sentMessages: Array<{ message: any; options?: any }> = [];
	const userMessages: string[] = [];
	const entries: Array<{ customType: string; data: unknown }> = [];

	return {
		commands,
		handlers,
		tools,
		activeTools,
		sentMessages,
		userMessages,
		entries,
		pi: {
			registerCommand(name: string, options: any) {
				commands.set(name, options);
			},
			registerTool(tool: any) {
				tools.push(tool);
			},
			setActiveTools(names: string[]) {
				activeTools.push(names);
			},
			on(event: string, handler: Function) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			sendMessage(message: any, options?: any) {
				sentMessages.push({ message, options });
			},
			sendUserMessage(text: string) {
				userMessages.push(text);
			},
			appendEntry(customType: string, data: unknown) {
				entries.push({ customType, data });
			},
		},
	};
}

function makeCtx() {
	const notifications: Array<{ message: string; type?: string }> = [];
	const selections: Array<{ title: string; options: string[] }> = [];
	const editorPrompts: string[] = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		sessionManager: {
			getEntries() {
				return [];
			},
		},
		ui: {
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
			select(title: string, options: string[]) {
				selections.push({ title, options });
				return options[0];
			},
			editor(title: string, value: string) {
				editorPrompts.push(`${title}:${value}`);
				return "请补充验收标准";
			},
		},
	};
	return { ctx, notifications, selections, editorPrompts };
}

function assistantWithSpec() {
	return {
		role: "assistant",
		content: [
			{
				type: "text",
				text: `\`\`\`json
{
  "goal": "完成 Judge 阶段 2",
  "hardConstraints": ["只读工具", "不启动真实 driver"],
  "acceptance": ["注册 /judge", "agent_end 菜单"],
  "forbidden": ["改 Flow 上层行为"],
  "context": "阶段 0 骨架"
}
\`\`\``,
			},
		],
	};
}

test("registerJudge registers /judge and questionnaire tool", () => {
	const { pi, commands, tools } = makePi();

	registerJudge(pi as any);

	assert.ok(commands.has("judge"));
	assert.ok(tools.some((tool) => tool.name === "questionnaire"));
});

test("/judge enters aligning mode, switches to readonly tools, and injects ALIGN_PROMPT", async () => {
	const { pi, commands, handlers, activeTools } = makePi();
	const { ctx, notifications } = makeCtx();
	registerJudge(pi as any);

	await commands.get("judge").handler("", ctx);
	const injected = await handlers.get("before_agent_start")![0]({}, ctx);

	assert.deepEqual(activeTools.at(-1), ["read", "bash", "grep", "find", "ls", "questionnaire"]);
	assert.match(notifications.at(-1)?.message ?? "", /Judge aligning/);
	assert.equal(injected.message.customType, "judge-align-context");
	assert.equal(injected.message.content, ALIGN_PROMPT);
	assert.equal(injected.message.display, false);
});

test("agent_end parses RequirementsSpec and delegate choice only sends driver stub", async () => {
	const { pi, commands, handlers, sentMessages } = makePi();
	const { ctx, selections, notifications } = makeCtx();
	registerJudge(pi as any);

	await commands.get("judge").handler("", ctx);
	await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);

	assert.deepEqual(selections.at(-1)?.options, ["委派 driver 执行", "继续澄清", "改需求"]);
	assert.equal(sentMessages.at(-1)?.message.customType, "judge-driver-stub");
	assert.match(sentMessages.at(-1)?.message.content, /\[JUDGE DRIVER STUB\]/);
	assert.match(sentMessages.at(-1)?.message.content, /完成 Judge 阶段 2/);
	assert.deepEqual(sentMessages.at(-1)?.options, { triggerTurn: false });
	assert.match(notifications.at(-1)?.message ?? "", /stub/);
});

test("agent_end continue clarification keeps aligning and asks the agent to clarify", async () => {
	const { pi, commands, handlers, userMessages } = makePi();
	const { ctx } = makeCtx();
	ctx.ui.select = () => "继续澄清";
	registerJudge(pi as any);

	await commands.get("judge").handler("", ctx);
	await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);

	assert.match(userMessages.at(-1) ?? "", /继续澄清/);
	const injected = await handlers.get("before_agent_start")![0]({}, ctx);
	assert.equal(injected.message.content, ALIGN_PROMPT);
});

test("agent_end edit requirements returns to aligning with editor text", async () => {
	const { pi, commands, handlers, userMessages } = makePi();
	const { ctx } = makeCtx();
	ctx.ui.select = () => "改需求";
	registerJudge(pi as any);

	await commands.get("judge").handler("", ctx);
	await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);

	assert.match(userMessages.at(-1) ?? "", /请补充验收标准/);
});

test("tool_call blocks unsafe bash commands only while Judge is aligning", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	registerJudge(pi as any);

	const beforeJudge = await handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "npm install" } }, ctx);
	assert.equal(beforeJudge, undefined);

	await commands.get("judge").handler("", ctx);

	const safe = await handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "git status --short" } }, ctx);
	assert.equal(safe, undefined);

	const blocked = await handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "npm install" } }, ctx);
	assert.deepEqual(blocked, {
		block: true,
		reason: "Judge aligning: command blocked (not read-only). Command: npm install",
	});
});

test("session_start restores persisted aligning Judge state and readonly tools", async () => {
	const { pi, handlers, activeTools } = makePi();
	const { ctx } = makeCtx();
	ctx.sessionManager.getEntries = () => [
		{
			type: "custom",
			customType: "judge-state",
			data: {
				phase: "aligning",
				spec: {
					goal: "恢复 Judge",
					hardConstraints: ["只读"],
					acceptance: ["注入 prompt"],
					forbidden: [],
					context: "resume",
				},
				summary: "restored",
				steerCount: 2,
				maxSteer: 5,
				keepWatching: true,
			},
		},
	];
	registerJudge(pi as any);

	await handlers.get("session_start")![0]({ reason: "resume" }, ctx);
	const injected = await handlers.get("before_agent_start")![0]({}, ctx);

	assert.deepEqual(activeTools.at(-1), ["read", "bash", "grep", "find", "ls", "questionnaire"]);
	assert.equal(injected.message.content, ALIGN_PROMPT);
});

test("session_start ignores malformed persisted Judge state without enabling aligning", async () => {
	const { pi, handlers, activeTools } = makePi();
	const { ctx } = makeCtx();
	ctx.sessionManager.getEntries = () => [
		{
			type: "custom",
			customType: "judge-state",
			data: {
				phase: "aligning",
				spec: { goal: "missing required arrays" },
				summary: "",
				steerCount: 0,
				maxSteer: 5,
				keepWatching: true,
			},
		},
	];
	registerJudge(pi as any);

	await assert.doesNotReject(() => handlers.get("session_start")![0]({ reason: "resume" }, ctx));
	const injected = await handlers.get("before_agent_start")![0]({}, ctx);

	assert.deepEqual(activeTools, []);
	assert.equal(injected, undefined);
});
