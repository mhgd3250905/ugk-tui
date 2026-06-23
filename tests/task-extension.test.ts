import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerTask, getTaskCommandMenuOptions, resolveTaskCommandArgs } from "../extensions/task/task.ts";
import { createTaskState, enterPlanning, enterReviewing, markPlanQuestionnaireUsed, setTaskSpec, startExecuting } from "../extensions/task/task-state.ts";
import { appendRunToTaskbook, loadTaskbook, saveTaskbook } from "../extensions/task/task-book.ts";
import { setTaskCheckerRunnerForTests } from "../extensions/task/task-checker.ts";
import { setTaskDispatcherForTests } from "../extensions/task/task-dispatcher.ts";
import { buildTaskReviewPrompt, extractTaskReviewResult, TASK_ALIGN_PROMPT, TASK_REVIEW_PROMPT } from "../extensions/task/task-prompts.ts";
import { setTaskWorkerRunnerForTests } from "../extensions/task/task-worker.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(path.join(os.tmpdir(), "ugk-task-extension-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
process.on("exit", () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(testAgentDir, { recursive: true, force: true });
});

const spec = {
	goal: "生成报告",
	hardConstraints: ["只输出 JSON"],
	acceptance: ["schema 通过"],
	forbidden: [],
	context: "",
};

test("task extension stays independent from plan, judge, CDP, and MCP modules", () => {
	const taskDir = path.resolve("extensions", "task");
	for (const file of readdirSync(taskDir).filter((name) => name.endsWith(".ts"))) {
		const source = readFileSync(path.join(taskDir, file), "utf8");
		assert.doesNotMatch(source, /from\s+["']\.\.\/(?:plan-mode|judge|chrome-cdp|mcp)\b/, `${file} should stay independent from other extension internals`);
	}
});

function makePi(initialActiveTools = ["read", "bash", "edit", "write", "subagent"]) {
	const commands = new Map<string, any>();
	const tools: any[] = [];
	const handlers = new Map<string, Function[]>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const activeTools: string[][] = [];
	let currentActiveTools = [...initialActiveTools];
	const userMessages: Array<{ text: string; options?: any }> = [];
	return {
		commands,
		handlers,
		entries,
		activeTools,
		userMessages,
		pi: {
			registerCommand(name: string, options: any) {
				commands.set(name, options);
			},
			registerTool(tool: any) {
				tools.push(tool);
			},
			appendEntry(customType: string, data: unknown) {
				entries.push({ customType, data });
			},
			getActiveTools() {
				return [...currentActiveTools];
			},
			setActiveTools(names: string[]) {
				currentActiveTools = [...names];
				activeTools.push(names);
			},
			sendUserMessage(text: string, options?: any) {
				userMessages.push({ text, options });
			},
			on(event: string, handler: Function) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		},
		tools,
	};
}

function makeCtx(cwd = mkdtempSync(path.join(os.tmpdir(), "ugk-task-extension-"))) {
	const notifications: Array<{ message: string; type?: string }> = [];
	const selections: Array<{ title: string; options: string[] }> = [];
	const statusCalls: Array<{ key: string; value: unknown }> = [];
	const widgetCalls: Array<{ key: string; lines: string[] | undefined; options?: unknown }> = [];
	return {
		cwd,
		notifications,
		selections,
		statusCalls,
		widgetCalls,
		ctx: {
			cwd,
			sessionManager: { getEntries: () => [] },
			ui: {
				notify(message: string, type?: string) {
					notifications.push({ message, type });
				},
				select(title: string, options: string[]) {
					selections.push({ title, options });
					return options[0];
				},
				setStatus(key: string, value: unknown) {
					statusCalls.push({ key, value });
				},
				setWidget(key: string, lines: string[] | undefined, options?: unknown) {
					widgetCalls.push({ key, lines, options });
				},
				editor(_title: string, value: string) {
					return value;
				},
				input(_title: string, value: string) {
					return value;
				},
				confirm() {
					return true;
				},
			},
		},
	};
}

test("task menu changes by phase and maps selection to action", async () => {
	const planning = setTaskSpec(enterPlanning(createTaskState()), spec);
	const executing = startExecuting(markPlanQuestionnaireUsed(planning));
	const reviewing = enterReviewing(executing, "done");

	assert.deepEqual(getTaskCommandMenuOptions(createTaskState()), ["新建任务", "运行 taskbook(复用)", "列出 taskbook", "查看 taskbook 详情", "编辑 taskbook", "删除 taskbook", "Exit"]);
	assert.deepEqual(getTaskCommandMenuOptions(enterPlanning(createTaskState())), ["继续对齐", "退出 Task", "Exit"]);
	assert.deepEqual(getTaskCommandMenuOptions(planning), ["开始执行", "继续对齐", "修改当前 Spec", "退出 Task", "Exit"]);
	assert.deepEqual(getTaskCommandMenuOptions(executing), ["进入复盘", "停止本次执行", "Exit"]);
	assert.deepEqual(getTaskCommandMenuOptions(reviewing), ["自动保存并自证", "继续复盘", "放弃", "退出 Task", "Exit"]);

	const { ctx } = makeCtx();
	ctx.ui.select = () => "列出 taskbook";
	assert.equal(await resolveTaskCommandArgs("", ctx, createTaskState()), "list");
	ctx.ui.select = () => "运行 taskbook(复用)";
	assert.equal(await resolveTaskCommandArgs("", ctx, createTaskState()), "run");
	ctx.ui.select = () => "进入复盘";
	assert.equal(await resolveTaskCommandArgs("", ctx, executing), "continue-review");
	ctx.ui.select = () => "Exit";
	assert.equal(await resolveTaskCommandArgs("", ctx, createTaskState()), undefined);
	assert.equal(await resolveTaskCommandArgs("show foo", ctx, createTaskState()), "show foo");
});

test("registerTask registers /task list and show", async () => {
	const { pi, commands } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);

	try {
		await saveTaskbook("project", cwd, "report", {
			description: "生成报告",
			spec,
			skill: "# 生成报告\n",
			verify: "process.exit(0);\n",
			contract: { artifacts: [] },
			tags: ["task-extension-test"],
		});

		await commands.get("task").handler("list --tag task-extension-test", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /report \[project\]/);

		await commands.get("task").handler("show report", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /# report \[project\]/);
		assert.match(notifications.at(-1)?.message ?? "", /生成报告/);

		await commands.get("task").handler("show missing", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /不存在/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("task session restore and questionnaire flags persist state", async () => {
	const { pi, commands, handlers, entries } = makePi();
	const { ctx, statusCalls } = makeCtx();
	registerTask(pi as any);

	ctx.sessionManager.getEntries = () => [{
		customType: "task-state",
		data: { ...enterPlanning(createTaskState()), spec, planQuestionnaireUsed: false },
	}];
	await handlers.get("session_start")![0]({}, ctx);
	assert.deepEqual(statusCalls.at(-1), { key: "task-mode", value: "📋 task" });

	await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
	assert.equal((entries.at(-1)?.data as any).planQuestionnaireUsed, true);

	await commands.get("task").handler("exit", ctx);
	assert.equal((entries.at(-1)?.data as any).phase, "aborted");
	assert.deepEqual(statusCalls.at(-1), { key: "task-mode", value: undefined });
});

test("/task new enters planning, injects prompt, filters stale context, and parses Spec", async () => {
	const { pi, commands, handlers, activeTools, entries } = makePi();
	const { ctx, notifications } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	assert.deepEqual(activeTools.at(-1), ["read", "bash", "grep", "find", "ls", "questionnaire"]);

	const injected = await handlers.get("before_agent_start")![0]({}, ctx);
	assert.equal(injected.message.customType, "task-plan-context");
	assert.equal(injected.message.content, TASK_ALIGN_PROMPT);

	const oldContext = { role: "custom", customType: "task-plan-context", content: "old" };
	const newContext = { role: "custom", customType: "task-plan-context", content: "new" };
	const userMessage = { role: "user", content: [{ type: "text", text: "run" }] };
	const filtered = await handlers.get("context")![0]({ messages: [oldContext, userMessage, newContext] }, ctx);
	assert.deepEqual(filtered.messages, [userMessage, newContext]);

	await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
	await handlers.get("agent_end")![0]({
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
		}],
	}, ctx);

	assert.deepEqual((entries.at(-1)?.data as any).spec, spec);
	assert.match(notifications.at(-1)?.message ?? "", /Spec 已对齐/);
});

test("task pending transition opens the next-step menu in TUI", async () => {
	const { pi, commands, handlers, activeTools, entries } = makePi();
	const { ctx } = makeCtx();
	(ctx as any).hasUI = true;
	ctx.ui.select = () => "开始执行";
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
	await handlers.get("agent_end")![0]({
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
		}],
	}, ctx);

	assert.equal((entries.at(-1)?.data as any).phase, "executing");
	assert.deepEqual(activeTools.at(-1), ["read", "bash", "edit", "write", "task_complete"]);
});

test("task planning blocks non-readonly bash and removes plan context when inactive", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	const safe = await handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "git status --short" } }, ctx);
	assert.equal(safe, undefined);
	const blocked = await handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "npm install" } }, ctx);
	assert.deepEqual(blocked, {
		block: true,
		reason: "Task planning: command blocked (not read-only). Command: npm install",
	});

	await commands.get("task").handler("exit", ctx);
	const staleContext = { role: "custom", customType: "task-plan-context", content: "old" };
	const filtered = await handlers.get("context")![0]({ messages: [staleContext] }, ctx);
	assert.deepEqual(filtered.messages, []);
});

test("TASK_ALIGN_PROMPT requires questionnaire extras and machine-checkable acceptance", () => {
	assert.match(TASK_ALIGN_PROMPT, /questionnaire/);
	assert.match(TASK_ALIGN_PROMPT, /id="extras"/);
	assert.match(TASK_ALIGN_PROMPT, /你还有什么要补充的吗\?\(没有可留空\)/);
	assert.match(TASK_ALIGN_PROMPT, /machine-checkable/);
});

test("/task execute enforces C-2 and switches to non-subagent tools", async () => {
	const { pi, commands, handlers, activeTools, userMessages, entries } = makePi();
	const { ctx, notifications, statusCalls } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	await handlers.get("agent_end")![0]({
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
		}],
	}, ctx);
	await commands.get("task").handler("execute", ctx);
	assert.match(notifications.at(-1)?.message ?? "", /未用 questionnaire/);
	assert.match(userMessages.at(-1)?.text ?? "", /questionnaire/);

	await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
	await commands.get("task").handler("execute", ctx);
	assert.deepEqual(activeTools.at(-1), ["read", "bash", "edit", "write", "task_complete"]);
	assert.equal((entries.at(-1)?.data as any).phase, "executing");
	assert.deepEqual(statusCalls.at(-1), { key: "task-mode", value: "🔧 executing" });
	assert.match(userMessages.at(-1)?.text ?? "", /不要调用 subagent/);
});

test("RPC input can advance an Enter-gated task transition", async () => {
	const { pi, commands, handlers, activeTools, entries } = makePi();
	const { ctx } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
	await handlers.get("agent_end")![0]({
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
		}],
	}, ctx);

	await handlers.get("input")![0]({ source: "rpc", text: "" }, ctx);

	assert.deepEqual(activeTools.at(-1), ["read", "bash", "edit", "write", "task_complete"]);
	assert.equal((entries.at(-1)?.data as any).phase, "executing");
});

test("task review prompt parses skill verify contract output", () => {
	const prompt = buildTaskReviewPrompt(spec, "写入 output/report.json");
	assert.match(prompt, /TASK REVIEW MODE/);
	assert.match(prompt, /RequirementsSpec/);
	assert.match(prompt, /ExecutionSummary/);
	assert.match(TASK_REVIEW_PROMPT, /id="extras"/);
	assert.match(TASK_REVIEW_PROMPT, /SKILL DESIGN GATE/);
	assert.match(TASK_REVIEW_PROMPT, /source\/method/);
	assert.match(TASK_REVIEW_PROMPT, /required steps/);
	assert.match(TASK_REVIEW_PROMPT, /noise to omit/);
	assert.match(TASK_REVIEW_PROMPT, /output path and format/);
	assert.match(TASK_REVIEW_PROMPT, /requiredTools/);
	assert.match(TASK_REVIEW_PROMPT, /VERIFY DESIGN GATE/);
	assert.match(TASK_REVIEW_PROMPT, /artifacts/);
	assert.match(TASK_REVIEW_PROMPT, /assertions/);
	assert.match(TASK_REVIEW_PROMPT, /failure cases/);
	assert.match(TASK_REVIEW_PROMPT, /runtime input/);
	assert.match(TASK_REVIEW_PROMPT, /allowed variability/);
	assert.match(TASK_REVIEW_PROMPT, /empty-output negative case/);
	assert.match(TASK_REVIEW_PROMPT, /process\.cwd\(\)/);
	assert.match(TASK_REVIEW_PROMPT, /import\.meta\.url/);
	assert.match(TASK_REVIEW_PROMPT, /VerifyFailure\[\]/);
	assert.match(TASK_REVIEW_PROMPT, /\{"failures":\[/);

	const parsed = extractTaskReviewResult(`\`\`\`json
{
  "description": "生成报告",
  "tags": ["report"],
  "skill": "# Skill",
  "verify": "process.exit(0)",
  "contract": {"artifacts":[]}
}
\`\`\``);
	assert.deepEqual(parsed, {
		description: "生成报告",
		tags: ["report"],
		skill: "# Skill",
		verify: "process.exit(0)",
		contract: { artifacts: [] },
	});
	assert.equal(extractTaskReviewResult("{}"), undefined);
});

test("/task execute keeps environment tools, logs them, and blocks subagent via tool_call", async () => {
	// 模拟 main session 装了 chrome_cdp(环境工具),验证 execute 阶段保留它、只排除 subagent
	const { pi, commands, handlers, activeTools, entries } = makePi(["read", "bash", "edit", "write", "subagent", "chrome_cdp", "alpha__echo"]);
	const { ctx } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
	await handlers.get("agent_end")![0]({
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
		}],
	}, ctx);
	await commands.get("task").handler("execute", ctx);

	// execute 工具集保留 chrome_cdp,排除 subagent,末尾补 task_complete
	assert.deepEqual(activeTools.at(-1), ["read", "bash", "edit", "write", "chrome_cdp", "alpha__echo", "task_complete"]);
	await handlers.get("tool_call")![0]({ toolName: "alpha__echo", input: { query: "ping" } }, ctx);
	assert.match((entries.at(-1)?.data as any).executeProcessLog.at(-1).toolName, /alpha__echo/);

	// subagent 调用被 tool_call 硬 block(双保险,spec 4.2)
	const blocked = await handlers.get("tool_call")![0]({ toolName: "subagent", input: {} }, ctx);
	assert.deepEqual(blocked, {
		block: true,
		reason: "Task executing 阶段禁止调用 subagent(task-creator 必须亲手做)。",
	});
});

test("/task session restore keeps environment tools during executing", async () => {
	const { pi, handlers, activeTools } = makePi(["read", "bash", "edit", "write", "subagent", "chrome_cdp", "alpha__echo"]);
	const { ctx, statusCalls } = makeCtx();
	registerTask(pi as any);

	ctx.sessionManager.getEntries = () => [{
		customType: "task-state",
		data: startExecuting(markPlanQuestionnaireUsed(setTaskSpec(enterPlanning(createTaskState()), spec)), "run-dir"),
	}];
	await handlers.get("session_start")![0]({}, ctx);

	assert.deepEqual(activeTools.at(-1), ["read", "bash", "edit", "write", "chrome_cdp", "alpha__echo", "task_complete"]);
	assert.deepEqual(statusCalls.at(-1), { key: "task-mode", value: "🔧 executing" });
});

test("/task menu lets user enter review from executing with a completion summary", async () => {
	const { pi, commands, handlers, entries } = makePi();
	const { ctx, notifications } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
	await handlers.get("agent_end")![0]({
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
		}],
	}, ctx);
	await commands.get("task").handler("execute", ctx);

	ctx.ui.select = () => "进入复盘";
	ctx.ui.input = () => "已完成报告抓取";
	await commands.get("task").handler("", ctx);

	const latestState = entries.at(-1)?.data as any;
	assert.equal(latestState.pendingTransition, "review");
	assert.match(latestState.summary, /AgentSummary: 已完成报告抓取/);
	assert.match(notifications.at(-1)?.message ?? "", /请选择下一步/);
});

test("/task menu enters review when execute completion is already pending", async () => {
	const { pi, commands, handlers, entries, activeTools, userMessages } = makePi();
	const { ctx, statusCalls } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
	await handlers.get("agent_end")![0]({
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
		}],
	}, ctx);
	await commands.get("task").handler("execute", ctx);
	await commands.get("task").handler("continue-review 已完成报告抓取", ctx);

	ctx.ui.select = () => "进入复盘";
	await commands.get("task").handler("", ctx);

	assert.equal((entries.at(-1)?.data as any).phase, "reviewing");
	assert.deepEqual(activeTools.at(-1), ["read", "bash", "grep", "find", "ls", "questionnaire"]);
	assert.deepEqual(statusCalls.at(-1), { key: "task-mode", value: "📋 reviewing" });
	assert.match(userMessages.at(-1)?.text ?? "", /TASK REVIEW MODE/);
});

test("task_complete records process log and Enter gates review/save transitions", async () => {
	const { pi, commands, handlers, entries, activeTools, tools, userMessages } = makePi();
	const { cwd, ctx, notifications, statusCalls } = makeCtx();
	registerTask(pi as any);

	try {
		assert.ok(tools.some((tool) => tool.name === "task_complete"));
		await commands.get("task").handler("new", ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
			}],
		}, ctx);
		await commands.get("task").handler("execute", ctx);
		await handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "npm test" } }, ctx);
		await handlers.get("tool_call")![0]({ toolName: "write", input: { path: path.join(cwd, "report.json") } }, ctx);
		await handlers.get("tool_call")![0]({ toolName: "task_complete", input: { summary: "已生成 report.json" } }, ctx);

		assert.deepEqual(activeTools.at(-1), ["read", "bash", "edit", "write", "task_complete"]);
		assert.deepEqual(statusCalls.at(-1), { key: "task-mode", value: "🔧 executing" });
		assert.equal((entries.at(-1)?.data as any).phase, "executing");
		assert.ok((entries.at(-1)?.data as any).executeProcessLog.length >= 2);

		await handlers.get("tool_execution_end")![0]({ toolName: "task_complete", isError: false, result: { details: { summary: "已生成 report.json" } } }, ctx);
		assert.equal((entries.at(-1)?.data as any).phase, "executing");
		assert.equal((entries.at(-1)?.data as any).pendingTransition, "review");
		assert.match(notifications.at(-1)?.message ?? "", /请选择下一步/);

		await handlers.get("input")![0]({ source: "interactive", text: "" }, ctx);
		assert.deepEqual(activeTools.at(-1), ["read", "bash", "grep", "find", "ls", "questionnaire"]);
		assert.deepEqual(statusCalls.at(-1), { key: "task-mode", value: "📋 reviewing" });
		assert.equal((entries.at(-1)?.data as any).phase, "reviewing");
		assert.match(userMessages.at(-1)?.text ?? "", /TASK REVIEW MODE/);

		const injected = await handlers.get("before_agent_start")![0]({}, ctx);
		assert.equal(injected.message.customType, "task-review-context");
		assert.match(injected.message.content, /npm test/);
		assert.match(injected.message.content, /report\.json/);

		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json
{"description":"生成报告","skill":"# Skill","verify":"process.exit(0)","contract":{"artifacts":[]}}
\`\`\`` }],
			}],
		}, ctx);
		assert.equal((entries.at(-1)?.data as any).phase, "reviewing");
		assert.equal((entries.at(-1)?.data as any).pendingTransition, "save");
		assert.equal(await loadTaskbook(cwd, "my-task"), null);

		await handlers.get("input")![0]({ source: "interactive", text: "" }, ctx);
		assert.equal((entries.at(-1)?.data as any).phase, "landed");
		assert.match(notifications.at(-1)?.message ?? "", /已就绪/);
		assert.deepEqual(statusCalls.at(-1), { key: "task-mode", value: undefined });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task save runs verify self-check before landed", async () => {
	const { pi, commands, handlers, entries } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);

	try {
		await commands.get("task").handler("new", ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
			}],
		}, ctx);
		await commands.get("task").handler("execute", ctx);
		await handlers.get("tool_call")![0]({ toolName: "task_complete", input: { summary: "已生成 report.json" } }, ctx);
		await handlers.get("tool_execution_end")![0]({ toolName: "task_complete", isError: false, result: { details: { summary: "已生成 report.json" } } }, ctx);
		await handlers.get("input")![0]({ source: "interactive", text: "" }, ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json
{"description":"坏 verify","skill":"# Skill","verify":"console.log(JSON.stringify([{assertion:'a',expected:'e',actual:'x'}])); process.exit(1)","contract":{"artifacts":[]}}
\`\`\`` }],
			}],
		}, ctx);

		await commands.get("task").handler("save bad --project", ctx);

		assert.match(notifications.at(-1)?.message ?? "", /verify 自证失败/);
		assert.equal((entries.at(-1)?.data as any).phase, "reviewing");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task save rejects malformed verify failure output before writing taskbook", async () => {
	const { pi, commands, handlers, entries } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);

	try {
		await commands.get("task").handler("new", ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
			}],
		}, ctx);
		await commands.get("task").handler("execute", ctx);
		const executeRunDir = (entries.at(-1)?.data as any).executeRunDir;
		await writeFile(path.join(executeRunDir, "output", "report.md"), "# ok\n", "utf8");
		await handlers.get("tool_execution_end")![0]({ toolName: "task_complete", isError: false, result: { details: { summary: "已生成 report.md" } } }, ctx);
		await handlers.get("input")![0]({ source: "interactive", text: "" }, ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json
{
  "description":"坏失败格式",
  "skill":"# Skill",
  "verify":"import {readdir} from 'node:fs/promises'; const files = await readdir(process.env.TASK_OUTPUT_DIR).catch(() => []); if (files.length === 0) { console.log(JSON.stringify({failures:['empty']})); process.exit(1); } process.exit(0);",
  "contract":{"artifacts":[{"name":"report.md","type":"file"}]}
}
\`\`\`` }],
			}],
		}, ctx);

		await commands.get("task").handler("save malformed --project", ctx);

		assert.match(notifications.at(-1)?.message ?? "", /verify 失败输出格式错误/);
		assert.equal(await loadTaskbook(cwd, "malformed"), null);
		assert.equal((entries.at(-1)?.data as any).phase, "reviewing");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task save reruns empty-output negative check after asking runtime input", async () => {
	const { pi, commands, handlers, entries } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	ctx.ui.input = () => "ok";
	registerTask(pi as any);

	try {
		await commands.get("task").handler("new", ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
			}],
		}, ctx);
		await commands.get("task").handler("execute", ctx);
		const executeRunDir = (entries.at(-1)?.data as any).executeRunDir;
		await writeFile(path.join(executeRunDir, "output", "report.md"), "# ok\n", "utf8");
		await handlers.get("tool_execution_end")![0]({ toolName: "task_complete", isError: false, result: { details: { summary: "已生成 report.md" } } }, ctx);
		await handlers.get("input")![0]({ source: "interactive", text: "" }, ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json
{
  "description":"runtime input bad negative",
  "skill":"# Skill",
  "verify":"const input = JSON.parse(process.env.TASK_INPUT); if (input.token !== 'ok') { console.log(JSON.stringify([{assertion:'token',expected:'ok',actual:String(input.token)}])); process.exit(1); } process.exit(0);",
  "contract":{"runtimeInput":["token"],"artifacts":[{"name":"report.md","type":"file"}]}
}
\`\`\`` }],
			}],
		}, ctx);

		await commands.get("task").handler("save runtime-negative --project", ctx);

		assert.match(notifications.at(-1)?.message ?? "", /空 outputDir 也通过/);
		assert.equal(await loadTaskbook(cwd, "runtime-negative"), null);
		assert.equal((entries.at(-1)?.data as any).phase, "reviewing");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task edit loads an existing taskbook into update review", async () => {
	const { pi, commands, entries, userMessages, activeTools } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);

	try {
		await saveTaskbook("project", cwd, "editable", {
			description: "editable",
			spec,
			skill: "# Skill",
			verify: "process.exit(0)",
			contract: { artifacts: [] },
		});
		await commands.get("task").handler("edit editable", ctx);

		assert.equal((entries.at(-1)?.data as any).phase, "reviewing");
		assert.deepEqual((entries.at(-1)?.data as any).spec, spec);
		assert.equal((entries.at(-1)?.data as any).taskbookName, "editable");
		assert.equal((entries.at(-1)?.data as any).taskbookScope, "project");
		assert.deepEqual(activeTools.at(-1), ["read", "bash", "grep", "find", "ls", "questionnaire"]);
		assert.match(userMessages.at(-1)?.text ?? "", /更新已有 taskbook/);
		assert.match(userMessages.at(-1)?.text ?? "", /现有 skill\.md/);
		assert.match(userMessages.at(-1)?.text ?? "", /现有 verify\.mjs/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task edit save overwrites the existing taskbook scope and preserves runs", async () => {
	const { pi, commands, handlers } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);

	try {
		await saveTaskbook("project", cwd, "editable-save", {
			description: "old",
			spec,
			skill: "# Old",
			verify: "process.exit(0)",
			contract: { artifacts: [] },
		});
		await appendRunToTaskbook("project", cwd, "editable-save", {
			timestamp: new Date().toISOString(),
			status: "pass",
			input: {},
			exitCode: 0,
			verifyFailures: [],
			duration: 1,
		});

		await commands.get("task").handler("edit editable-save", ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json
{"description":"new","skill":"# New","verify":"process.exit(0)","contract":{"artifacts":[]}}
\`\`\`` }],
			}],
		}, ctx);
		await commands.get("task").handler("save", ctx);

		const loaded = await loadTaskbook(cwd, "editable-save");
		assert.equal(loaded?.scope, "project");
		assert.equal(loaded?.taskbook.description, "new");
		assert.equal(loaded?.skill, "# New");
		assert.equal(loaded?.taskbook.runs.length, 1);
		assert.match(notifications.at(-1)?.message ?? "", /已更新/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task delete removes a confirmed taskbook", async () => {
	const { pi, commands } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);

	try {
		await saveTaskbook("project", cwd, "delete-me", {
			description: "delete me",
			spec,
			skill: "# Skill",
			verify: "process.exit(0)",
			contract: { artifacts: [] },
		});
		await commands.get("task").handler("delete delete-me --project", ctx);

		assert.equal(await loadTaskbook(cwd, "delete-me"), null);
		assert.match(notifications.at(-1)?.message ?? "", /已删除/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task menu selects taskbook name for show edit delete and run", async () => {
	const { pi, commands, entries } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => ({
		agent: "worker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	}) as any);
	setTaskDispatcherForTests(async () => ({ text: "一句话" }));

	try {
		for (const name of ["menu-show", "menu-edit", "menu-delete", "menu-run"]) {
			await saveTaskbook("project", cwd, name, {
				description: name,
				spec,
				skill: "# Skill",
				verify: name === "menu-run"
					? "const input = JSON.parse(process.env.TASK_INPUT); if (input.text !== '一句话') process.exit(1); process.exit(0);\n"
					: "process.exit(0);\n",
				contract: name === "menu-run" ? { runtimeInput: ["text"], artifacts: [] } : { artifacts: [] },
			});
		}

		ctx.ui.select = (title: string) => title === "Task" ? "查看 taskbook 详情" : "menu-show";
		await commands.get("task").handler("", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /# menu-show \[project\]/);

		ctx.ui.select = (title: string) => title === "Task" ? "编辑 taskbook" : "menu-edit";
		await commands.get("task").handler("", ctx);
		assert.equal((entries.at(-1)?.data as any).taskbookName, "menu-edit");

		await commands.get("task").handler("exit", ctx);
		ctx.ui.select = (title: string) => title === "Task" ? "运行 taskbook(复用)" : "menu-run";
		ctx.ui.input = () => "一句话";
		await commands.get("task").handler("", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /PASS/);
		assert.deepEqual((await loadTaskbook(cwd, "menu-run"))?.taskbook.runs.at(-1)?.input, { text: "一句话" });

		ctx.ui.select = (title: string) => title === "Task" ? "删除 taskbook" : "menu-delete";
		await commands.get("task").handler("", ctx);
		assert.equal(await loadTaskbook(cwd, "menu-delete"), null);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run executes worker, verify, and records a pass run", async () => {
	const { pi, commands } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => ({
		agent: "worker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	}) as any);
	setTaskDispatcherForTests(async () => ({ url: "https://x" }));
	try {
		await saveTaskbook("project", cwd, "runner", {
			description: "runner",
			spec,
			skill: "# Skill",
			verify: "const input = JSON.parse(process.env.TASK_INPUT); if (input.url !== 'https://x') process.exit(1); process.exit(0);\n",
			contract: { runtimeInput: ["url"], artifacts: [] },
		});

		await commands.get("task").handler("run runner 把这个下下来 https://x", ctx);
		const loaded = await loadTaskbook(cwd, "runner");

		assert.match(notifications.at(-1)?.message ?? "", /PASS/);
		assert.equal(loaded?.taskbook.runs.at(-1)?.status, "pass");
		assert.deepEqual(loaded?.taskbook.runs.at(-1)?.input, { url: "https://x" });
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run preserves natural language input with spaces and shows pass artifacts with widget", async () => {
	const { pi, commands } = makePi();
	const { cwd, ctx, notifications, widgetCalls } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => {
		const outputDir = path.join(cwd, ".tasks", "runs");
		return {
			agent: "worker",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "写好了 count.json" }] }],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		} as any;
	});
	setTaskDispatcherForTests(async () => ({ text: "Hello world" }));
	try {
		await saveTaskbook("project", cwd, "runner-file", {
			description: "runner file",
			spec,
			skill: "# Skill",
			verify: "import {writeFile} from 'node:fs/promises'; const input = JSON.parse(process.env.TASK_INPUT); if (input.text !== 'Hello world') process.exit(1); await writeFile(`${process.env.TASK_OUTPUT_DIR}/count.json`, JSON.stringify({count:11}), 'utf8'); process.exit(0);\n",
			contract: { runtimeInput: ["text"], artifacts: [{ name: "count.json", type: "file", required: true }] },
		});

		await commands.get("task").handler("run runner-file Hello world", ctx);

		const message = notifications.at(-1)?.message ?? "";
		assert.match(message, /PASS/);
		assert.match(message, /任务: runner file/);
		assert.match(message, /count\.json/);
		assert.match(message, /\{"count":11\}/);
		assert.match(message, /## 任务结果/);
		assert.match(message, /## 产物/);
		assert.match(message, /## 验证/);
		assert.match(message, /verify 自证: 全过/);
		assert.match(message, /## 执行摘要/);
		assert.ok(widgetCalls.some((call) => call.lines?.some((line) => /worker 执行中/.test(line))));
		assert.equal(widgetCalls.at(-1)?.lines, undefined);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run shows worker progress updates in the widget", async () => {
	const { pi, commands } = makePi();
	const { cwd, ctx, widgetCalls } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async (...args: any[]) => {
		const onUpdate = args[7];
		onUpdate?.({
			content: [{ type: "text", text: "打开 Today 页面\n解析工具列表" }],
			details: { mode: "single", agentScope: "both", projectAgentsDir: null, results: [] },
		});
		return {
			agent: "worker",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "写好了" }] }],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		} as any;
	});
	setTaskDispatcherForTests(async () => ({}));
	try {
		await saveTaskbook("project", cwd, "runner-progress", {
			description: "runner progress",
			spec,
			skill: "# Skill",
			verify: "process.exit(0);\n",
			contract: { artifacts: [] },
		});

		await commands.get("task").handler("run runner-progress", ctx);

		const progress = widgetCalls
			.map((call) => call.lines?.join("\n") ?? "")
			.find((text) => text.includes("最近进展"));
		assert.match(progress ?? "", /1\. 打开 Today 页面/);
		assert.match(progress ?? "", /2\. 解析工具列表/);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run preauthorizes mentioned protected tools for the worker", async () => {
	const { pi, commands } = makePi(["read", "bash", "edit", "write", "subagent", "chrome_cdp", "alpha__echo"]);
	const { cwd, ctx } = makeCtx();
	const confirmations: Array<{ title: string; body?: string }> = [];
	let receivedEnv: Record<string, string | undefined> | undefined;
	ctx.ui.confirm = (title: string, body?: string) => {
		confirmations.push({ title, body });
		return true;
	};
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async (...args: any[]) => {
		receivedEnv = args[9];
		return {
			agent: "worker",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		} as any;
	});
	setTaskDispatcherForTests(async () => ({}));
	try {
		await saveTaskbook("project", cwd, "runner-tools", {
			description: "runner tools",
			spec,
			skill: "Use chrome_cdp and alpha__echo to finish.",
			verify: "process.exit(0);\n",
			contract: { artifacts: [], requiredTools: ["chrome_cdp", "alpha__echo"] },
		});

		await commands.get("task").handler("run runner-tools", ctx);

		assert.equal(confirmations.length, 1);
		assert.match(confirmations[0].body ?? "", /chrome_cdp/);
		assert.match(confirmations[0].body ?? "", /alpha__echo/);
		assert.equal(receivedEnv?.UGK_TASK_ALLOW_CHROME_CDP, "1");
		assert.equal(receivedEnv?.UGK_TASK_ALLOW_MCP_TOOLS, "alpha__echo");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run does not preauthorize tools mentioned only in contract artifact names", async () => {
	const { pi, commands } = makePi(["read", "bash", "edit", "write", "subagent", "alpha__echo"]);
	const { cwd, ctx } = makeCtx();
	let confirmCalled = false;
	let receivedEnv: Record<string, string | undefined> | undefined;
	ctx.ui.confirm = () => {
		confirmCalled = true;
		return true;
	};
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async (...args: any[]) => {
		receivedEnv = args[9];
		return {
			agent: "worker",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		} as any;
	});
	setTaskDispatcherForTests(async () => ({}));
	try {
		await saveTaskbook("project", cwd, "runner-artifact-tool-name", {
			description: "runner artifact tool name",
			spec,
			skill: "Write the requested artifact.",
			verify: "process.exit(0);\n",
			contract: { artifacts: [{ name: "alpha__echo.md", type: "file" }] },
		});

		await commands.get("task").handler("run runner-artifact-tool-name", ctx);

		assert.equal(confirmCalled, false);
		assert.deepEqual(receivedEnv, {});
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run does not start worker when protected tool preauthorization is denied", async () => {
	const { pi, commands } = makePi(["read", "bash", "edit", "write", "subagent", "chrome_cdp"]);
	const { cwd, ctx, notifications } = makeCtx();
	let workerStarted = false;
	ctx.ui.confirm = () => false;
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => {
		workerStarted = true;
		throw new Error("should not run");
	});
	setTaskDispatcherForTests(async () => ({}));
	try {
		await saveTaskbook("project", cwd, "runner-denied", {
			description: "runner denied",
			spec,
			skill: "Use chrome_cdp.",
			verify: "process.exit(0);\n",
			contract: { artifacts: [], requiredTools: ["chrome_cdp"] },
		});

		await commands.get("task").handler("run runner-denied", ctx);

		assert.equal(workerStarted, false);
		assert.match(notifications.at(-1)?.message ?? "", /已取消/);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run displays small markdown artifact content in the PASS report", async () => {
	const { pi, commands } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => ({
		agent: "worker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "写好了 markdown" }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	}) as any);
	setTaskDispatcherForTests(async () => ({}));
	try {
		await saveTaskbook("project", cwd, "runner-md", {
			description: "runner md",
			spec,
			skill: "# Skill",
			verify: "import {writeFile} from 'node:fs/promises'; await writeFile(`${process.env.TASK_OUTPUT_DIR}/report.md`, '| Name | Desc |\\n|---|---|\\n| Kane CLI | Browser automation |\\n', 'utf8'); process.exit(0);\n",
			contract: { artifacts: [{ name: "report.md", type: "file", required: true }] },
		});

		await commands.get("task").handler("run runner-md", ctx);

		const message = notifications.at(-1)?.message ?? "";
		assert.match(message, /任务: runner md/);
		assert.match(message, /### report\.md/);
		assert.match(message, /\| Kane CLI \| Browser automation \|/);
		assert.match(message, /## 执行摘要\n> 写好了 markdown/);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run asks for missing input when no raw text is provided", async () => {
	const { pi, commands } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => ({
		agent: "worker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	}) as any);
	setTaskDispatcherForTests(async () => undefined);
	try {
		await saveTaskbook("project", cwd, "runner-b64", {
			description: "runner b64",
			spec,
			skill: "# Skill",
			verify: "const input = JSON.parse(process.env.TASK_INPUT); if (input.text !== 'text') process.exit(1); process.exit(0);\n",
			contract: { runtimeInput: ["text"], artifacts: [] },
		});

		await commands.get("task").handler("run runner-b64", ctx);
		const loaded = await loadTaskbook(cwd, "runner-b64");

		assert.equal(loaded?.taskbook.runs.at(-1)?.status, "pass");
		assert.deepEqual(loaded?.taskbook.runs.at(-1)?.input, { text: "text" });
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run sends verify failures to checker and records fail on abort", async () => {
	const { pi, commands } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => ({
		agent: "worker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	}) as any);
	setTaskCheckerRunnerForTests(async () => ({
		agent: "checker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "```json\n{\"hint\":\"坏输入\",\"verdict\":\"abort\",\"reason\":\"无法修复\"}\n```" }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	}) as any);
	try {
		await saveTaskbook("project", cwd, "runner-fail", {
			description: "runner fail",
			spec,
			skill: "# Skill",
			verify: "console.log(JSON.stringify([{assertion:'a',expected:'e',actual:'x'}])); process.exit(1);\n",
			contract: { artifacts: [] },
		});

		await commands.get("task").handler("run runner-fail", ctx);
		const loaded = await loadTaskbook(cwd, "runner-fail");

		assert.ok(notifications.some((item) => /checker 判 abort/.test(item.message)));
		assert.match(notifications.at(-1)?.message ?? "", /FAIL/);
		assert.match(notifications.at(-1)?.message ?? "", /任务: runner fail/);
		assert.match(notifications.at(-1)?.message ?? "", /失败断言/);
		assert.match(notifications.at(-1)?.message ?? "", /## 执行摘要\n> done/);
		assert.equal(loaded?.taskbook.runs.at(-1)?.status, "fail");
		assert.equal(loaded?.taskbook.runs.at(-1)?.verifyFailures[0].assertion, "a");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskCheckerRunnerForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task run failure offers optional taskbook repair", async () => {
	const { pi, commands, entries, userMessages } = makePi();
	const { cwd, ctx, notifications, selections } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => ({
		agent: "worker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "wrote bad links" }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	}) as any);
	setTaskCheckerRunnerForTests(async () => ({
		agent: "checker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "```json\n{\"hint\":\"修 verify\",\"verdict\":\"abort\",\"reason\":\"verify 太严\"}\n```" }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	}) as any);
	try {
		await saveTaskbook("project", cwd, "runner-repair", {
			description: "runner repair",
			spec,
			skill: "# Skill",
			verify: "console.log(JSON.stringify([{assertion:'link',expected:'toolify link',actual:'bad'}])); process.exit(1);\n",
			contract: { artifacts: [] },
		});

		await commands.get("task").handler("run runner-repair", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /用 \/task 选择修正/);

		ctx.ui.select = (title: string, options: string[]) => {
			selections.push({ title, options });
			return "修正本 taskbook";
		};
		await commands.get("task").handler("", ctx);

		assert.deepEqual(selections.at(-1)?.options, ["修正本 taskbook", "重新运行", "查看 taskbook 详情", "放弃", "Exit"]);
		assert.equal((entries.at(-1)?.data as any).phase, "reviewing");
		assert.match(userMessages.at(-1)?.text ?? "", /修正已有 taskbook/);
		assert.match(userMessages.at(-1)?.text ?? "", /失败断言/);
		assert.match(userMessages.at(-1)?.text ?? "", /link/);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskCheckerRunnerForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/task save defaults to execute output dir when no output-dir is passed", async () => {
	const { pi, commands, handlers, entries, userMessages } = makePi();
	const { cwd, ctx, notifications } = makeCtx();
	registerTask(pi as any);

	try {
		await commands.get("task").handler("new", ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }],
			}],
		}, ctx);
		await commands.get("task").handler("execute", ctx);
		const executeRunDir = (entries.at(-1)?.data as any).executeRunDir;
		assert.match(userMessages.at(-1)?.text ?? "", /TASK_OUTPUT_DIR/);
		await mkdir(path.join(executeRunDir, "output"), { recursive: true });
		await writeFile(path.join(executeRunDir, "output", "report.json"), "{}", "utf8");

		await handlers.get("tool_call")![0]({ toolName: "task_complete", input: { summary: "已生成 report.json" } }, ctx);
		await handlers.get("tool_execution_end")![0]({ toolName: "task_complete", isError: false, result: { details: { summary: "已生成 report.json" } } }, ctx);
		await handlers.get("input")![0]({ source: "interactive", text: "" }, ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
		await handlers.get("agent_end")![0]({
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`json
{"description":"生成报告","skill":"# Skill","verify":"import {stat} from 'node:fs/promises'; try { await stat(process.env.TASK_OUTPUT_DIR + '/report.json'); process.exit(0); } catch { console.log(JSON.stringify([{assertion:'report.json exists',expected:'present',actual:'missing'}])); process.exit(1); }","contract":{"artifacts":[{"name":"report.json","type":"file"}]}}
\`\`\`` }],
			}],
		}, ctx);

		await commands.get("task").handler("save smart --project", ctx);

		assert.equal((entries.at(-1)?.data as any).phase, "landed");
		assert.match(notifications.at(-1)?.message ?? "", /已就绪/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
