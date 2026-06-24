import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	extractArtifactsFromToolInput,
	isSafeCommand,
	summarizeToolArgs,
} from "./task-utils.ts";
import { extractRequirementsSpec, formatRequirementsSpec } from "./task-spec.ts";
import {
	abortTask,
	createTaskState,
	enterPlanning,
	enterReviewing,
	landTask,
	markPlanQuestionnaireUsed,
	markReviewQuestionnaireUsed,
	recordExecuteProcessEntry,
	setPendingTransition,
	setTaskSpec,
	setTaskReviewResult,
	startExecuting,
	type TaskPhase,
	type TaskState,
} from "./task-state.ts";
import { appendRunToTaskbook, deleteTaskbook, listTaskbooks, loadTaskbook, renameTaskbook, saveTaskbook, type LoadedTaskbook } from "./task-book.ts";
import { dispatchChecker } from "./task-checker.ts";
import { resolveRuntimeInputFromText } from "./task-dispatcher.ts";
import { buildTaskReviewPrompt, extractTaskReviewResult, TASK_ALIGN_PROMPT } from "./task-prompts.ts";
import { buildTaskbookPrompt } from "./task-registry.ts";
import { dispatchTaskRunReviewer } from "./task-run-reviewer.ts";
import { runVerify } from "./task-verify.ts";
import { dispatchWorker, type TaskWorkerResult } from "./task-worker.ts";
import { mapWithConcurrencyLimit } from "../subagent-runtime.ts";

const TASK_STATE_TYPE = "task-state";
const TASK_PLAN_CONTEXT_TYPE = "task-plan-context";
const TASK_REVIEW_CONTEXT_TYPE = "task-review-context";
const TASK_PLANNING_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const TASK_NORMAL_TOOLS = ["read", "bash", "edit", "write", "subagent"];
const PREVIEW_TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".csv", ".tsv", ".html", ".htm"]);
const MAX_ARTIFACT_PREVIEW_CHARS = 12000;
const SUBTASK_MAX = 8;
const SUBTASK_CONCURRENCY = 4;

type SubtaskRequest = { name: string; input: string };
type SubtaskResult = {
	name: string;
	status: "pass" | "fail";
	outputDir: string;
	artifacts: string[];
	verifyFailures: Awaited<ReturnType<typeof runVerify>>["failures"];
	workerSummary: string;
	duration: number;
	attempts: number;
};

type TaskRunFailure = {
	taskbookName: string;
	taskbookScope: LoadedTaskbook["scope"];
	spec: LoadedTaskbook["spec"];
	runDir: string;
	summary: string;
};

type ActiveTaskRun = {
	taskbookName: string;
	abortController: AbortController;
	progress: string[];
	notes: string[];
};

type LastTaskRunReview = {
	taskbookName: string;
	content: string;
};

let activeTaskRun: ActiveTaskRun | undefined;
let lastTaskRunReview: LastTaskRunReview | undefined;
let taskRunPromiseForTests: Promise<void> = Promise.resolve();

export function waitForTaskRunForTests(): Promise<void> {
	return taskRunPromiseForTests;
}

const taskCompleteTool = defineTool({
	name: "task_complete",
	label: "Task Complete",
	description: "Signal that /task executing phase has completed and review can start.",
	parameters: Type.Object({
		summary: Type.Optional(Type.String({ description: "Short completion summary" })),
	}),
	async execute(_toolCallId, params) {
		const summary = typeof params.summary === "string" ? params.summary : "";
		return {
			content: [{ type: "text", text: summary ? `task_complete received: ${summary}` : "task_complete received." }],
			details: { completed: true, summary },
		};
	},
});

const MENU_TO_ACTION = new Map<string, string | undefined>([
	["新建任务", "new"],
	["开始执行", "execute"],
	["继续对齐", "clarify"],
	["修改当前 Spec", "change-spec"],
	["运行 taskbook", "run"],
	["运行 taskbook(复用)", "run"],
	["查看 taskbook 详情", "show"],
	["编辑 taskbook", "edit"],
	["重命名 taskbook", "rename"],
	["列出 taskbook", "list"],
	["保存为 taskbook", "save"],
	["自动保存并自证", "save"],
	["自动保存 taskbook", "save"],
	["删除 taskbook", "delete"],
	["进入复盘", "continue-review"],
	["继续复盘", "continue-review"],
	["修正本 taskbook", "repair"],
	["重新运行", "rerun"],
	["放弃", "abort"],
	["停止本次执行", "stop"],
	["停止当前运行", "stop"],
	["查看运行进展", "run-status"],
	["复盘上次运行", "review-last-run"],
	["退出 Task", "exit"],
	["Exit", undefined],
]);

function isActivePhase(phase: TaskPhase): boolean {
	return phase === "planning" || phase === "executing" || phase === "reviewing";
}

// execute 阶段的 task-creator 继承 main session 全部工具(含 chrome_cdp/mcp 等环境工具),
// 只排除 subagent(spec 4.2:task-creator 必须亲手做),并补 task_complete 信号工具。
// 用 active snapshot/current active set,不用 getAllTools 全量注册表,避免打开从未启用的注册工具。
function applyExecuteTools(pi: ExtensionAPI): void {
	const blocked = new Set(["subagent"]);
	const next = (typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS)
		.filter((tool) => !blocked.has(tool));
	if (!next.includes("task_complete")) next.push("task_complete");
	pi.setActiveTools?.(next);
}

export function getTaskCommandMenuOptions(state: TaskState): string[] {
	if (state.pendingTransition === "repair") return ["修正本 taskbook", "重新运行", "查看 taskbook 详情", "放弃", "Exit"];
	if (state.phase === "planning") {
		return state.spec
			? ["开始执行", "继续对齐", "修改当前 Spec", "退出 Task", "Exit"]
			: ["继续对齐", "退出 Task", "Exit"];
	}
	if (state.phase === "executing") return ["进入复盘", "停止本次执行", "Exit"];
	if (state.phase === "reviewing") return ["自动保存并自证", "继续复盘", "放弃", "退出 Task", "Exit"];
	return ["新建任务", "运行 taskbook(复用)", "列出 taskbook", "查看 taskbook 详情", "编辑 taskbook", "重命名 taskbook", "删除 taskbook", "Exit"];
}

export async function resolveTaskCommandArgs(args: string, ctx: any, state: TaskState, runActive = false, hasLastRunReview = false): Promise<string | undefined> {
	if (args.trim()) return args;
	if (runActive && ctx.ui?.select) {
		const selection = await ctx.ui.select("Task", ["停止当前运行", "查看运行进展", "Exit"]);
		return selection ? MENU_TO_ACTION.get(selection) : undefined;
	}
	if (!ctx.ui?.select) return "list";
	const options = getTaskCommandMenuOptions(state);
	const selection = await ctx.ui.select("Task", hasLastRunReview && !isActivePhase(state.phase)
		? ["复盘上次运行", ...options]
		: options);
	return selection ? MENU_TO_ACTION.get(selection) : undefined;
}

function cwdOf(ctx: any): string {
	return ctx.cwd ?? process.cwd();
}

function isAssistantMessage(message: any): boolean {
	return message?.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: any): string {
	return message.content
		.filter((block: any) => block.type === "text")
		.map((block: any) => block.text)
		.join("\n");
}

function isTaskPlanContextMessage(message: any): boolean {
	return message?.role === "custom" && message.customType === TASK_PLAN_CONTEXT_TYPE;
}

function isTaskReviewContextMessage(message: any): boolean {
	return message?.role === "custom" && message.customType === TASK_REVIEW_CONTEXT_TYPE;
}

function filterTaskContextMessages(messages: any[], state: TaskState): any[] {
	if (state.phase !== "planning" && state.phase !== "reviewing") {
		return messages.filter((message) => !isTaskPlanContextMessage(message) && !isTaskReviewContextMessage(message));
	}
	if (state.phase === "reviewing") {
		let keepIndex = -1;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			if (isTaskReviewContextMessage(messages[index])) {
				keepIndex = index;
				break;
			}
		}
		return messages.filter((message, index) =>
			!isTaskPlanContextMessage(message) && (!isTaskReviewContextMessage(message) || index === keepIndex));
	}
	let keepIndex = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (isTaskPlanContextMessage(messages[index])) {
			keepIndex = index;
			break;
		}
	}
	return messages.filter((message, index) => !isTaskPlanContextMessage(message) || index === keepIndex);
}

function restoreTaskState(data: unknown): TaskState | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const record = data as Partial<TaskState>;
	if (
		record.phase !== "planning" &&
		record.phase !== "executing" &&
		record.phase !== "reviewing" &&
		record.phase !== "landed" &&
		record.phase !== "aborted" &&
		record.phase !== "done"
	) {
		return undefined;
	}
	return {
		...createTaskState(),
		...record,
		spec: record.spec ?? null,
		taskbookScope: record.taskbookScope === "user" || record.taskbookScope === "project" ? record.taskbookScope : undefined,
		summary: typeof record.summary === "string" ? record.summary : "",
		retryCount: typeof record.retryCount === "number" ? record.retryCount : 0,
		maxRetry: typeof record.maxRetry === "number" ? record.maxRetry : 3,
		planQuestionnaireUsed: record.planQuestionnaireUsed === true,
		reviewQuestionnaireUsed: record.reviewQuestionnaireUsed === true,
		executeRunDir: typeof record.executeRunDir === "string" ? record.executeRunDir : undefined,
		executeProcessLog: Array.isArray(record.executeProcessLog) ? record.executeProcessLog as TaskState["executeProcessLog"] : [],
		pendingTransition: record.pendingTransition === "execute" || record.pendingTransition === "review" || record.pendingTransition === "save" || record.pendingTransition === "repair"
			? record.pendingTransition
			: undefined,
	};
}

function formatTaskList(items: Awaited<ReturnType<typeof listTaskbooks>>): string {
	if (items.length === 0) return "No taskbooks found.";
	return items
		.map((item) => {
			const last = item.lastRun ? ` last=${item.lastRun.status}` : " last=-";
			return `${item.name} [${item.scope}]${last} — ${item.description}`;
		})
		.join("\n");
}

function tagFromTokens(tokens: string[]): string | undefined {
	const index = tokens.indexOf("--tag");
	return index >= 0 ? tokens[index + 1] : undefined;
}

async function handleTaskList(ctx: any, tokens: string[]): Promise<void> {
	ctx.ui.notify(formatTaskList(await listTaskbooks(cwdOf(ctx), tagFromTokens(tokens))), "info");
}

async function chooseTaskbookName(ctx: any, name: string | undefined, tag?: string): Promise<string | undefined> {
	if (name) return name;
	const items = await listTaskbooks(cwdOf(ctx), tag);
	if (items.length === 0) {
		ctx.ui.notify("No taskbooks found.", "warning");
		return undefined;
	}
	if (!ctx.ui?.select) return items[0].name;
	const selected = await ctx.ui.select("选择 taskbook", items.map((item) => item.name));
	return selected || undefined;
}

async function handleTaskShow(ctx: any, name: string | undefined): Promise<void> {
	const finalName = await chooseTaskbookName(ctx, name);
	if (!finalName) return;
	const loaded = await loadTaskbook(cwdOf(ctx), finalName);
	if (!loaded) {
		ctx.ui.notify(`taskbook "${finalName}" 不存在`, "warning");
		return;
	}
	ctx.ui.notify([
		`# ${loaded.taskbook.name} [${loaded.scope}]`,
		loaded.taskbook.description,
		"",
		"## Spec",
		formatRequirementsSpec(loaded.spec),
		"",
		"## Skill",
		loaded.skill.trim(),
		"",
		"## Verify",
		loaded.verify.trim(),
		"",
		"## Contract",
		JSON.stringify(loaded.contract, null, 2),
	].join("\n"), "info");
}

function scopeFromTokens(tokens: string[]): "user" | "project" {
	return tokens.includes("--project") ? "project" : "user";
}

function explicitScopeFromTokens(tokens: string[]): "user" | "project" | undefined {
	if (tokens.includes("--project")) return "project";
	if (tokens.includes("--user")) return "user";
	return undefined;
}

function parseTaskCommand(resolvedArgs: string): { action: string; name?: string; tokens: string[]; rawInput: string } {
	const tokens = resolvedArgs.trim().split(/\s+/).filter(Boolean);
	const action = (tokens[0] ?? "list").toLowerCase();
	const name = tokens[1];
	const prefix = name ? `${tokens[0]} ${name}` : tokens[0] ?? "";
	const rawInput = prefix ? resolvedArgs.slice(prefix.length).trim() : "";
	return { action, name, tokens, rawInput };
}

function runtimeFields(contract: unknown): string[] {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return [];
	const value = (contract as Record<string, unknown>).runtimeInput;
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function contractToolNames(contract: unknown): string[] {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return [];
	const record = contract as Record<string, unknown>;
	const values = [...(Array.isArray(record.requiredTools) ? record.requiredTools : []), ...(Array.isArray(record.protectedTools) ? record.protectedTools : [])];
	return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function mentionsTool(text: string, tool: string): boolean {
	const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`).test(text);
}

function resolveProtectedTaskTools(loaded: LoadedTaskbook | LoadedTaskbook[], activeTools: string[]): { chromeCdp: boolean; mcpTools: string[] } {
	const taskbooks = Array.isArray(loaded) ? loaded : [loaded];
	const uses = (tool: string) => taskbooks.some((item) => {
		const declared = new Set(contractToolNames(item.contract));
		return declared.has(tool) || mentionsTool(item.skill, tool);
	});
	return {
		chromeCdp: activeTools.includes("chrome_cdp") && uses("chrome_cdp"),
		mcpTools: activeTools.filter((tool) => tool.includes("__") && uses(tool)),
	};
}

export async function resolveTaskWorkerEnv(
	ctx: any,
	loaded: LoadedTaskbook | LoadedTaskbook[],
	activeTools: string[],
): Promise<Record<string, string | undefined> | null> {
	const protectedTools = resolveProtectedTaskTools(loaded, activeTools);
	const names = [
		...(protectedTools.chromeCdp ? ["chrome_cdp"] : []),
		...protectedTools.mcpTools,
	];
	if (names.length === 0) return {};
	const taskbookNames = (Array.isArray(loaded) ? loaded : [loaded]).map((item) => item.taskbook.name).join(", ");
	const allowed = await ctx.ui?.confirm?.(
		"允许本次 task 使用受保护工具?",
		[
			`taskbook "${taskbookNames}" 声明会使用: ${names.join(", ")}`,
			"",
			"授权只传给本次 worker 子进程,不改变 /cdp 或 /mcp 的全局模式。",
		].join("\n"),
	);
	if (!allowed) return null;
	return {
		...(protectedTools.chromeCdp ? { UGK_TASK_ALLOW_CHROME_CDP: "1" } : {}),
		...(protectedTools.mcpTools.length > 0 ? { UGK_TASK_ALLOW_MCP_TOOLS: protectedTools.mcpTools.join(",") } : {}),
	};
}

async function resolveRuntimeInput(ctx: any, skill: string, contract: unknown, rawInput: string, headless = false): Promise<unknown> {
	return await resolveRuntimeInputFromText(ctx, skill, contract, rawInput, taskbookModel(contract, "dispatcherModel"), headless);
}

async function resolveSelfCheckInput(ctx: any, contract: unknown): Promise<unknown> {
	const fields = runtimeFields(contract);
	if (fields.length === 0) return {};
	return Object.fromEntries(fields.map((field) => [field, ""]));
}

async function askSelfCheckInput(ctx: any, contract: unknown): Promise<unknown> {
	const fields = runtimeFields(contract);
	if (fields.length === 0) return {};
	const entries: Array<[string, string]> = [];
	for (const field of fields) {
		const value = await ctx.ui?.input?.(`verify 自证示例输入: ${field}`, field);
		entries.push([field, value ?? ""]);
	}
	return Object.fromEntries(entries);
}

function artifactNames(contract: unknown): string[] {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return [];
	const artifacts = (contract as Record<string, unknown>).artifacts;
	if (!Array.isArray(artifacts)) return [];
	return artifacts
		.map((artifact) => artifact && typeof artifact === "object" && !Array.isArray(artifact)
			? (artifact as Record<string, unknown>).name
			: undefined)
		.filter((name): name is string => typeof name === "string");
}

function resolveRunOutputDir(contract: unknown, fallbackOutputDir: string): string {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return fallbackOutputDir;
	const outputDir = (contract as Record<string, unknown>).outputDir;
	return typeof outputDir === "string" && path.isAbsolute(outputDir) ? outputDir : fallbackOutputDir;
}

async function withTempVerify(cwd: string, verify: string, fn: (verifyPath: string, tempDir: string) => Promise<void>): Promise<void> {
	const tempDir = path.join(cwd, ".tasks", "tmp", `verify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(tempDir, { recursive: true });
	try {
		const verifyPath = path.join(tempDir, "verify.mjs");
		await writeFile(verifyPath, verify, "utf8");
		await fn(verifyPath, tempDir);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

function malformedVerifyFailureOutput(verifyResult: Awaited<ReturnType<typeof runVerify>>): boolean {
	return verifyResult.failures.length === 0 ||
		verifyResult.failures.some((failure) => failure.assertion === "verify.mjs 输出结构化失败");
}

async function formatArtifact(outputDir: string, name: string): Promise<string[]> {
	const filePath = path.resolve(outputDir, name);
	try {
		const info = await stat(filePath);
		const lines = [`- ${name} (${info.size} bytes)`, `  路径: ${filePath}`];
		const extension = path.extname(name).toLowerCase();
		if (PREVIEW_TEXT_EXTENSIONS.has(extension)) {
			const content = await readFile(filePath, "utf8");
			const preview = content.length > MAX_ARTIFACT_PREVIEW_CHARS
				? `${content.slice(0, MAX_ARTIFACT_PREVIEW_CHARS)}\n\n...内容过长,已截断;完整内容见文件。`
				: content;
			lines.push("", `### ${name}`, preview.trimEnd());
		}
		return lines;
	} catch (error) {
		return [`- ${name} (missing: ${(error as Error).message})`, `  路径: ${filePath}`];
	}
}

async function formatArtifacts(contract: unknown, outputDir: string): Promise<string[]> {
	const names = artifactNames(contract);
	const actualNames = names.length > 0
		? names
		: (await readdir(outputDir).catch(() => []));
	const lines = ["## 产物"];
	for (const name of actualNames) lines.push(...await formatArtifact(outputDir, name));
	return lines;
}

async function collectArtifactPaths(contract: unknown, outputDir: string): Promise<string[]> {
	const names = artifactNames(contract);
	const actualNames = names.length > 0
		? names
		: (await readdir(outputDir).catch(() => []));
	return actualNames.map((name) => path.resolve(outputDir, name));
}

function taskbookModel(contract: unknown, field: "dispatcherModel" | "workerModel"): string | undefined {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return undefined;
	const value = (contract as Record<string, unknown>)[field];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatWorkerSummary(summary: string | undefined): string {
	const text = summary?.trim();
	if (!text) return "无";
	return text.split(/\r?\n/).map((line) => line ? `> ${line}` : ">").join("\n");
}

function formatOptionalSection(title: string, lines: string[] | undefined): string[] {
	const useful = (lines ?? []).map((line) => line.trim()).filter(Boolean);
	return useful.length > 0 ? ["", `## ${title}`, ...useful.map((line, index) => `${index + 1}. ${line}`)] : [];
}

function buildTaskRunReviewContext(taskbookName: string, report: string): string {
	return [
		"[TASK RUN REVIEW]",
		"请复盘这次 /task run。重点解释是否发生重试、失败、绕路或早期判断错误;如果需要修改 taskbook,建议用户进入 /task edit。",
		"",
		`Taskbook: ${taskbookName}`,
		"",
		report,
	].join("\n");
}

async function formatRunResult(
	loaded: LoadedTaskbook,
	outputDir: string,
	workerResult: TaskWorkerResult | undefined,
	verifyResult: Awaited<ReturnType<typeof runVerify>> | undefined,
	passed: boolean,
	attempts: number,
	durationSeconds: number,
	progress?: string[],
	notes?: string[],
): Promise<string> {
	if (passed) {
		return [
			"## 任务结果",
			`✅ taskbook "${loaded.taskbook.name}" PASS`,
			`任务: ${loaded.taskbook.description}`,
			`尝试: ${attempts} 次`,
			`耗时: ${durationSeconds.toFixed(1)}s`,
			"",
			...await formatArtifacts(loaded.contract, outputDir),
			"",
			"## 验证",
			"verify 自证: 全过",
			"",
			"## 执行摘要",
			formatWorkerSummary(workerResult?.summary),
			...formatOptionalSection("最近进展", progress),
			...formatOptionalSection("运行中用户备注", notes),
		].filter(Boolean).join("\n");
	}
	const failures = verifyResult?.failures ?? [];
	return [
		"## 任务结果",
		`❌ taskbook "${loaded.taskbook.name}" FAIL`,
		`任务: ${loaded.taskbook.description}`,
		`尝试: ${attempts} 次`,
		`耗时: ${durationSeconds.toFixed(1)}s`,
		"",
		"## 验证",
		"失败断言:",
		...(failures.length > 0
			? failures.map((failure) => `  - ${failure.assertion}: 预期 ${failure.expected}, 实际 ${failure.actual}`)
			: ["  - verify 未返回结构化失败"]),
		"",
		"## 执行摘要",
		formatWorkerSummary(workerResult?.summary),
		...formatOptionalSection("最近进展", progress),
		...formatOptionalSection("运行中用户备注", notes),
	].join("\n");
}

async function formatRepairSummary(
	loaded: LoadedTaskbook,
	outputDir: string,
	workerResult: TaskWorkerResult | undefined,
	verifyResult: Awaited<ReturnType<typeof runVerify>> | undefined,
): Promise<string> {
	const failures = verifyResult?.failures ?? [];
	return [
		"[TASKBOOK REPAIR CONTEXT]",
		"修正已有 taskbook。请基于本次失败,用 questionnaire 逐项核对要改 skill、verify 还是 contract,最后输出完整 taskbook JSON。",
		"",
		`Taskbook: ${loaded.taskbook.name}`,
		`Description: ${loaded.taskbook.description}`,
		`OutputDir: ${outputDir}`,
		"",
		"失败断言:",
		...(failures.length > 0
			? failures.map((failure) => `- ${failure.assertion}: 预期 ${failure.expected}, 实际 ${failure.actual}`)
			: ["- verify 未返回结构化失败"]),
		"",
		"WorkerSummary:",
		workerResult?.summary?.trim() || "(none)",
		"",
		"现有 skill.md:",
		"```md",
		loaded.skill.trim(),
		"```",
		"",
		"现有 verify.mjs:",
		"```js",
		loaded.verify.trim(),
		"```",
		"",
		"现有 contract.json:",
		"```json",
		JSON.stringify(loaded.contract, null, "\t"),
		"```",
	].join("\n");
}

function formatTaskbookUpdateSummary(loaded: LoadedTaskbook): string {
	return [
		"[TASKBOOK UPDATE CONTEXT]",
		"更新已有 taskbook。请基于现有 spec/skill/verify/contract,用 questionnaire 逐项确认要调整哪些细节;不要把它当成新建任务从头重做。",
		"",
		`Taskbook: ${loaded.taskbook.name}`,
		`Scope: ${loaded.scope}`,
		`Description: ${loaded.taskbook.description}`,
		"",
		"现有 skill.md:",
		"```md",
		loaded.skill.trim(),
		"```",
		"",
		"现有 verify.mjs:",
		"```js",
		loaded.verify.trim(),
		"```",
		"",
		"现有 contract.json:",
		"```json",
		JSON.stringify(loaded.contract, null, "\t"),
		"```",
	].join("\n");
}

function setTaskRunWidget(ctx: any, lines: string[] | undefined): void {
	ctx.ui?.setWidget?.("task-run-view", lines, { placement: "aboveEditor" });
}

function formatProgressLines(text: string): string[] {
	if (text.trim() === "(running...)") return [];
	return text
		.split(/\r?\n/)
		.map((line) => line.replace(/^#{1,6}\s*/, "").replace(/^[-*]\s*/, "").trim())
		.filter(Boolean)
		.slice(-5)
		.map((line, index) => `${index + 1}. ${line.length > 120 ? `${line.slice(0, 117)}...` : line}`);
}

function formatExecuteSummary(state: TaskState, completionSummary = ""): string {
	const lines = [
		"[TASK EXECUTE SUMMARY]",
		"",
		completionSummary.trim() ? `AgentSummary: ${completionSummary.trim()}` : "",
		state.executeRunDir ? `RunDir: ${state.executeRunDir}` : "",
		"",
		"ProcessLog:",
	];
	for (const entry of state.executeProcessLog) {
		if (entry.kind === "artifact") {
			lines.push(`[${entry.timestamp}] artifact ${entry.artifactPath}`);
		} else {
			lines.push(`[${entry.timestamp}] ${entry.toolName}: ${entry.argsSummary ?? ""}`);
		}
	}
	return lines.filter((line) => line !== "").join("\n");
}

function taskCompleteSummaryFromEvent(event: any): string {
	const candidates = [
		event?.result?.details?.summary,
		event?.result?.summary,
		event?.input?.summary,
	];
	return candidates.find((value) => typeof value === "string") ?? "";
}

async function loadSubtask(cwd: string, name: string): Promise<LoadedTaskbook> {
	const loaded = await loadTaskbook(cwd, name);
	if (loaded) return loaded;
	const available = (await listTaskbooks(cwd)).map((item) => item.name).join(", ") || "(none)";
	throw new Error(`taskbook "${name}" 不存在。可用: ${available}`);
}

async function executeSubtask(
	ctx: any,
	request: SubtaskRequest,
	loaded: LoadedTaskbook,
	workerEnv: Record<string, string | undefined>,
	signal?: AbortSignal,
): Promise<SubtaskResult> {
	const startedAt = Date.now();
	const runDir = path.join(cwdOf(ctx), ".tasks", "runs", `task-${request.name}-${startedAt}-${Math.random().toString(36).slice(2, 8)}`);
	const outputDir = path.join(runDir, "output");
	await mkdir(outputDir, { recursive: true });
	const runtimeInput = await resolveRuntimeInput(ctx, loaded.skill, loaded.contract, request.input, true);
	let workerResult: TaskWorkerResult;
	let verifyResult: Awaited<ReturnType<typeof runVerify>>;
	try {
		workerResult = await dispatchWorker({
			skill: loaded.skill,
			contract: loaded.contract,
			runtimeInput,
			outputDir,
		}, {
			cwd: cwdOf(ctx),
			env: workerEnv,
			signal,
		});
		verifyResult = await runVerify({
			verifyPath: path.join(loaded.dir, "verify.mjs"),
			outputDir,
			input: runtimeInput,
		});
	} catch (error) {
		return {
			name: request.name,
			status: "fail",
			outputDir,
			artifacts: [],
			verifyFailures: [],
			workerSummary: `执行异常: ${error instanceof Error ? error.message : String(error)}`,
			duration: (Date.now() - startedAt) / 1000,
			attempts: 1,
		};
	}
	const duration = (Date.now() - startedAt) / 1000;
	const status = workerResult.ok && verifyResult.passed ? "pass" : "fail";
	await appendRunToTaskbook(loaded.scope, cwdOf(ctx), request.name, {
		timestamp: new Date().toISOString(),
		status,
		input: runtimeInput,
		exitCode: status === "pass" ? 0 : (verifyResult.exitCode ?? 1),
		verifyFailures: verifyResult.failures,
		duration,
	});
	return {
		name: request.name,
		status,
		outputDir,
		artifacts: await collectArtifactPaths(loaded.contract, outputDir),
		verifyFailures: verifyResult.failures,
		workerSummary: workerResult.ok ? workerResult.summary : (workerResult.errorMessage ?? "worker failed"),
		duration,
		attempts: 1,
	};
}

function parseRunTaskParams(params: any): { mode: "single" | "parallel"; tasks: SubtaskRequest[] } {
	const hasSingle = typeof params?.name === "string" || typeof params?.input === "string";
	const hasParallel = Array.isArray(params?.tasks);
	if (hasSingle === hasParallel) throw new Error("run_task 需要提供 {name,input} 或 {tasks:[...]},二选一。");
	if (hasSingle) {
		if (typeof params.name !== "string" || !params.name.trim() || typeof params.input !== "string") {
			throw new Error("single 模式需要 name 和 input。");
		}
		return { mode: "single", tasks: [{ name: params.name.trim(), input: params.input }] };
	}
	const tasks = params.tasks;
	if (tasks.length === 0 || tasks.length > SUBTASK_MAX) throw new Error(`parallel 模式 tasks 数量必须是 1-${SUBTASK_MAX}。`);
	return {
		mode: "parallel",
		tasks: tasks.map((task: any) => {
			if (typeof task?.name !== "string" || !task.name.trim() || typeof task?.input !== "string") {
				throw new Error("parallel 模式每项都需要 name 和 input。");
			}
			return { name: task.name.trim(), input: task.input };
		}),
	};
}

function formatSubtaskToolText(mode: "single" | "parallel", results: SubtaskResult[]): string {
	const passed = results.filter((result) => result.status === "pass").length;
	const header = mode === "parallel" ? `${passed}/${results.length} succeeded` : `run_task ${results[0]?.status.toUpperCase() ?? "FAIL"}`;
	return [
		header,
		...results.map((result) => [
			`- ${result.name}: ${result.status.toUpperCase()}`,
			`  outputDir: ${result.outputDir}`,
			result.artifacts.length > 0 ? `  artifacts: ${result.artifacts.join(", ")}` : "",
			result.verifyFailures.length > 0 ? `  verifyFailures: ${JSON.stringify(result.verifyFailures)}` : "",
			result.workerSummary ? `  workerSummary: ${result.workerSummary}` : "",
		].filter(Boolean).join("\n")),
	].join("\n");
}

async function handleTaskRun(
	ctx: any,
	name: string | undefined,
	rawInput: string,
	onFail?: (failure: TaskRunFailure) => void,
	activeTools: string[] = TASK_NORMAL_TOOLS,
): Promise<void> {
	if (activeTaskRun) {
		ctx.ui.notify(`taskbook "${activeTaskRun.taskbookName}" 正在运行。可用 /task stop 中断。`, "warning");
		return;
	}
	const finalName = await chooseTaskbookName(ctx, name);
	if (!finalName) return;
	const loaded = await loadTaskbook(cwdOf(ctx), finalName);
	if (!loaded) {
		ctx.ui.notify(`taskbook "${finalName}" 不存在`, "warning");
		return;
	}
	const finalRawInput = !name && !rawInput.trim()
		? await ctx.ui?.input?.("一句话输入", "")
		: rawInput;
	const workerEnv = await resolveTaskWorkerEnv(ctx, loaded, activeTools);
	if (workerEnv === null) {
		ctx.ui.notify("已取消: 本次 task 未获得受保护工具授权。", "warning");
		return;
	}

	const startedAt = Date.now();
	const runDir = path.join(cwdOf(ctx), ".tasks", "runs", `task-${finalName}-${startedAt}`);
	const outputDir = resolveRunOutputDir(loaded.contract, path.join(runDir, "output"));
	await mkdir(runDir, { recursive: true });
	await mkdir(outputDir, { recursive: true });
	const runtimeInput = await resolveRuntimeInput(ctx, loaded.skill, loaded.contract, finalRawInput ?? "");
	const maxRetry = 3;
	let lastVerifyResult: Awaited<ReturnType<typeof runVerify>> | undefined;
	let lastWorkerResult: TaskWorkerResult | undefined;
	let feedback: unknown;
	const abortController = new AbortController();
	const runState: ActiveTaskRun = { taskbookName: finalName, abortController, progress: [], notes: [] };
	activeTaskRun = runState;

	const runPromise = (async () => {
	try {
	for (let attempt = 0; attempt <= maxRetry; attempt += 1) {
		const widgetBase = (status: string) => [
			`⏳ taskbook "${finalName}" 运行中...`,
			`尝试 ${attempt + 1}/${maxRetry + 1}`,
			status,
		];
		setTaskRunWidget(ctx, widgetBase("worker 执行中..."));
		const workerResult = await dispatchWorker({
			skill: loaded.skill,
			contract: loaded.contract,
			runtimeInput,
			outputDir,
			feedback,
		}, {
			cwd: cwdOf(ctx),
			env: workerEnv,
			signal: abortController.signal,
			onUpdate: (text) => {
				const progress = formatProgressLines(text);
				if (progress.length > 0) {
					runState.progress.push(...progress);
					setTaskRunWidget(ctx, [...widgetBase("worker 执行中..."), "", "最近进展:", ...progress]);
				}
			},
		});
		lastWorkerResult = workerResult;

		if (!workerResult.ok) {
			if (abortController.signal.aborted) {
				const duration = (Date.now() - startedAt) / 1000;
				const report = await formatRunResult(loaded, outputDir, workerResult, lastVerifyResult, false, attempt + 1, duration, runState.progress, runState.notes);
				lastTaskRunReview = { taskbookName: finalName, content: buildTaskRunReviewContext(finalName, report) };
				ctx.ui.notify(`已停止 taskbook "${finalName}" 运行。下一步可用 /task 选择"复盘上次运行"。`, "info");
				return;
			}
			ctx.ui.notify(`worker 执行失败: ${workerResult.errorMessage}`, "error");
			break;
		}

		setTaskRunWidget(ctx, widgetBase("verify 执行中..."));
		lastVerifyResult = await runVerify({
			verifyPath: path.join(loaded.dir, "verify.mjs"),
			outputDir,
			input: runtimeInput,
		});

		if (lastVerifyResult.passed) {
			await appendRunToTaskbook(loaded.scope, cwdOf(ctx), finalName, {
				timestamp: new Date().toISOString(),
				status: "pass",
				input: runtimeInput,
				exitCode: 0,
				verifyFailures: [],
				duration: (Date.now() - startedAt) / 1000,
			});
			const duration = (Date.now() - startedAt) / 1000;
			const report = await formatRunResult(loaded, outputDir, workerResult, lastVerifyResult, true, attempt + 1, duration, runState.progress, runState.notes);
			lastTaskRunReview = { taskbookName: finalName, content: buildTaskRunReviewContext(finalName, report) };
			ctx.ui.notify(report, "info");
			return;
		}

		if (attempt === maxRetry) break;

		const checkerResult = await dispatchChecker({
			failures: lastVerifyResult.failures,
			contract: loaded.contract,
			outputDir,
			retryBudget: maxRetry - attempt - 1,
		}, { cwd: cwdOf(ctx) });

		if (checkerResult.verdict === "abort") {
			ctx.ui.notify(`checker 判 abort: ${checkerResult.reason}`, "warning");
			break;
		}
		feedback = checkerResult;
	}

	await appendRunToTaskbook(loaded.scope, cwdOf(ctx), finalName, {
		timestamp: new Date().toISOString(),
		status: "fail",
		input: runtimeInput,
		exitCode: lastVerifyResult?.exitCode ?? 1,
		verifyFailures: lastVerifyResult?.failures ?? [],
		duration: (Date.now() - startedAt) / 1000,
	});
	const duration = (Date.now() - startedAt) / 1000;
	const report = await formatRunResult(loaded, outputDir, lastWorkerResult, lastVerifyResult, false, maxRetry + 1, duration, runState.progress, runState.notes);
	lastTaskRunReview = { taskbookName: finalName, content: buildTaskRunReviewContext(finalName, report) };
	onFail?.({
		taskbookName: finalName,
		taskbookScope: loaded.scope,
		spec: loaded.spec,
		runDir,
		summary: await formatRepairSummary(loaded, outputDir, lastWorkerResult, lastVerifyResult),
	});
	ctx.ui.notify(`${report}\n\n下一步: 输入修改意见修正 taskbook,或用 /task 选择修正/重新运行/查看/放弃。`, "error");
	} catch (error) {
		ctx.ui.notify(`taskbook "${finalName}" 运行异常: ${error instanceof Error ? error.message : String(error)}`, "error");
	} finally {
		if (activeTaskRun === runState) activeTaskRun = undefined;
		setTaskRunWidget(ctx, undefined);
	}
	})();
	taskRunPromiseForTests = runPromise;
}

async function handleTaskDelete(ctx: any, name: string | undefined, tokens: string[]): Promise<void> {
	const finalName = await chooseTaskbookName(ctx, name);
	if (!finalName) return;
	const loaded = await loadTaskbook(cwdOf(ctx), finalName);
	if (!loaded) {
		ctx.ui.notify(`taskbook "${finalName}" 不存在`, "warning");
		return;
	}
	const scope = name ? scopeFromTokens(tokens) : loaded.scope;
	const ok = ctx.ui?.confirm
		? await ctx.ui.confirm("删除 taskbook", `删除 ${scope} taskbook "${finalName}"?`)
		: false;
	if (!ok) {
		ctx.ui.notify("已取消删除。", "info");
		return;
	}
	await deleteTaskbook(scope, cwdOf(ctx), finalName);
	ctx.ui.notify(`taskbook "${finalName}" 已删除。`, "info");
}

async function handleTaskRename(ctx: any, name: string | undefined, tokens: string[]): Promise<void> {
	const oldName = await chooseTaskbookName(ctx, name);
	if (!oldName) return;
	const loaded = await loadTaskbook(cwdOf(ctx), oldName);
	if (!loaded) {
		ctx.ui.notify(`taskbook "${oldName}" 不存在`, "warning");
		return;
	}
	const newName = tokens[2]?.trim() || await ctx.ui?.input?.(`重命名 "${oldName}" 为`, oldName);
	if (!newName?.trim() || newName.trim() === oldName) {
		ctx.ui.notify("已取消重命名。", "info");
		return;
	}
	try {
		await renameTaskbook(loaded.scope, cwdOf(ctx), oldName, newName.trim());
		ctx.ui.notify(`taskbook "${oldName}" 已重命名为 "${newName.trim()}"。`, "info");
	} catch (error) {
		ctx.ui.notify(`重命名失败: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

export function registerTask(pi: ExtensionAPI): void {
	let state = createTaskState();
	let restoreToolsSnapshot: string[] | undefined;
	let cachedTaskbookPrompt = "";

	function getActiveTaskTools(): string[] {
		return typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS;
	}

	function persistState(): void {
		pi.appendEntry(TASK_STATE_TYPE, state);
	}

	function setTaskStatus(ctx: any, label?: string): void {
		ctx.ui?.setStatus?.("task-mode", label);
	}

	function restoreActiveTools(): void {
		if (restoreToolsSnapshot && typeof pi.setActiveTools === "function") {
			pi.setActiveTools(restoreToolsSnapshot);
		}
		restoreToolsSnapshot = undefined;
	}

	let promptingTaskMenu = false;
	async function promptTaskMenu(ctx: any): Promise<void> {
		if (!ctx.hasUI || !ctx.ui?.select || promptingTaskMenu) return;
		promptingTaskMenu = true;
		try {
			const selection = await ctx.ui.select("Task", getTaskCommandMenuOptions(state));
			const action = selection ? MENU_TO_ACTION.get(selection) : undefined;
			if (action) await handleTaskCommand(action, ctx);
		} finally {
			promptingTaskMenu = false;
		}
	}

	function enableTask(ctx: any): void {
		restoreToolsSnapshot ??= typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS;
		state = enterPlanning(state);
		pi.setActiveTools?.(TASK_PLANNING_TOOLS);
		persistState();
		setTaskStatus(ctx, "📋 task");
		ctx.ui.notify("Task planning mode. 请用 questionnaire 对齐 one-step 任务和机器验收标准。", "info");
	}

	async function startTaskExecute(ctx: any): Promise<void> {
		if (!state.spec) {
			ctx.ui.notify("没有 Spec,先用 /task new 对齐。", "warning");
			return;
		}
		if (!state.planQuestionnaireUsed) {
			ctx.ui.notify("planning 阶段未用 questionnaire,拒绝执行。", "warning");
			pi.sendUserMessage?.("请先用 questionnaire 跟用户确认 Spec 假设,再重新输出 Spec。", { deliverAs: "followUp" });
			return;
		}
		const executeRunDir = path.join(cwdOf(ctx), ".tasks", "runs", `task-${state.taskbookName ?? "draft"}-${Date.now()}`);
		await mkdir(path.join(executeRunDir, "output"), { recursive: true });
		state = startExecuting(state, executeRunDir);
		restoreToolsSnapshot ??= typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS;
		// execute 阶段放开所有环境工具(含 chrome_cdp/mcp),只排除 subagent。
		// planning 阶段曾把工具窄化成只读集,先恢复进入 task 前的全集再减 subagent。
		if (restoreToolsSnapshot) pi.setActiveTools?.(restoreToolsSnapshot);
		applyExecuteTools(pi);
		persistState();
		setTaskStatus(ctx, "🔧 executing");
		pi.sendUserMessage?.([
			"现在请在同一个对话里亲手把任务做完。",
			"",
			"Spec:",
			formatRequirementsSpec(state.spec),
			"",
			`TASK_OUTPUT_DIR: ${path.join(executeRunDir, "output")}`,
			"",
			"要求:",
			"- 必须实际产出文件,不能只描述",
			"- 产出默认放到 TASK_OUTPUT_DIR",
			"- 不要调用 subagent 工具",
			"- 完成后调用 task_complete 工具",
		].join("\n"), { deliverAs: "followUp" });
	}

	async function prepareReviewFromExecute(ctx: any, completionSummary = ""): Promise<void> {
		if (state.phase !== "executing") return;
		state = setPendingTransition({ ...state, summary: formatExecuteSummary(state, completionSummary) }, "review");
		persistState();
		ctx.ui.notify(`execute 完成,产出在 ${state.executeRunDir ? path.join(state.executeRunDir, "output") : "(unknown)"}。请选择下一步,或输入意见。`, "info");
		await promptTaskMenu(ctx);
	}

	async function enterReviewFromPending(ctx: any): Promise<void> {
		if (state.phase !== "executing" || state.pendingTransition !== "review") return;
		state = enterReviewing(state, state.summary);
		pi.setActiveTools?.(TASK_PLANNING_TOOLS);
		persistState();
		setTaskStatus(ctx, "📋 reviewing");
		pi.sendUserMessage?.(buildTaskReviewPrompt(state.spec, state.summary), { deliverAs: "followUp" });
	}

	async function enterRepairFromPending(ctx: any, note = ""): Promise<void> {
		if (state.pendingTransition !== "repair" || !state.spec) return;
		const summary = note.trim()
			? `${state.summary}\n\n用户补充修正意见:\n${note.trim()}`
			: state.summary;
		state = enterReviewing({ ...state, summary }, summary);
		pi.setActiveTools?.(TASK_PLANNING_TOOLS);
		persistState();
		setTaskStatus(ctx, "📋 reviewing");
		pi.sendUserMessage?.(buildTaskReviewPrompt(state.spec, state.summary), { deliverAs: "followUp" });
	}

	async function saveCurrentTask(ctx: any, name: string | undefined, tokens: string[]): Promise<void> {
		if (!state.spec || !state.reviewResult) {
			ctx.ui.notify("没有 review 产出,先复盘。", "warning");
			return;
		}
		if (!state.reviewQuestionnaireUsed) {
			ctx.ui.notify("review 未用 questionnaire 核对,拒绝保存。", "warning");
			pi.sendUserMessage?.("review 阶段还没有用 questionnaire 核对 skill/verify/contract 设计。请先用 questionnaire 确认 worker 路径和 verify 设计,然后重新输出 taskbook JSON。", { deliverAs: "followUp" });
			return;
		}
		const finalName = name ?? state.taskbookName ?? await ctx.ui?.input?.("taskbook 名字", "my-task");
		if (!finalName?.trim()) {
			ctx.ui.notify("缺少 taskbook 名字。", "warning");
			return;
		}
		const scope = explicitScopeFromTokens(tokens) ?? state.taskbookScope ?? scopeFromTokens(tokens);
		const outputDir = state.executeRunDir ? path.join(state.executeRunDir, "output") : undefined;
		let runtimeInput = await resolveSelfCheckInput(ctx, state.reviewResult.contract);
		let positiveVerifyResult: Awaited<ReturnType<typeof runVerify>> | undefined;
		let blocked = false;
		await withTempVerify(cwdOf(ctx), state.reviewResult.verify, async (verifyPath, tempDir) => {
			const emptyOutputDir = path.join(tempDir, "empty-output");
			await mkdir(emptyOutputDir, { recursive: true });
			const runNegativeCheck = async (): Promise<boolean> => {
				const negativeResult = await runVerify({ verifyPath, outputDir: emptyOutputDir, input: runtimeInput });
				if (!negativeResult.passed && malformedVerifyFailureOutput(negativeResult)) {
					ctx.ui.notify(`verify 失败输出格式错误,拒绝保存。失败时 stdout 必须是 VerifyFailure[] JSON:\n${negativeResult.stdout.trim() || JSON.stringify(negativeResult.failures, null, 2)}`, "warning");
					pi.sendUserMessage?.(`verify 失败输出格式错误。请修正 verify.mjs: 失败时 stdout 必须只输出 VerifyFailure[] JSON 数组,不要输出 {"failures":[...]} 或普通文本。\n\n当前输出:\n${negativeResult.stdout.trim() || JSON.stringify(negativeResult.failures, null, 2)}`, { deliverAs: "followUp" });
					return false;
				}
				if (negativeResult.passed && artifactNames(state.reviewResult?.contract).length > 0) {
					ctx.ui.notify("verify 负例自检失败: 空 outputDir 也通过了,拒绝保存。", "warning");
					pi.sendUserMessage?.("verify 负例自检失败: 空 outputDir 也通过了。请修正 verify.mjs,必须检查 contract.artifacts 声明的产物真实存在,空目录应返回 VerifyFailure[] 并非 0 退出。", { deliverAs: "followUp" });
					return false;
				}
				return true;
			};
			if (!await runNegativeCheck()) {
				blocked = true;
				return;
			}
			if (!outputDir?.trim()) return;
			positiveVerifyResult = await runVerify({ verifyPath, outputDir, input: runtimeInput });
			if (!positiveVerifyResult.passed && runtimeFields(state.reviewResult?.contract).length > 0) {
				runtimeInput = await askSelfCheckInput(ctx, state.reviewResult?.contract);
				if (!await runNegativeCheck()) {
					blocked = true;
					return;
				}
				positiveVerifyResult = await runVerify({ verifyPath, outputDir, input: runtimeInput });
			}
		});
		if (blocked) return;
		if (!outputDir?.trim()) {
			if (state.taskbookName) {
				await saveTaskbook(scope, cwdOf(ctx), finalName.trim(), {
					description: state.reviewResult.description,
					spec: state.spec,
					skill: state.reviewResult.skill,
					verify: state.reviewResult.verify,
					contract: state.reviewResult.contract,
					tags: state.reviewResult.tags,
				});
				state = landTask(state);
				persistState();
				restoreActiveTools();
				setTaskStatus(ctx, undefined);
				ctx.ui.notify(`taskbook "${finalName.trim()}" 已更新。建议用 \`/task run ${finalName.trim()} <一句话>\` 重新验证。`, "info");
				return;
			}
			ctx.ui.notify("缺少首次成功产出的 outputDir,拒绝 landed。", "warning");
			return;
		}
		const verifyResult = positiveVerifyResult;
		if (!verifyResult.passed) {
			ctx.ui.notify(`verify 自证失败,未进入 landed:\n${JSON.stringify(verifyResult.failures, null, 2)}`, "warning");
			pi.sendUserMessage?.(`verify 自证失败。请根据失败断言修正 taskbook 的 skill、contract 或 verify,然后重新输出完整 taskbook JSON。\n\n失败断言:\n${JSON.stringify(verifyResult.failures, null, 2)}`, { deliverAs: "followUp" });
			return;
		}
		await saveTaskbook(scope, cwdOf(ctx), finalName.trim(), {
			description: state.reviewResult.description,
			spec: state.spec,
			skill: state.reviewResult.skill,
			verify: state.reviewResult.verify,
			contract: state.reviewResult.contract,
			tags: state.reviewResult.tags,
		});
		state = landTask(state);
		persistState();
		restoreActiveTools();
		setTaskStatus(ctx, undefined);
		ctx.ui.notify(`taskbook "${finalName.trim()}" 已就绪。以后用 \`/task run ${finalName.trim()} <一句话>\` 复用。`, "info");
	}

	pi.registerTool?.({
		name: "run_task",
		label: "Run Task",
		description: [
			"复用一个已存在、已通过机器验收的固定任务(taskbook)来执行一件确定性的工作。",
			"当任务明确匹配 system prompt 可用 task 清单中的某项时使用;需要探索或没有匹配 taskbook 时用 subagent。",
			"参数: single 模式提供 name 和 input; parallel 模式提供 tasks: [{name,input}]。",
			"返回每个 task 的 PASS/FAIL(机器验收)、产物路径和 outputDir。整体成败由你判断。",
		].join("\n"),
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "taskbook 名(single 模式)" })),
			input: Type.Optional(Type.String({ description: "一句人话输入(single 模式)" })),
			tasks: Type.Optional(Type.Array(Type.Object({
				name: Type.String({ description: "taskbook 名" }),
				input: Type.String({ description: "一句人话输入" }),
			}), { description: "parallel 模式任务数组" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const parsed = parseRunTaskParams(params);
				const loaded = await Promise.all(parsed.tasks.map((task) => loadSubtask(cwdOf(ctx), task.name)));
				const workerEnv = await resolveTaskWorkerEnv(ctx, loaded, getActiveTaskTools());
				if (workerEnv === null) throw new Error("run_task 需要受保护工具授权,但未获授权。");
				const results = await mapWithConcurrencyLimit(parsed.tasks, SUBTASK_CONCURRENCY, async (task, index) =>
					await executeSubtask(ctx, task, loaded[index], workerEnv, signal));
				return {
					content: [{ type: "text", text: formatSubtaskToolText(parsed.mode, results) }],
					details: { mode: parsed.mode, results },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: (error as Error).message }],
					details: { mode: "single", results: [] },
					isError: true,
				};
			}
		},
	});

	pi.registerTool?.(taskCompleteTool);

	async function handleTaskCommand(args: string, ctx: any): Promise<void> {
			const resolvedArgs = await resolveTaskCommandArgs(args, ctx, state, activeTaskRun !== undefined, lastTaskRunReview !== undefined);
			if (resolvedArgs === undefined) return;
			const { action, name, tokens, rawInput } = parseTaskCommand(resolvedArgs);
			if (action === "review-last-run" && lastTaskRunReview) {
				const userObservation = await ctx.ui?.input?.("你觉得刚刚的运行结果有什么问题吗?", "");
				setTaskRunWidget(ctx, [
					`📋 正在复盘 taskbook "${lastTaskRunReview.taskbookName}"...`,
					"reviewer 分析中,请稍候",
				]);
				try {
					const result = await dispatchTaskRunReviewer({
						runContext: lastTaskRunReview.content,
						userObservation: userObservation ?? "",
					}, { cwd: cwdOf(ctx) });
					ctx.ui.notify(result.summary, result.ok ? "info" : "warning");
				} finally {
					setTaskRunWidget(ctx, undefined);
				}
				return;
			}
			if (action === "stop" && activeTaskRun) {
				activeTaskRun.abortController.abort();
				ctx.ui.notify(`已请求停止 taskbook "${activeTaskRun.taskbookName}"。`, "info");
				return;
			}
			if (action === "run-status" && activeTaskRun) {
				ctx.ui.notify([
					`taskbook "${activeTaskRun.taskbookName}" 运行中。`,
					...(activeTaskRun.progress.length > 0 ? ["", "最近进展:", ...activeTaskRun.progress.map((line, index) => `${index + 1}. ${line}`)] : []),
					...(activeTaskRun.notes.length > 0 ? ["", "用户备注:", ...activeTaskRun.notes.map((line, index) => `${index + 1}. ${line}`)] : []),
				].join("\n"), "info");
				return;
			}

			if (action === "new" || action === "clarify") {
				enableTask(ctx);
				return;
			}
			if (action === "edit") {
				const finalName = await chooseTaskbookName(ctx, name);
				if (!finalName) return;
				const loaded = await loadTaskbook(cwdOf(ctx), finalName);
				if (!loaded) {
					ctx.ui.notify(`taskbook "${finalName}" 不存在`, "warning");
					return;
				}
				restoreToolsSnapshot ??= typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS;
				state = enterReviewing({
					...state,
					spec: loaded.spec,
					taskbookName: finalName,
					taskbookScope: loaded.scope,
				}, formatTaskbookUpdateSummary(loaded));
				pi.setActiveTools?.(TASK_PLANNING_TOOLS);
				persistState();
				setTaskStatus(ctx, "📋 reviewing");
				pi.sendUserMessage?.(buildTaskReviewPrompt(state.spec, state.summary), { deliverAs: "followUp" });
				return;
			}
			if (action === "execute") {
				await startTaskExecute(ctx);
				return;
			}
			if (action === "continue-review") {
				if (state.phase !== "executing") {
					ctx.ui.notify("只有 executing 阶段完成后才能进入 review。", "warning");
					return;
				}
				if (state.pendingTransition === "review") {
					await enterReviewFromPending(ctx);
					return;
				}
				const completionSummary = rawInput.trim()
					? rawInput
					: await ctx.ui?.input?.("确认执行结果(可留空)", "");
				await prepareReviewFromExecute(ctx, completionSummary ?? "");
				return;
			}
			if (action === "repair") {
				await enterRepairFromPending(ctx);
				return;
			}
			if (action === "save") {
				await saveCurrentTask(ctx, name, tokens);
				return;
			}
			if (action === "change-spec") {
				if (!state.spec) {
					ctx.ui.notify("没有当前 Spec,先用 /task new 对齐。", "warning");
					return;
				}
				const edited = await ctx.ui?.editor?.("修改当前 Spec", formatRequirementsSpec(state.spec));
				if (edited?.trim()) {
					state = enterPlanning(state);
					persistState();
					pi.sendUserMessage?.(`按以下修改后的需求继续 /task planning：\n\n${edited.trim()}`, { deliverAs: "followUp" });
				}
				return;
			}
			if (action === "list") return await handleTaskList(ctx, tokens);
			if (action === "show") return await handleTaskShow(ctx, name ?? (state.pendingTransition === "repair" ? state.taskbookName : undefined));
			if (action === "run" || action === "rerun") return await handleTaskRun(ctx, name ?? (action === "rerun" ? state.taskbookName : undefined), rawInput, (failure) => {
				state = setPendingTransition({
					...state,
					phase: "aborted",
					spec: failure.spec,
					taskbookName: failure.taskbookName,
					taskbookScope: failure.taskbookScope,
					summary: failure.summary,
					executeRunDir: failure.runDir,
					reviewResult: undefined,
					reviewQuestionnaireUsed: false,
				}, "repair");
				persistState();
				setTaskStatus(ctx, "📋 task");
			}, typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS);
			if (action === "delete") return await handleTaskDelete(ctx, name, tokens);
			if (action === "rename") return await handleTaskRename(ctx, name, tokens);
			if (action === "stop" || action === "exit" || action === "toggle" || action === "abort") {
				state = abortTask(state);
				persistState();
				setTaskStatus(ctx, undefined);
				restoreActiveTools();
				ctx.ui.notify("Task disabled.", "info");
				return;
			}
			ctx.ui.notify("Usage: /task list|show|new|run|edit|save|delete|toggle|exit", "warning");
	}

	pi.registerCommand("task", {
		description: "UGK task delegation system",
		handler: handleTaskCommand,
	});

	pi.on("session_start", async (_event, ctx) => {
		cachedTaskbookPrompt = await buildTaskbookPrompt(cwdOf(ctx));
		const entries = ctx.sessionManager?.getEntries?.() ?? [];
		for (const entry of [...entries].reverse()) {
			if (entry.customType !== TASK_STATE_TYPE) continue;
			const restored = restoreTaskState(entry.data);
			if (!restored) break;
			state = restored;
			if (isActivePhase(state.phase) || state.pendingTransition === "repair") {
				restoreToolsSnapshot ??= typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS;
				if (state.phase === "planning") pi.setActiveTools?.(TASK_PLANNING_TOOLS);
				if (state.phase === "executing") applyExecuteTools(pi);
				if (state.phase === "reviewing") pi.setActiveTools?.(TASK_PLANNING_TOOLS);
				setTaskStatus(ctx, state.phase === "executing" ? "🔧 executing" : "📋 task");
			}
			break;
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		setTaskStatus(ctx, undefined);
		restoreActiveTools();
	});

	pi.on("before_agent_start", async () => {
		const result: any = {};
		if (state.phase === "reviewing") {
			result.message = {
				customType: TASK_REVIEW_CONTEXT_TYPE,
				content: buildTaskReviewPrompt(state.spec, state.summary),
				display: false,
			};
		} else if (state.phase === "planning") {
			result.message = {
				customType: TASK_PLAN_CONTEXT_TYPE,
				content: TASK_ALIGN_PROMPT,
				display: false,
			};
		}
		if (cachedTaskbookPrompt) result.systemPrompt = cachedTaskbookPrompt;
		return Object.keys(result).length > 0 ? result : undefined;
	});

	pi.on("context", async (event) => {
		return { messages: filterTaskContextMessages(event.messages, state) };
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === "questionnaire") {
			if (state.phase === "planning") state = markPlanQuestionnaireUsed(state);
			if (state.phase === "reviewing") state = markReviewQuestionnaireUsed(state);
			persistState();
		}
		if (state.phase === "executing") {
			// spec 4.2 硬约束:task-creator 禁止派 subagent(必须亲手做)。
			// 工具集已放开环境工具,subagent 不再靠 setActiveTools 隐式排除,
			// 这里显式 block 作为双保险(仿 planning 的 bash block)。
			if (event.toolName === "subagent") {
				return {
					block: true,
					reason: "Task executing 阶段禁止调用 subagent(task-creator 必须亲手做)。",
				};
			}
			if (event.toolName === "run_task") {
				return {
					block: true,
					reason: "Task executing 阶段禁止调用 run_task(task 不可嵌套)。",
				};
			}
			state = recordExecuteProcessEntry(state, {
				kind: "tool_call",
				toolName: event.toolName,
				argsSummary: summarizeToolArgs(event.input),
				timestamp: new Date().toISOString(),
			});
			for (const artifact of extractArtifactsFromToolInput(event.toolName, event.input)) {
				state = recordExecuteProcessEntry(state, {
					kind: "artifact",
					artifactPath: artifact.path,
					timestamp: new Date().toISOString(),
				});
			}
			persistState();
			return undefined;
		}
		if (state.phase !== "planning" || event.toolName !== "bash") return undefined;
		const command = event.input.command as string;
		if (isSafeCommand(command)) return undefined;
		return {
			block: true,
			reason: `Task planning: command blocked (not read-only). Command: ${command}`,
		};
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (state.phase !== "executing" || event.toolName !== "task_complete" || event.isError) return;
		await prepareReviewFromExecute(ctx, taskCompleteSummaryFromEvent(event));
	});

	pi.on("input", async (event, ctx) => {
		const text = typeof event.text === "string" ? event.text.trim() : "";
		if (event.source !== "interactive" && event.source !== "rpc") return;
		if (activeTaskRun && text) {
			if (text === "/task" || text.startsWith("/task ")) {
				await handleTaskCommand(text.slice("/task".length).trim(), ctx);
				return { handled: true };
			}
			if (text.startsWith("/")) return undefined;
			activeTaskRun.notes.push(text);
			ctx.ui.notify(`已记录本次运行备注。需要中断请用 /task stop。`, "info");
			return { handled: true };
		}
		if (!state.pendingTransition) return;
		if (state.pendingTransition === "repair") {
			await enterRepairFromPending(ctx, text);
			return { handled: true };
		}
		if (text) {
			state = setPendingTransition(state, undefined);
			persistState();
			pi.sendUserMessage?.(`用户对当前 /task 阶段的补充或修改意见:\n\n${text}`, { deliverAs: "followUp" });
			return { handled: true };
		}
		if (state.pendingTransition === "execute") {
			await startTaskExecute(ctx);
			return { handled: true };
		}
		if (state.pendingTransition === "review") {
			await enterReviewFromPending(ctx);
			return { handled: true };
		}
		if (state.pendingTransition === "save") {
			await saveCurrentTask(ctx, undefined, []);
			return { handled: true };
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (state.phase !== "planning" && state.phase !== "reviewing") return;
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (!lastAssistant) return;
		if (state.phase === "reviewing") {
			const result = extractTaskReviewResult(getTextContent(lastAssistant));
			if (!result) {
				ctx.ui.notify("Task review did not find skill/verify/contract JSON yet.", "warning");
				pi.sendUserMessage?.("你刚才的 taskbook 结果没有被 /task 解析成合法 JSON。请重新输出一个合法 JSON 对象,包含 description、skill、verify、contract；不要输出 markdown 代码块或改动摘要；skill/verify 里的换行必须作为 JSON 字符串内容正确转义。", { deliverAs: "followUp" });
				return;
			}
			state = setTaskReviewResult(state, result);
			state = setPendingTransition(state, "save");
			persistState();
			ctx.ui.notify("复盘完成。请选择下一步,或输入修改意见。", "info");
			await promptTaskMenu(ctx);
			return;
		}
		const spec = extractRequirementsSpec(getTextContent(lastAssistant));
		if (!spec) {
			ctx.ui.notify("Task planning did not find a complete RequirementsSpec yet.", "warning");
			pi.sendUserMessage?.("你刚才没有输出可解析的 RequirementsSpec JSON。请先用 questionnaire 核对用户假设,然后重新输出完整 RequirementsSpec JSON,包含 goal、hardConstraints、acceptance。", { deliverAs: "followUp" });
			return;
		}
		state = setPendingTransition(setTaskSpec(state, spec), "execute");
		persistState();
		ctx.ui.notify("Spec 已对齐。请选择下一步,或输入修改意见。", "info");
		await promptTaskMenu(ctx);
		return undefined;
	});
}

export default registerTask;
