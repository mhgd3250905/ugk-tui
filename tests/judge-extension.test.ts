import test from "node:test";
import assert from "node:assert/strict";
import {
	registerJudge,
	setJudgeDecisionSessionFactoryForTests,
	setJudgeDriverFactoryForTests,
	setJudgeVerdictProviderForTests,
} from "../extensions/judge/judge.ts";
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

test("registerJudge registers /judge, questionnaire, and judge_complete tool", async () => {
	const { pi, commands, tools } = makePi();

	registerJudge(pi as any);

	assert.ok(commands.has("judge"));
	assert.ok(tools.some((tool) => tool.name === "questionnaire"));
	const completeTool = tools.find((tool) => tool.name === "judge_complete");
	assert.ok(completeTool);
	const result = await completeTool.execute("call-1", { summary: "完成阶段 3 骨架" });
	assert.match(result.content[0].text, /judge_complete/);
	assert.deepEqual(result.details, { completed: true, summary: "完成阶段 3 骨架" });
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

test("agent_end parses RequirementsSpec and delegate choice starts a real Judge driver", async () => {
	const { pi, commands, handlers, sentMessages } = makePi();
	const { ctx, selections, notifications } = makeCtx();
	const starts: string[] = [];
	const specs: string[] = [];
	const wakeupResults: unknown[] = [];
	setJudgeVerdictProviderForTests(async ({ decidePrompt, spec, summary }: any) => {
		wakeupResults.push({ decidePrompt, spec, summary });
		return { action: "pass", keepWatching: true };
	});
	setJudgeDriverFactoryForTests(async (options: any) => {
		specs.push(options.spec);
		wakeupResults.push(await options.onWakeup({
			reason: "tool_error",
			summary: { pathsTried: ["bash"], turnCount: 1, completed: false },
			transcript: "",
		}));
		return {
			async start() {
				starts.push("start");
			},
			dispose() {},
			getSummary() {
				return { pathsTried: [], turnCount: 0, completed: false };
			},
		};
	});
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setJudgeVerdictProviderForTests(undefined);
	}

	assert.deepEqual(selections.at(-1)?.options, ["委派 driver 执行", "继续澄清", "改需求"]);
	assert.deepEqual(starts, ["start"]);
	assert.equal(sentMessages.length, 0);
	assert.match(specs.at(-1) ?? "", /完成 Judge 阶段 2/);
	assert.deepEqual(wakeupResults.at(-1), { action: "pass", keepWatching: true });
	assert.match((wakeupResults[0] as any).decidePrompt, /DriverSummary/);
	assert.match((wakeupResults[0] as any).spec, /完成 Judge 阶段 2/);
	assert.match(notifications.at(-1)?.message ?? "", /Judge driver started/);
});

test("delegate driver uses ctx.cwd for cwd and runDir", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	(ctx as any).cwd = "E:/workspace/judge-project";
	const received: Array<{ cwd: string; runDir: string }> = [];
	setJudgeDriverFactoryForTests(async (options: any) => {
		received.push({ cwd: options.cwd, runDir: options.runDir });
		return {
			async start() {},
			dispose() {},
			getSummary() {
				return { pathsTried: [], turnCount: 0, completed: false };
			},
		};
	});
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
	}

	assert.equal(received.at(-1)?.cwd, "E:/workspace/judge-project");
	assert.match(received.at(-1)?.runDir ?? "", /^E:[/\\]workspace[/\\]judge-project[/\\]\.judge[/\\]judge-\d+$/);
});

test("session_shutdown disposes the active Judge driver", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	const disposals: string[] = [];
	setJudgeDriverFactoryForTests(async () => ({
		async start() {},
		dispose() {
			disposals.push("dispose");
		},
		getSummary() {
			return { pathsTried: [], turnCount: 0, completed: false };
		},
	}));
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
		await handlers.get("session_shutdown")![0]({}, ctx);
		await handlers.get("session_shutdown")![0]({}, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
	}

	assert.deepEqual(disposals, ["dispose"]);
});

test("injected Judge verdict provider can steer and abort through the delegated driver onWakeup", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	const verdicts = [
		{ action: "steer", direction: "停止写入，先只读确认。", keepWatching: true },
		{ action: "abort", reason: "违反禁止事项" },
	];
	const wakeupResults: unknown[] = [];
	const disposals: string[] = [];
	setJudgeVerdictProviderForTests(async () => verdicts.shift() as any);
	setJudgeDriverFactoryForTests(async (options: any) => ({
		async start() {
			wakeupResults.push(await options.onWakeup({
				reason: "guarded_tool_start",
				summary: { pathsTried: ["write"], turnCount: 1, completed: false },
				transcript: "",
				decidePrompt: "from-driver",
			}));
			wakeupResults.push(await options.onWakeup({
				reason: "tool_error",
				summary: { pathsTried: ["write"], lastError: "write failed", turnCount: 1, completed: false },
				transcript: "",
				decidePrompt: "from-driver",
			}));
		},
		dispose() {
			disposals.push("dispose");
		},
		getSummary() {
			return { pathsTried: [], turnCount: 0, completed: false };
		},
	}));
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setJudgeVerdictProviderForTests(undefined);
	}

	assert.deepEqual(wakeupResults, [
		{ action: "steer", direction: "停止写入，先只读确认。", keepWatching: true },
		{ action: "abort", reason: "违反禁止事项" },
	]);
	assert.deepEqual(disposals, []);
});

test("default Judge wakeup path prompts a Judge decision session and parses pass, steer, and abort", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	const prompts: string[] = [];
	const verdicts = [
		{ action: "pass", keepWatching: true },
		{ action: "steer", direction: "改用只读检查。", keepWatching: true },
		{ action: "abort", reason: "违反硬约束" },
	];
	const wakeupResults: unknown[] = [];
	setJudgeDecisionSessionFactoryForTests(async () => {
		let listener: ((event: any) => void) | undefined;
		return {
			session: {
				isStreaming: false,
				subscribe(callback: (event: any) => void) {
					listener = callback;
					return () => {};
				},
				async prompt(text: string) {
					prompts.push(text);
					const verdict = verdicts.shift();
					listener?.({
						type: "message_update",
						assistantMessageEvent: {
							type: "text_delta",
							delta: `\n${JSON.stringify(verdict)}\n`,
						},
					});
				},
				async steer() {},
				async followUp() {},
				dispose() {},
			},
		};
	});
	setJudgeDriverFactoryForTests(async (options: any) => ({
		async start() {
			for (const reason of ["guarded_tool_start", "tool_error", "agent_end"]) {
				wakeupResults.push(await options.onWakeup({
					reason,
					summary: { pathsTried: ["bash"], turnCount: 1, completed: false },
					transcript: "",
				}));
			}
		},
		dispose() {},
		getSummary() {
			return { pathsTried: [], turnCount: 0, completed: false };
		},
	}));
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setJudgeDecisionSessionFactoryForTests(undefined);
	}

	assert.equal(prompts.length, 3);
	assert.ok(prompts.every((prompt) => /DriverSummary/.test(prompt)));
	assert.match(prompts[0], /完成 Judge 阶段 2/);
	assert.deepEqual(wakeupResults, [
		{ action: "pass", keepWatching: true },
		{ action: "steer", direction: "改用只读检查。", keepWatching: true },
		{ action: "abort", reason: "违反硬约束" },
	]);
});

test("default Judge wakeup path does not reuse an old verdict when the current turn is invalid", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	const outputs = [
		'```json\n{"action":"pass","keepWatching":true}\n```',
		"not parseable verdict",
	];
	const wakeupResults: unknown[] = [];
	setJudgeDecisionSessionFactoryForTests(async () => {
		let listener: ((event: any) => void) | undefined;
		return {
			session: {
				isStreaming: false,
				subscribe(callback: (event: any) => void) {
					listener = callback;
					return () => {};
				},
				async prompt() {
					listener?.({
						type: "message_update",
						assistantMessageEvent: {
							type: "text_delta",
							delta: `\n${outputs.shift()}\n`,
						},
					});
				},
				async steer() {},
				async followUp() {},
				dispose() {},
			},
		};
	});
	setJudgeDriverFactoryForTests(async (options: any) => ({
		async start() {
			for (const reason of ["guarded_tool_start", "tool_error"]) {
				wakeupResults.push(await options.onWakeup({
					reason,
					summary: { pathsTried: ["bash"], turnCount: 1, completed: false },
					transcript: "",
				}));
			}
		},
		dispose() {},
		getSummary() {
			return { pathsTried: [], turnCount: 0, completed: false };
		},
	}));
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setJudgeDecisionSessionFactoryForTests(undefined);
	}

	assert.deepEqual(wakeupResults, [
		{ action: "pass", keepWatching: true },
		{ action: "abort", reason: "Judge verdict parse failed" },
	]);
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
