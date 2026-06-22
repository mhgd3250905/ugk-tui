import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	buildBashLiveLogCommand,
	buildWindowsLiveLogLaunchPlan,
	registerJudge,
	setJudgeDecisionSessionFactoryForTests,
	setJudgeDriverFactoryForTests,
	setOpenLiveLogTerminalForTests,
	setJudgeVerdictProviderForTests,
} from "../extensions/judge/judge.ts";
import { ALIGN_PROMPT } from "../extensions/judge/judge-prompts.ts";
import { loadTaskbook, saveTaskbook } from "../extensions/judge/taskbook.ts";

const noopLiveLogOpener = () => ({ ok: true });

function makePi() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const tools: any[] = [];
	const activeTools: string[][] = [];
	let currentActiveTools = ["read", "bash", "edit", "write", "chrome_cdp"];
	const sentMessages: Array<{ message: any; options?: any }> = [];
	const userMessages: Array<{ text: string; options?: any }> = [];
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
			getActiveTools() {
				return [...currentActiveTools];
			},
			setActiveTools(names: string[]) {
				currentActiveTools = [...names];
				activeTools.push(names);
			},
			on(event: string, handler: Function) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			sendMessage(message: any, options?: any) {
				sentMessages.push({ message, options });
			},
			sendUserMessage(text: string, options?: any) {
				userMessages.push({ text, options });
			},
			appendEntry(customType: string, data: unknown) {
				entries.push({ customType, data });
			},
		},
	};
}

function makeCtx() {
	setOpenLiveLogTerminalForTests(noopLiveLogOpener);
	const notifications: Array<{ message: string; type?: string }> = [];
	const selections: Array<{ title: string; options: string[] }> = [];
	const editorPrompts: string[] = [];
	const widgetCalls: Array<{ key: string; content: unknown }> = [];
	const statusCalls: Array<{ key: string; value: unknown }> = [];
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
			setStatus(key: string, value: unknown) {
				statusCalls.push({ key, value });
			},
		},
	};
	return { ctx, notifications, selections, editorPrompts, widgetCalls, statusCalls };
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

function fixtureTaskbookSpec(goal = "从任务书运行") {
	return {
		goal,
		hardConstraints: ["保留监督"],
		acceptance: ["启动 driver"],
		forbidden: [],
		context: "",
	};
}

function emptySummary(overrides: Record<string, unknown> = {}) {
	return {
		pathsTried: [],
		artifacts: [],
		runningTools: [],
		turnCount: 0,
		steerCount: 0,
		steerHistory: [],
		completed: true,
		...overrides,
	};
}

function makeJudgeDriverHandle(overrides: Record<string, unknown> = {}) {
	return {
		async start() {},
		async sendUserInput(_text: string) {},
		dispose() {},
		getSummary() {
			return emptySummary({ completed: false });
		},
		getWidgetLines() {
			return [];
		},
		getTranscriptText() {
			return "";
		},
		getLiveLogPath() {
			return "E:/tmp/live.log";
		},
		...overrides,
	};
}

async function saveFixtureTaskbook(cwd: string, name = "foo", goal = "从任务书运行") {
	await saveTaskbook(cwd, name, {
		description: "desc",
		spec: fixtureTaskbookSpec(goal),
		summary: emptySummary({
			turnCount: 1,
			steerCount: 1,
			steerHistory: [{ direction: "补证据", reason: "缺证据", turnIndex: 1 }],
		}),
	});
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

test("Windows live log launch plan has no Windows Terminal special casing", () => {
	const source = readFileSync(path.resolve("extensions/judge/judge.ts"), "utf8");

	assert.doesNotMatch(source, /WT_SESSION|wt\.exe|commandExists/);
});

test("bash live log command tails the normalized live.log path", () => {
	const command = buildBashLiveLogCommand("E:\\workspace\\project with spaces\\.judge\\judge-123\\live.log");

	assert.match(command, /mkdir -p/);
	assert.match(command, /tail -n \+1 -f/);
	assert.match(command, /E:\/workspace\/project with spaces\/\.judge\/judge-123\/live\.log/);
	assert.doesNotMatch(command, /Get-Content/);
});

test("Windows live log launch plan opens bash tail in a visible system terminal", () => {
	const liveLogPath = path.join("E:/workspace/project with spaces/.judge/judge-123", "live.log");
	const plan = buildWindowsLiveLogLaunchPlan(liveLogPath, "D:\\Git\\bin\\bash.exe");

	assert.equal(plan.command, "cmd.exe");
	assert.equal("shell" in plan, false);
	assert.deepEqual(plan.args.slice(0, 5), ["/d", "/s", "/c", "start", "\"\""]);
	assert.equal(plan.args[5], "D:\\Git\\bin\\bash.exe");
	assert.deepEqual(plan.args.slice(6, 9), ["--noprofile", "--norc", "-lc"]);
	assert.match(plan.args[9], /tail -n \+1 -f/);
	assert.equal("launcher" in plan, false);
	assert.doesNotMatch(plan.args.join(" "), /Get-Content/);
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

test("judge context keeps only the current align prompt and drops it outside aligning", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	registerJudge(pi as any);

	const oldAlignContext = { role: "custom", customType: "judge-align-context", content: "old" };
	const newAlignContext = { role: "custom", customType: "judge-align-context", content: "new" };
	const userMessage = { role: "user", content: [{ type: "text", text: "run" }] };

	await commands.get("judge").handler("toggle", ctx);
	const aligning = await handlers.get("context")![0]({ messages: [oldAlignContext, userMessage, newAlignContext] }, ctx);

	assert.deepEqual(aligning.messages, [userMessage, newAlignContext]);

	await commands.get("judge").handler("toggle", ctx);
	const inactive = await handlers.get("context")![0]({ messages: [oldAlignContext, userMessage] }, ctx);

	assert.deepEqual(inactive.messages, [userMessage]);
});

test("/judge with no args opens an inactive action menu and starts new Judge work", async () => {
	const { pi, commands, handlers, activeTools } = makePi();
	const { ctx, selections, statusCalls } = makeCtx();
	registerJudge(pi as any);

	await commands.get("judge").handler("", ctx);
	const injected = await handlers.get("before_agent_start")![0]({}, ctx);

	assert.deepEqual(selections.at(-1)?.options, [
		"新建监督任务",
		"运行任务书",
		"编辑任务书",
		"列出任务书",
		"诊断: 检查 bash 新窗口",
		"Exit",
	]);
	assert.deepEqual(activeTools.at(-1), ["read", "bash", "grep", "find", "ls", "questionnaire"]);
	assert.deepEqual(statusCalls.at(-1), { key: "judge-mode", value: "⚖ judge" });
	assert.equal(injected.message.content, ALIGN_PROMPT);
});

test("/judge with no args and no select UI does not toggle implicitly", async () => {
	const { pi, commands, activeTools } = makePi();
	const { ctx } = makeCtx();
	delete (ctx.ui as any).select;
	registerJudge(pi as any);

	await commands.get("judge").handler("", ctx);

	assert.deepEqual(activeTools, []);
});

test("/judge active menu exposes exit instead of ambiguous toggle", async () => {
	const { pi, commands } = makePi();
	const { ctx, selections } = makeCtx();
	registerJudge(pi as any);

	await commands.get("judge").handler("toggle", ctx);
	await commands.get("judge").handler("", ctx);

	assert.deepEqual(selections.at(-1)?.options, [
		"继续澄清",
		"退出 Judge",
		"Exit",
	]);
});

test("/judge toggle disables an active Judge session", async () => {
	const { pi, commands, handlers, activeTools } = makePi();
	const { ctx, notifications, statusCalls, widgetCalls } = makeCtx();
	registerJudge(pi as any);

	await commands.get("judge").handler("toggle", ctx);
	await commands.get("judge").handler("toggle", ctx);
	const injected = await handlers.get("before_agent_start")![0]({}, ctx);

	assert.equal(injected, undefined);
	assert.deepEqual(activeTools.at(-1), ["read", "bash", "edit", "write", "chrome_cdp"]);
	assert.deepEqual(statusCalls.at(-1), { key: "judge-mode", value: undefined });
	assert.deepEqual(widgetCalls.at(-1), { key: "judge-driver-view", content: undefined });
	assert.match(notifications.at(-1)?.message ?? "", /Judge disabled/);
});

test("/judge menu can check opening a bash live log window", async () => {
	const { pi, commands } = makePi();
	const { ctx, notifications } = makeCtx();
	const tmp = mkdtempSync(path.join(os.tmpdir(), "ugk-judge-menu-"));
	const openedPaths: string[] = [];
	(ctx as any).cwd = tmp;
	(ctx.ui as any).select = (_title: string, options: string[]) => options.find((option) => option.includes("检查 bash")) ?? options[0];
	setOpenLiveLogTerminalForTests((liveLogPath) => {
		openedPaths.push(liveLogPath);
		return { ok: true };
	});
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);

		assert.equal(openedPaths.length, 1);
		assert.match(openedPaths[0], /judge-live-check-\d+[/\\]live\.log$/);
		assert.equal(existsSync(openedPaths[0]), true);
		assert.match(readFileSync(openedPaths[0], "utf8"), /Judge bash live log check started/);
		assert.match(notifications.at(-1)?.message ?? "", /已打开 bash 新窗口检查日志/);
	} finally {
		setOpenLiveLogTerminalForTests(noopLiveLogOpener);
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("judge mode writes footer status like plan mode and clears it on shutdown", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx, statusCalls } = makeCtx();
	setJudgeDriverFactoryForTests(async () => ({
		async start() {},
		dispose() {},
		getSummary: () => ({ pathsTried: [], turnCount: 1, completed: false }),
		getWidgetLines: () => [],
		getTranscriptText: () => "",
		getLiveLogPath: () => "E:/tmp/live.log",
	}));
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		assert.deepEqual(statusCalls.at(-1), { key: "judge-mode", value: "⚖ judge" });

		emitQuestionnaireConfirmed(handlers, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
		assert.deepEqual(statusCalls.at(-1), { key: "judge-mode", value: "⚖ driving" });

		await handlers.get("session_shutdown")![0]({}, ctx);
		assert.deepEqual(statusCalls.at(-1), { key: "judge-mode", value: undefined });
	} finally {
		setJudgeDriverFactoryForTests(undefined);
	}
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

test("delegating a Judge driver automatically opens the live log terminal", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	const tmp = mkdtempSync(path.join(os.tmpdir(), "ugk-judge-delegate-"));
	const openedPaths: string[] = [];
	const liveLogPath = path.join(tmp, ".judge", "run-1", "live.log");
	setJudgeDriverFactoryForTests(async () => ({
		async start() {},
		dispose() {},
		getSummary: () => ({ pathsTried: [], artifacts: [], runningTools: [], turnCount: 1, steerCount: 0, completed: false }),
		getWidgetLines: () => [],
		getTranscriptText: () => "",
		getLiveLogPath: () => liveLogPath,
	}));
	setOpenLiveLogTerminalForTests((liveLogPath) => {
		assert.equal(existsSync(liveLogPath), true);
		openedPaths.push(liveLogPath);
		return { ok: true };
	});
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		emitQuestionnaireConfirmed(handlers, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);

		assert.deepEqual(openedPaths, [liveLogPath]);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setOpenLiveLogTerminalForTests(noopLiveLogOpener);
		rmSync(tmp, { recursive: true, force: true });
	}
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

test("/judge save foo writes a taskbook from the current Judge spec", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	const tmp = mkdtempSync(path.join(os.tmpdir(), "ugk-judge-save-"));
	(ctx as any).cwd = tmp;
	setJudgeDriverFactoryForTests(async () => ({
		async start() {},
		dispose() {},
		getSummary() {
			return emptySummary({ turnCount: 1, completed: false });
		},
	}));
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		emitQuestionnaireConfirmed(handlers, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
		await commands.get("judge").handler("save foo", ctx);

		const loaded = await loadTaskbook(tmp, "foo");
		assert.equal(loaded?.taskbook.name, "foo");
		assert.equal(loaded?.spec.goal, "完成 Judge 阶段 2");
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("/judge run foo loads a taskbook and starts driving without aligning", async () => {
	const { pi, commands, activeTools, entries } = makePi();
	const { ctx } = makeCtx();
	const tmp = mkdtempSync(path.join(os.tmpdir(), "ugk-judge-run-"));
	(ctx as any).cwd = tmp;
	await saveFixtureTaskbook(tmp);
	const starts: string[] = [];
	let initialPrompt = "";
	setJudgeDriverFactoryForTests(async (options: any) => {
		initialPrompt = options.initialPrompt;
		return {
			async start() { starts.push("start"); },
			dispose() {},
			getSummary() {
				return emptySummary({ completed: false });
			},
			getWidgetLines() { return []; },
			getTranscriptText() { return ""; },
			getLiveLogPath() { return path.join(tmp, ".judge", "run", "live.log"); },
		};
	});
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("run foo", ctx);

		assert.deepEqual(starts, ["start"]);
		assert.deepEqual(activeTools.at(-1), ["read", "bash", "edit", "write"]);
		assert.equal(entries.at(-1)?.data.phase, "driving");
		assert.equal(entries.at(-1)?.data.taskbookName, "foo");
		assert.match(initialPrompt, /从任务书运行/);
		assert.match(initialPrompt, /历史经验\(补充参考,非验收标准\)/);
		assert.match(initialPrompt, /补证据/);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("/judge run returns while the driver is still running so interjections can be handled", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	const tmp = mkdtempSync(path.join(os.tmpdir(), "ugk-judge-run-async-"));
	(ctx as any).cwd = tmp;
	await saveFixtureTaskbook(tmp);
	const forwarded: string[] = [];
	setJudgeDriverFactoryForTests(async () => ({
		async start() {
			await new Promise(() => {});
		},
		async sendUserInput(text: string) {
			forwarded.push(text);
		},
		dispose() {},
		getSummary() {
			return emptySummary({ completed: false });
		},
		getWidgetLines() { return []; },
		getTranscriptText() { return ""; },
		getLiveLogPath() { return path.join(tmp, ".judge", "run", "live.log"); },
	}));
	registerJudge(pi as any);

	try {
		const result = await Promise.race([
			commands.get("judge").handler("run foo", ctx).then(() => "resolved"),
			new Promise((resolve) => setTimeout(() => resolve("timeout"), 20)),
		]);

		assert.equal(result, "resolved");
		assert.deepEqual(await handlers.get("input")![0]({ text: "先把日志加上", source: "interactive" }, ctx), { action: "handled" });
		assert.match(forwarded[0] ?? "", /先把日志加上/);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("/judge edit foo enters edit aligning and injects the existing spec", async () => {
	const { pi, commands, handlers, activeTools, userMessages, entries } = makePi();
	const { ctx, notifications, statusCalls } = makeCtx();
	const tmp = mkdtempSync(path.join(os.tmpdir(), "ugk-judge-edit-"));
	(ctx as any).cwd = tmp;
	await saveFixtureTaskbook(tmp, "foo", "旧目标");
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("edit foo", ctx);
		const injected = await handlers.get("before_agent_start")![0]({}, ctx);

		assert.deepEqual(activeTools.at(-1), ["read", "bash", "grep", "find", "ls", "questionnaire"]);
		assert.equal(entries.at(-1)?.data.phase, "aligning");
		assert.equal(entries.at(-1)?.data.aligningMode, "edit");
		assert.equal(entries.at(-1)?.data.taskbookName, "foo");
		assert.equal(entries.at(-1)?.data.spec.goal, "旧目标");
		assert.match(userMessages.at(-1)?.text ?? "", /开始编辑任务书 "foo"/);
		assert.deepEqual(userMessages.at(-1)?.options, { deliverAs: "followUp" });
		assert.match(injected.message.content, /\[JUDGE EDIT MODE\]/);
		assert.match(injected.message.content, /旧目标/);
		assert.deepEqual(statusCalls.at(-1), { key: "judge-mode", value: "⚖ edit" });
		assert.match(notifications.at(-1)?.message ?? "", /进入任务书 "foo" 编辑模式/);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("edit mode agent_end offers save continue abandon actions", async () => {
	const { pi, commands, handlers, userMessages, entries } = makePi();
	const { ctx, selections, notifications, statusCalls } = makeCtx();
	const tmp = mkdtempSync(path.join(os.tmpdir(), "ugk-judge-edit-menu-"));
	(ctx as any).cwd = tmp;
	await saveFixtureTaskbook(tmp, "foo", "旧目标");
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("edit foo", ctx);
		emitQuestionnaireConfirmed(handlers, ctx);
		(ctx.ui as any).select = (title: string, options: string[]) => {
			selections.push({ title, options });
			return "存回任务书";
		};
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);

		const loaded = await loadTaskbook(tmp, "foo");
		assert.equal(loaded?.spec.goal, "完成 Judge 阶段 2");
		assert.deepEqual(selections.at(-1), {
			title: "Judge next step",
			options: ["存回任务书", "继续调整", "放弃"],
		});
		assert.equal(entries.at(-1)?.data.phase, "done");
		assert.equal(entries.at(-1)?.data.aligningMode, undefined);
		assert.deepEqual(statusCalls.at(-1), { key: "judge-mode", value: undefined });
		assert.match(notifications.at(-1)?.message ?? "", /任务书 "foo" 已更新/);

		await commands.get("judge").handler("edit foo", ctx);
		emitQuestionnaireConfirmed(handlers, ctx);
		(ctx.ui as any).select = () => "继续调整";
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
		assert.equal(entries.at(-1)?.data.phase, "aligning");
		assert.equal(entries.at(-1)?.data.aligningMode, "edit");
		assert.match(userMessages.at(-1)?.text ?? "", /继续调整 Spec/);
		assert.deepEqual(userMessages.at(-1)?.options, { deliverAs: "followUp" });

		await commands.get("judge").handler("edit foo", ctx);
		emitQuestionnaireConfirmed(handlers, ctx);
		(ctx.ui as any).select = () => "放弃";
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
		assert.equal(entries.at(-1)?.data.phase, "aborted");
		assert.equal(entries.at(-1)?.data.aligningMode, undefined);
		assert.match(notifications.at(-1)?.message ?? "", /已放弃对任务书 "foo" 的修改/);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("edit mode refuses to save a spec before questionnaire confirmation", async () => {
	const { pi, commands, handlers, userMessages } = makePi();
	const { ctx, notifications } = makeCtx();
	const tmp = mkdtempSync(path.join(os.tmpdir(), "ugk-judge-edit-c2-"));
	(ctx as any).cwd = tmp;
	await saveFixtureTaskbook(tmp, "foo", "旧目标");
	(ctx.ui as any).select = () => "存回任务书";
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("edit foo", ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);

		const loaded = await loadTaskbook(tmp, "foo");
		assert.equal(loaded?.spec.goal, "旧目标");
		assert.ok(notifications.some((n) => /未用 questionnaire 确认假设|拒绝保存/.test(n.message)));
		assert.ok(userMessages.some((msg) => /questionnaire/.test(msg.text) && /编辑任务书/.test(msg.text)));
		assert.deepEqual(userMessages.at(-1)?.options, { deliverAs: "followUp" });
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("ALIGN_PROMPT requires an extras closing questionnaire item", () => {
	assert.match(ALIGN_PROMPT, /extras/);
	assert.match(ALIGN_PROMPT, /你还有什么要补充的吗/);
	assert.match(ALIGN_PROMPT, /context/);
	assert.match(ALIGN_PROMPT, /allowOther/);
});

test("/judge list shows taskbooks", async () => {
	const { pi, commands } = makePi();
	const { ctx, notifications } = makeCtx();
	const tmp = mkdtempSync(path.join(os.tmpdir(), "ugk-judge-list-"));
	(ctx as any).cwd = tmp;
	await saveFixtureTaskbook(tmp, "foo", "目标");
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("list", ctx);

		assert.match(notifications.at(-1)?.message ?? "", /foo: desc/);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("/judge run rejects invalid taskbook names", async () => {
	const { pi, commands } = makePi();
	const { ctx, notifications } = makeCtx();
	registerJudge(pi as any);

	await commands.get("judge").handler("run ../x", ctx);

	assert.match(notifications.at(-1)?.message ?? "", /任务书名无效/);
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

test("default Judge wakeup path parses the collected current response even when transcript text drifts", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
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
							delta: '{"action":"pass","reason":"current response","keepWatching":true}',
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
			wakeupResults.push(await options.onWakeup({
				reason: "guarded_tool_start",
				summary: { pathsTried: ["bash"], turnCount: 1, completed: false },
				transcript: "trimmed window without old prefix",
			}));
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
		{ action: "pass", reason: "current response", keepWatching: true },
	]);
});

test("agent_end continue clarification keeps aligning and asks the agent to clarify", async () => {
	const { pi, commands, handlers, userMessages } = makePi();
	const { ctx } = makeCtx();
	ctx.ui.select = (title: string, options: string[]) => title === "Judge" ? options[0] : "继续澄清";
	registerJudge(pi as any);

	await commands.get("judge").handler("", ctx);
	await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);

	assert.match(userMessages.at(-1)?.text ?? "", /继续澄清/);
	assert.deepEqual(userMessages.at(-1)?.options, { deliverAs: "followUp" });
	const injected = await handlers.get("before_agent_start")![0]({}, ctx);
	assert.equal(injected.message.content, ALIGN_PROMPT);
});

test("agent_end edit requirements returns to aligning with editor text", async () => {
	const { pi, commands, handlers, userMessages } = makePi();
	const { ctx } = makeCtx();
	ctx.ui.select = (title: string, options: string[]) => title === "Judge" ? options[0] : "改需求";
	registerJudge(pi as any);

	await commands.get("judge").handler("", ctx);
	await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);

	assert.match(userMessages.at(-1)?.text ?? "", /请补充验收标准/);
	assert.deepEqual(userMessages.at(-1)?.options, { deliverAs: "followUp" });
});

test("agent_end cancelled next-step menu leaves normal aligning active", async () => {
	const { pi, commands, handlers, entries } = makePi();
	const { ctx, notifications } = makeCtx();
	ctx.ui.select = (title: string, options: string[]) => title === "Judge" ? options[0] : undefined;
	registerJudge(pi as any);

	await commands.get("judge").handler("", ctx);
	emitQuestionnaireConfirmed(handlers, ctx);
	await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);

	assert.equal(entries.at(-1)?.data.phase, "aligning");
	assert.match(notifications.at(-1)?.message ?? "", /cancelled/);
});

test("agent_end cancelled edit next-step menu leaves edit mode active", async () => {
	const { pi, commands, handlers, entries } = makePi();
	const { ctx, notifications } = makeCtx();
	const tmp = mkdtempSync(path.join(os.tmpdir(), "ugk-taskbook-edit-cancel-"));
	(ctx as any).cwd = tmp;
	await saveFixtureTaskbook(tmp, "foo");
	ctx.ui.select = (title: string, options: string[]) => {
		if (title === "选择任务书") return "foo";
		if (title === "Judge next step") return undefined;
		return options[0];
	};
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("edit", ctx);
		emitQuestionnaireConfirmed(handlers, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}

	assert.equal(entries.at(-1)?.data.phase, "aligning");
	assert.equal(entries.at(-1)?.data.aligningMode, "edit");
	assert.match(notifications.at(-1)?.message ?? "", /cancelled/);
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

test("driving interactive input is handled and forwarded to the active driver", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	const forwarded: string[] = [];
	setJudgeDriverFactoryForTests(async () => makeJudgeDriverHandle({
		async sendUserInput(text: string) {
			forwarded.push(text);
		},
	}));
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		emitQuestionnaireConfirmed(handlers, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
		const result = await handlers.get("input")![0]({ text: "把日志也加上", source: "interactive" }, ctx);

		assert.deepEqual(result, { action: "handled" });
		assert.equal(forwarded.length, 1);
		assert.match(forwarded[0], /\[USER INTERJECTION during driving\]/);
		assert.match(forwarded[0], /把日志也加上/);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
	}
});

test("non-driving input continues without forwarding", async () => {
	for (const phase of ["aligning", "delivering", "done", "aborted"]) {
		const { pi, commands, handlers } = makePi();
		const { ctx } = makeCtx();
		const forwarded: string[] = [];
		setJudgeDriverFactoryForTests(async () => makeJudgeDriverHandle({
			async sendUserInput(text: string) {
				forwarded.push(text);
			},
		}));
		registerJudge(pi as any);

		try {
			if (phase === "aligning") {
				await commands.get("judge").handler("", ctx);
			} else {
				ctx.sessionManager.getEntries = () => [{
					type: "custom",
					customType: "judge-state",
					data: {
						phase,
						spec: fixtureTaskbookSpec(),
						summary: "",
						steerCount: 0,
						maxSteer: 5,
						keepWatching: phase === "delivering",
						aligningQuestionnaireUsed: false,
					},
				}];
				await handlers.get("session_start")![0]({}, ctx);
			}

			const result = await handlers.get("input")![0]({ text: "别转发", source: "interactive" }, ctx);

			assert.deepEqual(result, { action: "continue" });
			assert.deepEqual(forwarded, []);
		} finally {
			setJudgeDriverFactoryForTests(undefined);
		}
	}
});

test("driving non-interactive input continues without forwarding", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	const forwarded: string[] = [];
	setJudgeDriverFactoryForTests(async () => makeJudgeDriverHandle({
		async sendUserInput(text: string) {
			forwarded.push(text);
		},
	}));
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		emitQuestionnaireConfirmed(handlers, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
		const result = await handlers.get("input")![0]({ text: "rpc message", source: "rpc" }, ctx);

		assert.deepEqual(result, { action: "continue" });
		assert.deepEqual(forwarded, []);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
	}
});

test("driving input continues with a warning when no active driver exists", async () => {
	const { pi, handlers } = makePi();
	const { ctx, notifications } = makeCtx();
	ctx.sessionManager.getEntries = () => [{
		type: "custom",
		customType: "judge-state",
		data: {
			phase: "driving",
			spec: null,
			summary: "",
			steerCount: 0,
			maxSteer: 5,
			keepWatching: true,
			aligningQuestionnaireUsed: false,
		},
	}];
	registerJudge(pi as any);

	await handlers.get("session_start")![0]({}, ctx);
	const result = await handlers.get("input")![0]({ text: "还在吗", source: "interactive" }, ctx);

	assert.deepEqual(result, { action: "continue" });
	assert.equal(notifications.at(-1)?.type, "warning");
	assert.match(notifications.at(-1)?.message ?? "", /Driver.*无法转发/);
});

test("driving input send failure warns and stays handled", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx, notifications } = makeCtx();
	setJudgeDriverFactoryForTests(async () => makeJudgeDriverHandle({
		async sendUserInput() {
			throw new Error("boom");
		},
	}));
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		emitQuestionnaireConfirmed(handlers, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
		const result = await handlers.get("input")![0]({ text: "失败也别崩", source: "interactive" }, ctx);

		assert.deepEqual(result, { action: "handled" });
		assert.equal(notifications.at(-1)?.type, "warning");
		assert.match(notifications.at(-1)?.message ?? "", /转发用户插话给 Driver 失败: boom/);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
	}
});

test("driver start failure aborts Judge and restores tools", async () => {
	const { pi, commands, handlers, activeTools, entries } = makePi();
	const { ctx, notifications, statusCalls, widgetCalls } = makeCtx();
	setJudgeDriverFactoryForTests(async () => makeJudgeDriverHandle({
		async start() {
			throw new Error("spawn failed");
		},
	}));
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		emitQuestionnaireConfirmed(handlers, ctx);
		await assert.doesNotReject(() => handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx));
	} finally {
		setJudgeDriverFactoryForTests(undefined);
	}

	assert.equal(entries.at(-1)?.data.phase, "aborted");
	assert.deepEqual(activeTools.at(-1), ["read", "bash", "edit", "write", "chrome_cdp"]);
	assert.deepEqual(statusCalls.at(-1), { key: "judge-mode", value: undefined });
	assert.deepEqual(widgetCalls.at(-1), { key: "judge-driver-view", content: undefined });
	assert.match(notifications.map((entry) => entry.message).join("\n"), /Judge driver start failed: spawn failed/);
});

test("session_start restores driving Judge state by starting the driver immediately", async () => {
	const { pi, handlers, activeTools } = makePi();
	const { ctx, statusCalls } = makeCtx();
	let starts = 0;
	ctx.sessionManager.getEntries = () => [
		{
			type: "custom",
			customType: "judge-state",
			data: {
				phase: "driving",
				spec: fixtureTaskbookSpec("恢复执行"),
				summary: "restored",
				steerCount: 0,
				maxSteer: 5,
				keepWatching: true,
				aligningQuestionnaireUsed: true,
			},
		},
	];
	setJudgeDriverFactoryForTests(async () => makeJudgeDriverHandle({
		async start() {
			starts += 1;
		},
	}));
	registerJudge(pi as any);

	try {
		await handlers.get("session_start")![0]({ reason: "resume" }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
	}

	assert.equal(starts, 1);
	assert.deepEqual(activeTools.at(-1), ["read", "bash", "edit", "write"]);
	assert.deepEqual(statusCalls.at(-1), { key: "judge-mode", value: "⚖ driving" });
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

test("session_start restores persisted edit aligning mode", async () => {
	const { pi, handlers, activeTools } = makePi();
	const { ctx, statusCalls } = makeCtx();
	ctx.sessionManager.getEntries = () => [
		{
			type: "custom",
			customType: "judge-state",
			data: {
				phase: "aligning",
				spec: {
					goal: "恢复任务书编辑",
					hardConstraints: ["只读"],
					acceptance: ["注入 edit prompt"],
					forbidden: [],
					context: "resume",
				},
				summary: "restored",
				steerCount: 2,
				maxSteer: 5,
				keepWatching: true,
				taskbookName: "foo",
				aligningMode: "edit",
			},
		},
	];
	registerJudge(pi as any);

	await handlers.get("session_start")![0]({ reason: "resume" }, ctx);
	const injected = await handlers.get("before_agent_start")![0]({}, ctx);

	assert.deepEqual(activeTools.at(-1), ["read", "bash", "grep", "find", "ls", "questionnaire"]);
	assert.deepEqual(statusCalls.at(-1), { key: "judge-mode", value: "⚖ edit" });
	assert.match(injected.message.content, /\[JUDGE EDIT MODE\]/);
	assert.match(injected.message.content, /恢复任务书编辑/);
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
		assert.ok(userMessages.some((msg) => /questionnaire/.test(msg.text) && /假设/.test(msg.text)),
			"should send user message instructing Judge to call questionnaire and confirm assumptions");
		assert.deepEqual(userMessages.at(-1)?.options, { deliverAs: "followUp" });
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
