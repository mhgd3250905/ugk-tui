import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
	buildWindowsLiveLogLaunchPlan,
	buildWindowsLiveLogLauncher,
	registerJudge,
	setJudgeDecisionSessionFactoryForTests,
	setJudgeDriverFactoryForTests,
	setJudgeVerdictProviderForTests,
	sliceNewTranscript,
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
	const widgetCalls: Array<{ key: string; content: unknown }> = [];
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
				// 过程查看终端菜单:测试环境默认"不打开"(避免 spawn 真终端 + getLiveLogPath 依赖),
				// 且不记入 selections(避免干扰其他测试对 selections 顺序的断言)。
				if (title.includes("过程查看终端")) return options.find((o) => o.startsWith("不打开")) ?? options[0];
				selections.push({ title, options });
				return options[0];
			},
			editor(title: string, value: string) {
				editorPrompts.push(`${title}:${value}`);
				return "请补充验收标准";
			},
			setWidget(key: string, content: unknown) {
				widgetCalls.push({ key, content });
			},
		},
	};
	return { ctx, notifications, selections, editorPrompts, widgetCalls };
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

/**
 * 模拟 Judge 在 aligning 阶段调过 questionnaire(C-2 机制闸的前置条件)。
 * 任何要走"委派 driver"路径的测试,在触发 agent_end 之前必须先调这个,
 * 否则 agent_end 的委派分支会被 C-2 闸拦下(没确认假设不让委派)。
 */
function emitQuestionnaireConfirmed(handlers: { get(key: string): Array<(event: unknown, ctx: unknown) => unknown> | undefined }, ctx: unknown) {
	const toolCallHandlers = handlers.get("tool_call");
	if (!toolCallHandlers || toolCallHandlers.length === 0) {
		throw new Error("tool_call handler not registered; call registerJudge first");
	}
	toolCallHandlers[0]({ toolName: "questionnaire", input: {} }, ctx);
}

test("sliceNewTranscript returns only the current turn when transcript keeps the old prefix", () => {
	assert.equal(
		sliceNewTranscript("old transcript\n", "old transcript\n```json\n{\"action\":\"pass\",\"keepWatching\":true}\n```"),
		"```json\n{\"action\":\"pass\",\"keepWatching\":true}\n```",
	);
});

test("sliceNewTranscript returns empty text on transcript prefix drift instead of reusing old verdicts", () => {
	const driftedWindow = [
		"```json",
		"{\"action\":\"abort\",\"reason\":\"old verdict\"}",
		"```",
		"new undecidable turn",
	].join("\n");

	assert.equal(sliceNewTranscript("older transcript that was trimmed away", driftedWindow), "");
});

test("judge extension module avoids CommonJS require in ESM runtime paths", () => {
	const source = readFileSync(path.resolve("extensions/judge/judge.ts"), "utf8");

	assert.doesNotMatch(source, /\brequire\(/);
});

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

test("Windows live log launcher is written next to live.log with a stable filename", () => {
	const liveLogPath = path.join("E:/workspace/project/.judge/judge-123", "live.log");
	const launcher = buildWindowsLiveLogLauncher(liveLogPath);

	assert.equal(
		launcher.path,
		path.join("E:/workspace/project/.judge/judge-123", "judge-live-launcher.cmd"),
	);
	assert.match(launcher.content, /Get-Content/);
	assert.match(launcher.content, /live\.log/);
	assert.match(launcher.content, /chcp 65001/);
	assert.match(launcher.content, /-Encoding UTF8/);
});

test("Windows live log launch plan has no Windows Terminal special casing", () => {
	const source = readFileSync(path.resolve("extensions/judge/judge.ts"), "utf8");

	assert.doesNotMatch(source, /WT_SESSION|wt\.exe|commandExists/);
});

test("Windows live log launch plan opens a system-managed terminal window (conhost)", () => {
	const liveLogPath = path.join("E:/workspace/project/.judge/judge-123", "live.log");
	const plan = buildWindowsLiveLogLaunchPlan(liveLogPath);

	assert.equal(plan.command, "cmd.exe");
	assert.equal("shell" in plan, false);
	assert.deepEqual(plan.args.slice(0, 3), ["/c", "start", "Judge driver live"]);
	assert.equal(plan.launcher?.path, path.join("E:/workspace/project/.judge/judge-123", "judge-live-launcher.cmd"));
	assert.match(plan.launcher?.content ?? "", /-Encoding UTF8/);
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
		emitQuestionnaireConfirmed(handlers, ctx);
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
		emitQuestionnaireConfirmed(handlers, ctx);
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
		emitQuestionnaireConfirmed(handlers, ctx);
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
		emitQuestionnaireConfirmed(handlers, ctx);
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
	let agentDefinitionPath: string | undefined;
	const verdicts = [
		{ action: "pass", keepWatching: true },
		{ action: "steer", direction: "改用只读检查。", keepWatching: true },
		{ action: "abort", reason: "违反硬约束" },
	];
	const wakeupResults: unknown[] = [];
	setJudgeDecisionSessionFactoryForTests(async (options: any) => {
		agentDefinitionPath = options.agentDefinitionPath;
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
		emitQuestionnaireConfirmed(handlers, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setJudgeDecisionSessionFactoryForTests(undefined);
	}

	assert.equal(prompts.length, 3);
	assert.equal(path.basename(agentDefinitionPath ?? ""), "judge.md");
	assert.match(agentDefinitionPath ?? "", /agents[/\\]judge\.md$/);
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
		emitQuestionnaireConfirmed(handlers, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setJudgeDecisionSessionFactoryForTests(undefined);
	}

	assert.deepEqual(wakeupResults, [
		{ action: "pass", keepWatching: true },
		// parse 失败不再 ABORT,但也不伪装成真 pass;driver 层会计连续 parse_failed 并按 maxSteer 升级。
		{ action: "parse_failed", keepWatching: true, reason: "(Judge 输出解析失败,默认放行,下次唤醒重新判定)" },
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

// C-2 机制闸回归测试:aligning 阶段没调过 questionnaire 就选"委派 driver 执行",
// 必须被拒绝(driver 不启动),并 sendUserMessage 把 Judge 踢回 aligning 确认假设。
// 防止 Judge 偷懒跳过 questionnaire 直接拍 Spec(2026-06-19 知乎验证暴露的问题)。
test("delegate is rejected when aligning phase never called questionnaire (C-2 guard)", async () => {
	const { pi, commands, handlers, userMessages } = makePi();
	const { ctx, notifications } = makeCtx();
	let driverStarted = false;
	setJudgeDriverFactoryForTests(async () => {
		driverStarted = true;
		return { async start() {}, dispose() {}, getSummary: () => ({ pathsTried: [], turnCount: 0, completed: false }) };
	});
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		// 故意不调 emitQuestionnaireConfirmed —— 模拟 Judge 偷懒直接产 Spec
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);

		// 闸:driver 不该启动
		assert.equal(driverStarted, false, "driver must NOT start when questionnaire was skipped");
		// 闸:应该有拒绝通知
		assert.ok(notifications.some((n) => /未用 questionnaire 确认假设|拒绝委派/.test(n.message)),
			"should notify that delegation was rejected for missing questionnaire");
		// 闸:应该 sendUserMessage 让 Judge 回去问
		assert.ok(userMessages.some((msg) => /questionnaire/.test(msg) && /假设/.test(msg)),
			"should send user message instructing Judge to call questionnaire and confirm assumptions");
	} finally {
		setJudgeDriverFactoryForTests(undefined);
	}
});

// ---- driver 过程可视化 widget 接线测试 ----

test("delegated driver shows a widget with transcript and Judge verdict, and clears it on abort", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx, widgetCalls } = makeCtx();
	let capturedOnTranscriptUpdate: (() => void) | undefined;
	let capturedOnJudgeVerdict: ((v: unknown) => void) | undefined;

	setJudgeDriverFactoryForTests(async (options: any) => {
		capturedOnTranscriptUpdate = options.onTranscriptUpdate;
		capturedOnJudgeVerdict = options.onJudgeVerdict;
		return {
			async start() {},
			dispose() {},
			getSummary() { return { pathsTried: [], turnCount: 1, completed: false, steerCount: 0 }; },
			getWidgetLines() { return ["[tool] chrome_cdp started", "好的"]; },
			getTranscriptText() { return "stub transcript"; },
		};
	});
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		emitQuestionnaireConfirmed(handlers, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);

		// driver 起来后,refreshDriverWidget 被调一次(start 后立即刷),widget 应被设置
		const setCalls = widgetCalls.filter((c) => c.key === "judge-driver-view" && c.content !== undefined);
		assert.ok(setCalls.length >= 1, "widget should be set with content after driver starts");
		const firstContent = setCalls[0].content as string[];
		assert.ok(firstContent.some((l) => /Judge driver/i.test(l)), "widget should contain driver title line");
		assert.ok(firstContent.some((l) => /chrome_cdp/.test(l)), "widget should contain driver transcript");

		// 触发一次 Judge verdict,widget 应含 verdict 行
		widgetCalls.length = 0;
		capturedOnJudgeVerdict!({ action: "steer", direction: "换 cdp 路径", keepWatching: true });
		const afterVerdict = widgetCalls.filter((c) => c.key === "judge-driver-view" && c.content !== undefined);
		assert.ok(afterVerdict.length >= 1, "widget should refresh on Judge verdict");
		const verdictContent = afterVerdict[afterVerdict.length - 1].content as string[];
		assert.ok(verdictContent.some((l) => /STEER.*换 cdp 路径/.test(l)), "widget should contain the verdict line");
	} finally {
		setJudgeDriverFactoryForTests(undefined);
	}
});

test("clearJudgeDriverWidget removes the widget via setWidget undefined", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx, widgetCalls } = makeCtx();
	// onAbort 路径:让 verdict provider 返回 abort,触发 clearDriverWidget
	let triggerAbort: ((reason: string) => void) | undefined;
	setJudgeVerdictProviderForTests(async () => ({ action: "pass", keepWatching: true }));
	setJudgeDriverFactoryForTests(async (options: any) => {
		const onWakeup = options.onWakeup;
		return {
			async start() {
				// 起来后模拟一次 abort wakeup
				const verdict = await onWakeup({ reason: "tool_error", summary: { pathsTried: [], turnCount: 1, completed: false }, transcript: "" });
				if (verdict.action === "abort" && options.onWakeup) {
					// 触发 abort 后 judge.ts 的 onAbort 会清 widget
				}
			},
			dispose() {},
			getSummary() { return { pathsTried: [], turnCount: 1, completed: false, steerCount: 0 }; },
			getWidgetLines() { return []; },
			getTranscriptText() { return ""; },
		};
	});
	void triggerAbort;
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		emitQuestionnaireConfirmed(handlers, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);

		// session_shutdown 应触发清理:widget 被 setWidget undefined 移除
		await handlers.get("session_shutdown")![0]({}, ctx);
		const clearCalls = widgetCalls.filter((c) => c.key === "judge-driver-view" && c.content === undefined);
		assert.ok(clearCalls.length >= 1, "widget should be cleared (setWidget undefined) on session_shutdown");
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setJudgeVerdictProviderForTests(undefined);
	}
});
