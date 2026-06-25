import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	extractArtifactsFromToolInput,
	isPlanningAllowedCommand,
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
import { appendRunToTaskbook, assertValidContract, deleteTaskbook, listTaskbooks, loadTaskbook, renameTaskbook, saveTaskbook, type LoadedTaskbook } from "./task-book.ts";
import { dispatchChecker } from "./task-checker.ts";
import { resolveRuntimeInputFromText } from "./task-dispatcher.ts";
import { buildTaskReviewPrompt, extractTaskReviewResult, TASK_ALIGN_PROMPT } from "./task-prompts.ts";
import { buildTaskbookPrompt } from "./task-registry.ts";
import { dispatchTaskGuide } from "./task-guide.ts";
import { dispatchTaskRunReviewer } from "./task-run-reviewer.ts";
import { runVerify, type VerifyFailure } from "./task-verify.ts";
import { dispatchWorker, type TaskWorkerResult } from "./task-worker.ts";
import { mapWithConcurrencyLimit } from "../subagent-runtime.ts";

const TASK_STATE_TYPE = "task-state";
const TASK_PLAN_CONTEXT_TYPE = "task-plan-context";
const TASK_REVIEW_CONTEXT_TYPE = "task-review-context";
const TASK_REVIEW_PROMPT_TYPE = "task-review-prompt";
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
	phases?: Record<string, number>; // ponytail: 诊断用,各阶段耗时(ms)
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

type TaskProgressDetails = {
	taskbookName: string;
	status: "PASS" | "FAIL";
	lines: string[];
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
	return ["新建任务", "运行 taskbook(复用)", "查看 taskbook 详情", "编辑 taskbook", "重命名 taskbook", "删除 taskbook", "Exit"];
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

function isCancelledAssistantText(text: string): boolean {
	return /\bOperation aborted\b|User cancelled the questionnaire/i.test(text);
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

type TaskGuideItem = {
	id: number;
	title: string;
	detail: string;
};

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function summarizeContractArtifacts(contract: unknown): string {
	const artifacts = asRecord(contract).artifacts;
	if (!Array.isArray(artifacts) || artifacts.length === 0) return "未声明固定产物";
	return artifacts.map((item) => {
		if (typeof item === "string") return item;
		const record = asRecord(item);
		return [record.path, record.description].filter((part) => typeof part === "string" && part).join(" - ");
	}).filter(Boolean).join("; ") || "未声明固定产物";
}

function summarizeRuntimeInput(contract: unknown): string {
	const runtimeInput = asRecord(contract).runtimeInput;
	return Array.isArray(runtimeInput) && runtimeInput.length > 0
		? runtimeInput.filter((item) => typeof item === "string").join(", ")
		: "无额外输入字段";
}

function summarizeRequiredTools(contract: unknown): string {
	const requiredTools = asRecord(contract).requiredTools;
	return Array.isArray(requiredTools) && requiredTools.length > 0
		? requiredTools.filter((item) => typeof item === "string").join(", ")
		: "未声明受保护工具";
}

function buildTaskGuideItems(loaded: LoadedTaskbook): TaskGuideItem[] {
	const contract = loaded.contract;
	return [
		{ id: 1, title: "任务目标", detail: loaded.spec.goal },
		{ id: 2, title: "硬约束", detail: loaded.spec.hardConstraints.join("; ") || "无" },
		{ id: 3, title: "验收标准", detail: loaded.spec.acceptance.join("; ") || "无" },
		{ id: 4, title: "Worker 执行指引", detail: loaded.skill.trim().split(/\r?\n/).slice(0, 8).join(" ").replace(/\s+/g, " ").trim() || "空 skill" },
		{ id: 5, title: "产物契约", detail: summarizeContractArtifacts(contract) },
		{ id: 6, title: "运行输入", detail: summarizeRuntimeInput(contract) },
		{ id: 7, title: "工具要求", detail: summarizeRequiredTools(contract) },
		{ id: 8, title: "机器验证", detail: loaded.verify.trim().split(/\r?\n/).slice(0, 6).join(" ").replace(/\s+/g, " ").trim() || "空 verify" },
	];
}

function formatTaskGuide(loaded: LoadedTaskbook, items: TaskGuideItem[]): string {
	return [
		`# task 导览: ${loaded.taskbook.name} [${loaded.scope}]`,
		loaded.taskbook.description,
		"",
		...items.map((item) => `${item.id}. ${item.title}: ${item.detail}`),
	].join("\n");
}

async function buildTaskGuideText(ctx: any, loaded: LoadedTaskbook, items: TaskGuideItem[]): Promise<string> {
	try {
		const guide = await dispatchTaskGuide(loaded, { cwd: cwdOf(ctx) });
		return [
			`# task 导览: ${loaded.taskbook.name} [${loaded.scope}]`,
			loaded.taskbook.description,
			"",
			guide,
		].join("\n");
	} catch (error) {
		ctx.ui.notify(`task 导览 agent 失败,使用本地摘要: ${error instanceof Error ? error.message : String(error)}`, "warning");
		return formatTaskGuide(loaded, items);
	}
}

function formatTaskbookRawDetails(loaded: LoadedTaskbook): string {
	return [
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
	].join("\n");
}

function buildGuideEditRequest(input: string, items: TaskGuideItem[]): string {
	const match = input.trim().match(/^(\d+)\s*(.*)$/);
	if (!match) return input.trim();
	const id = Number(match[1]);
	const item = items.find((candidate) => candidate.id === id);
	if (!item) return input.trim();
	const note = match[2]?.trim();
	return [
		`用户选择导览项 ${item.id}: ${item.title}`,
		`当前内容: ${item.detail}`,
		note ? `修改意见: ${note}` : "修改意见: 请围绕该导览项做最小必要调整",
	].join("\n");
}

async function handleTaskShow(ctx: any, name: string | undefined, onEdit: (loaded: LoadedTaskbook, request?: string) => Promise<void>): Promise<void> {
	const finalName = await chooseTaskbookName(ctx, name);
	if (!finalName) return;
	const loaded = await loadTaskbook(cwdOf(ctx), finalName);
	if (!loaded) {
		ctx.ui.notify(`taskbook "${finalName}" 不存在`, "warning");
		return;
	}
	if (!ctx.ui?.select) {
		ctx.ui.notify(formatTaskbookRawDetails(loaded), "info");
		return;
	}
	const action = await ctx.ui.select(`taskbook: ${loaded.taskbook.name}`, ["task 导览", "task 编辑", "Exit"]);
	if (!action || action === "Exit") return;
	if (action === "task 编辑") {
		await onEdit(loaded);
		return;
	}
	if (action !== "task 导览") return;
	const items = buildTaskGuideItems(loaded);
	ctx.ui.notify(await buildTaskGuideText(ctx, loaded, items), "info");
	const next = await ctx.ui.select("task 导览", ["了解返回", "编辑"]);
	if (next !== "编辑") return;
	const request = await ctx.ui?.input?.("输入要编辑的编号和修改意见", "");
	if (request === undefined || !request.trim()) return;
	await onEdit(loaded, buildGuideEditRequest(request, items));
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

function runtimeDefault(contract: unknown, field: string): string | undefined {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) return undefined;
	const meta = (contract as Record<string, unknown>).runtimeInputMeta;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
	const fieldMeta = (meta as Record<string, unknown>)[field];
	if (!fieldMeta || typeof fieldMeta !== "object" || Array.isArray(fieldMeta) || !("default" in fieldMeta)) return undefined;
	return String((fieldMeta as Record<string, unknown>).default);
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
		...(protectedTools.chromeCdp && process.env.UGK_CDP_PORT ? { UGK_CDP_PORT: process.env.UGK_CDP_PORT } : {}),
		...(protectedTools.mcpTools.length > 0 ? { UGK_TASK_ALLOW_MCP_TOOLS: protectedTools.mcpTools.join(",") } : {}),
	};
}

async function resolveRuntimeInput(ctx: any, skill: string, contract: unknown, rawInput: string, headless = false): Promise<unknown> {
	return await resolveRuntimeInputFromText(ctx, skill, contract, rawInput, taskbookModel(contract, "dispatcherModel"), headless);
}

async function resolveSelfCheckInput(ctx: any, contract: unknown): Promise<unknown> {
	const fields = runtimeFields(contract);
	if (fields.length === 0) return {};
	return Object.fromEntries(fields.map((field) => [field, runtimeDefault(contract, field) ?? ""]));
}

async function askSelfCheckInput(ctx: any, contract: unknown): Promise<unknown> {
	const fields = runtimeFields(contract);
	if (fields.length === 0) return {};
	const entries: Array<[string, string]> = [];
	for (const field of fields) {
		const defaultValue = runtimeDefault(contract, field) ?? field;
		const suffix = runtimeDefault(contract, field) === undefined ? "" : ` (default: ${defaultValue})`;
		const value = await ctx.ui?.input?.(`verify 自证示例输入: ${field}${suffix}`, defaultValue);
		entries.push([field, value ?? defaultValue]);
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
	phases?: Record<string, number>,
): Promise<string> {
	const phaseLines = formatPhaseBreakdown(phases);
	if (passed) {
		return [
			"## 任务结果",
			`✅ taskbook "${loaded.taskbook.name}" PASS`,
			`任务: ${loaded.taskbook.description}`,
			`尝试: ${attempts} 次`,
			`耗时: ${durationSeconds.toFixed(1)}s`,
			...phaseLines,
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
		...phaseLines,
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

// ponytail: 纯诊断展示。把 phases(ms)转成可读分段,回答"到底慢在哪"。
// 两层:task 层(worker 整体/verify)给总览;worker 子进程内部细分(冷启动/LLM决策/工具执行)
// 回答"是 agent 启动慢、还是启动后开始工作慢"——这正是优化的决策依据。
export function formatPhaseBreakdown(phases?: Record<string, number>): string[] {
	if (!phases) return [];
	const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
	const lines = ["", "耗时分解:"];
	if (phases.workerFirstOutputMs !== undefined) lines.push(`  worker 启动+首轮: ${s(phases.workerFirstOutputMs)}`);
	if (phases.workerMs !== undefined) lines.push(`  worker 整体: ${s(phases.workerMs)}`);
	// worker 子进程内部细分(最后一次 worker):coldStart=Node+pi 冷启动;llmDecision=模型决定怎么干;tool=写脚本/连CDP/抓取/sleep
	if (phases["worker.coldStartMs"] !== undefined) lines.push(`    ├ 冷启动(Node+pi): ${s(phases["worker.coldStartMs"])}`);
	if (phases["worker.llmDecisionMs"] !== undefined) lines.push(`    ├ LLM 决策: ${s(phases["worker.llmDecisionMs"])}`);
	if (phases["worker.toolMs"] !== undefined) lines.push(`    └ 工具执行(CDP/脚本): ${s(phases["worker.toolMs"])}`);
	if (phases.verifyMs !== undefined) lines.push(`  verify: ${s(phases.verifyMs)}`);
	return lines;
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
		...(looksLikeMissingArtifact(failures)
			? ["", "⚠️ 这次失败像是「文件不存在」。先别急着放宽 verify 或改执行方法,优先核对三处产物名是否一致:contract.artifacts[].name、skill.md 里写出的文件名、verify.mjs 里 stat/读取的路径。最常见的死循环就是三者名字写岔了。"]
			: []),
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

// ponytail: 文件不存在是产物名漂移的典型症状(三处名字写岔)。命中就给 reviewer
// 一条定向提示,别让它围着「文件不存在」症状改、回到「统一产物名」根因。
// 只匹配明确的不存在信号,不确定时不误报(宁可漏报让 reviewer 自己判断)。
export function looksLikeMissingArtifact(failures: { assertion: string; actual: string }[]): boolean {
	if (failures.length === 0) return false;
	const re = /ENOENT|not\s+found|找不到|不存在|no\s+such\s+file/i;
	return failures.some((f) => re.test(`${f.assertion} ${f.actual}`));
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

function sendTaskMessage(pi: ExtensionAPI, ctx: any, content: string, fallbackLevel: "info" | "warning" | "error" = "info"): void {
	if (typeof (pi as any).sendMessage === "function") {
		(pi as any).sendMessage({ customType: "task-message", content, display: true }, { triggerTurn: false });
		return;
	}
	ctx.ui.notify(content, fallbackLevel);
}

function sendTaskProgressMessage(pi: ExtensionAPI, details: TaskProgressDetails): void {
	if (details.lines.length === 0 || typeof (pi as any).sendMessage !== "function") return;
	(pi as any).sendMessage({
		customType: "task-progress",
		content: `taskbook "${details.taskbookName}" ${details.status} process (${details.lines.length} updates)`,
		display: true,
		details,
	}, { triggerTurn: false });
}

function renderTaskProgressMessage(message: any, { expanded }: { expanded: boolean }, theme: any): Text {
	const details = message.details as TaskProgressDetails | undefined;
	const lines = details?.lines ?? [];
	const visible = expanded ? lines : lines.slice(-5);
	const title = `▸ taskbook "${details?.taskbookName ?? "unknown"}" 运行过程: ${details?.status ?? "DONE"} (${lines.length} 条)`;
	const body = visible.map((line, index) => `${index + 1}. ${line}`).join("\n");
	const hint = !expanded && lines.length > visible.length ? `\n${theme.fg("muted", "(Ctrl+O to expand)")}` : "";
	return new Text([theme.fg("toolTitle", theme.bold(title)), body, hint].filter(Boolean).join("\n"), 0, 0);
}

function sendTaskReviewPromptMessage(pi: ExtensionAPI, content: string, details: Record<string, unknown> = {}): void {
	if (typeof (pi as any).sendMessage !== "function") return;
	(pi as any).sendMessage({
		customType: TASK_REVIEW_PROMPT_TYPE,
		content,
		display: true,
		details,
	}, { triggerTurn: true, deliverAs: "followUp" });
}

function renderTaskReviewPromptMessage(message: any, { expanded }: { expanded: boolean }, theme: any): Text {
	const content = typeof message.content === "string" ? message.content : "";
	const lineCount = content ? content.split(/\r?\n/).length : 0;
	const title = `▸ [TASK REVIEW MODE] 已注入复盘指令 (${lineCount} 行)`;
	if (!expanded) {
		return new Text(theme.fg("toolTitle", theme.bold(`${title}  ${theme.fg("muted", "(Ctrl+O to expand)")}`)), 0, 0);
	}
	return new Text([theme.fg("toolTitle", theme.bold(title)), content].join("\n"), 0, 0);
}

function formatProgressLines(text: string): string[] {
	if (text.trim() === "(running...)") return [];
	return text
		.split(/\r?\n/)
		.map((line) => line.replace(/^#{1,6}\s*/, "").replace(/^[-*]\s*/, "").trim())
		.filter(Boolean)
		.slice(-5)
		.map((line) => line.length > 120 ? `${line.slice(0, 117)}...` : line);
}

function appendUniqueProgressLines(existing: string[], incoming: string[]): string[] {
	const seen = new Set(existing);
	const added: string[] = [];
	for (const line of incoming) {
		if (seen.has(line)) continue;
		seen.add(line);
		added.push(line);
	}
	existing.push(...added);
	return added;
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

// ponytail: 单源重试内核 — executeSubtask(run_task 工具)和 handleTaskRun(/task run 交互式)共用。
// 抽出来的纯逻辑:worker→verify→checker→feedback 循环。UI 耦合(widget/progress/notes/通知)留在调用方,
// 通过 onWorkerStart / onUpdate 回调按需注入,默认不传即纯函数式。两条路径行为由此保证一致。
interface TaskRetryOutcome {
	workerResult: TaskWorkerResult;
	verifyResult: Awaited<ReturnType<typeof runVerify>>;
	attempts: number; // 实际 worker 尝试次数 (1..maxRetry+1)
	aborted: boolean; // worker 被中断(worker.ok===false 且 signal.aborted),区别于普通失败
	checkerAborted?: boolean; // checker 主动判 abort 提前终止
	phases?: Record<string, number>; // ponytail: 纯诊断,各阶段累计耗时(ms)
}

async function runTaskWithRetry(
	loaded: LoadedTaskbook,
	runtimeInput: unknown,
	outputDir: string,
	cwd: string,
	opts: {
		env: Record<string, string | undefined>;
		signal?: AbortSignal;
		maxRetry?: number;
		onWorkerStart?: (attempt: number, feedback: unknown) => void;
		onWorkerUpdate?: (text: string) => void;
		onVerifyStart?: (attempt: number) => void;
	},
): Promise<TaskRetryOutcome> {
	const maxRetry = opts.maxRetry ?? 3;
	const verifyPath = path.join(loaded.dir, "verify.mjs");
	let feedback: unknown;
	let workerResult: TaskWorkerResult | undefined;
	let verifyResult: Awaited<ReturnType<typeof runVerify>> | undefined;
	let attempts = 0;
	let checkerAborted = false;
	// ponytail: aborted 收窄为"worker 被中断"——worker.ok===false 且 signal 已 aborted。
	// 不用 Boolean(signal.aborted):那样 verify/checker 期间被 abort 也会算 aborted,
	// 而 worker 那轮其实成功了,会被 handleTaskRun 误判进 abort 分支或漏判 FAIL。
	let workerAborted = false;
	// ponytail: 纯诊断计时。workerFirstOutput = 从 runTaskWithRetry 进入到 worker 子进程
	// 首次产出(子进程启动 + 首轮 LLM 的延迟);workerMs/verifyMs = 各阶段累计。不改执行逻辑。
	const runStartMs = Date.now();
	let workerFirstOutputMs: number | undefined;
	let workerMs = 0;
	let verifyMs = 0;
	const wrappedOnWorkerUpdate = opts.onWorkerUpdate
		? (text: string) => {
			if (workerFirstOutputMs === undefined) workerFirstOutputMs = Date.now() - runStartMs;
			opts.onWorkerUpdate!(text);
		}
		: undefined;
	for (let attempt = 0; attempt <= maxRetry; attempt += 1) {
		opts.onWorkerStart?.(attempt + 1, feedback);
		attempts = attempt + 1;
		const workerStartMs = Date.now();
		workerResult = await dispatchWorker({
			skill: loaded.skill,
			contract: loaded.contract,
			runtimeInput,
			outputDir,
			feedback,
		}, {
			cwd,
			env: opts.env,
			signal: opts.signal,
			onUpdate: wrappedOnWorkerUpdate,
		});
		workerMs += Date.now() - workerStartMs;

		// worker 失败不重试(与 /task run 一致)。worker 被中断专门标记,区别于普通失败。
		if (!workerResult.ok) {
			if (opts.signal?.aborted) workerAborted = true;
			break;
		}

		opts.onVerifyStart?.(attempt + 1);
		const verifyStartMs = Date.now();
		verifyResult = await runVerify({ verifyPath, outputDir, input: runtimeInput });
		verifyMs += Date.now() - verifyStartMs;
		if (verifyResult.passed) break;

		// 最后一次或被中断:不再调 checker
		if (attempt === maxRetry || opts.signal?.aborted) break;

		const checkerResult = await dispatchChecker({
			failures: verifyResult.failures,
			contract: loaded.contract,
			outputDir,
			retryBudget: maxRetry - attempt - 1,
		}, { cwd, signal: opts.signal });
		if (checkerResult.verdict === "abort") {
			checkerAborted = true;
			break;
		}
		feedback = checkerResult;
	}
	// ponytail: worker 失败(含 abort)时根本没跑 verify,verifyResult 仍是 undefined。
	// 合成一个"未验证"结果(passed:false, exitCode:null, 无 failures)让 outcome 字段恒有值,
	// 调用方不必散落 null-guard。exitCode:null 语义即"未运行 verify"。
	if (!verifyResult) {
		verifyResult = { passed: false, failures: [], stdout: "", stderr: "", exitCode: null, durationMs: 0 };
	}
	const phases: Record<string, number> = { workerMs, verifyMs };
	if (workerFirstOutputMs !== undefined) phases.workerFirstOutputMs = workerFirstOutputMs;
	// ponytail: 合并 worker 子进程内部细分(最后一次 worker 的)。带前缀,与 task 层 workerMs 区分。
	// 诊断用:回答"worker 里是冷启动慢、LLM 决策慢、还是工具执行(CDP)慢"。
	for (const [key, value] of Object.entries(workerResult?.phases ?? {})) {
		phases[`worker.${key}`] = value;
	}
	return { workerResult: workerResult!, verifyResult, attempts, aborted: workerAborted, checkerAborted, phases };
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
	let outcome: TaskRetryOutcome;
	try {
		outcome = await runTaskWithRetry(loaded, runtimeInput, outputDir, cwdOf(ctx), { env: workerEnv, signal });
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
	const status = outcome.workerResult.ok && outcome.verifyResult.passed ? "pass" : "fail";
	await appendRunToTaskbook(loaded.scope, cwdOf(ctx), request.name, {
		timestamp: new Date().toISOString(),
		status,
		input: runtimeInput,
		exitCode: status === "pass" ? 0 : (outcome.verifyResult.exitCode ?? 1),
		verifyFailures: outcome.verifyResult.failures,
		duration,
		phases: outcome.phases,
	});
	return {
		name: request.name,
		status,
		outputDir,
		artifacts: await collectArtifactPaths(loaded.contract, outputDir),
		verifyFailures: outcome.verifyResult.failures,
		workerSummary: outcome.workerResult.ok ? outcome.workerResult.summary : (outcome.workerResult.errorMessage ?? "worker failed"),
		duration,
		attempts: outcome.attempts,
		phases: outcome.phases,
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
		// workerSummary 不进 LLM context —— 它可能很长(产物摘要表格等),白占 token
		// 还会触发主 agent 进入后续总结轮(那轮若 provider 卡住,Esc 也救不回来)。
		// 完整 workerSummary 仍在 details.results[].workerSummary,UI/调试照常可取。
		...results.map((result) => [
			`- ${result.name}: ${result.status.toUpperCase()}`,
			`  outputDir: ${result.outputDir}`,
			result.artifacts.length > 0 ? `  artifacts: ${result.artifacts.join(", ")}` : "",
			result.verifyFailures.length > 0 ? `  verifyFailures: ${JSON.stringify(result.verifyFailures)}` : "",
		].filter(Boolean).join("\n")),
	].join("\n");
}

async function handleTaskRun(
	pi: ExtensionAPI,
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
	const abortController = new AbortController();
	const runState: ActiveTaskRun = { taskbookName: finalName, abortController, progress: [], notes: [] };
	activeTaskRun = runState;

	const runPromise = (async () => {
	try {
		let currentAttempt = 1;
		const outcome = await runTaskWithRetry(loaded, runtimeInput, outputDir, cwdOf(ctx), {
			env: workerEnv,
			signal: abortController.signal,
			maxRetry,
			onWorkerStart: (attempt) => {
				currentAttempt = attempt;
				setTaskRunWidget(ctx, [
					`⏳ taskbook "${finalName}" 运行中...`,
					`尝试 ${attempt}/${maxRetry + 1}`,
					"worker 执行中...",
				]);
			},
			onWorkerUpdate: (text) => {
				const progress = formatProgressLines(text);
				const added = appendUniqueProgressLines(runState.progress, progress);
				if (added.length > 0) {
					setTaskRunWidget(ctx, [
						`⏳ taskbook "${finalName}" 运行中...`,
						`尝试 ${currentAttempt}/${maxRetry + 1}`,
						"worker 执行中...",
						"",
						"最近进展:",
						...runState.progress.slice(-5).map((line, index) => `${index + 1}. ${line}`),
					]);
				}
			},
			onVerifyStart: (attempt) => {
				setTaskRunWidget(ctx, [
					`⏳ taskbook "${finalName}" 运行中...`,
					`尝试 ${attempt}/${maxRetry + 1}`,
					"verify 执行中...",
				]);
			},
		});
		const { workerResult, verifyResult, attempts } = outcome;
		const duration = (Date.now() - startedAt) / 1000;
		const passed = workerResult.ok && verifyResult.passed;

		// abort:用户主动 /task stop 中断,不算失败,不发 onFail
		if (!workerResult.ok && outcome.aborted) {
			const report = await formatRunResult(loaded, outputDir, workerResult, verifyResult, false, attempts, duration, runState.progress, runState.notes, outcome.phases);
			lastTaskRunReview = { taskbookName: finalName, content: buildTaskRunReviewContext(finalName, report) };
			ctx.ui.notify(`已停止 taskbook "${finalName}" 运行。下一步可用 /task 选择"复盘上次运行"。`, "info");
			return;
		}

		if (passed) {
			await appendRunToTaskbook(loaded.scope, cwdOf(ctx), finalName, {
				timestamp: new Date().toISOString(),
				status: "pass",
				input: runtimeInput,
				exitCode: 0,
				verifyFailures: [],
				duration,
				phases: outcome.phases,
			});
			const report = await formatRunResult(loaded, outputDir, workerResult, verifyResult, true, attempts, duration, runState.progress, runState.notes, outcome.phases);
			lastTaskRunReview = { taskbookName: finalName, content: buildTaskRunReviewContext(finalName, report) };
			sendTaskProgressMessage(pi, { taskbookName: finalName, status: "PASS", lines: runState.progress });
			sendTaskMessage(pi, ctx, report, "info");
			return;
		}

		// FAIL: worker 失败 / verify 一直没过 / checker 主动 abort
		if (!workerResult.ok) {
			ctx.ui.notify(`worker 执行失败: ${workerResult.errorMessage}`, "error");
		} else if (outcome.checkerAborted) {
			ctx.ui.notify("checker 判 abort,提前终止。", "warning");
		}
		await appendRunToTaskbook(loaded.scope, cwdOf(ctx), finalName, {
			timestamp: new Date().toISOString(),
			status: "fail",
			input: runtimeInput,
			exitCode: verifyResult.exitCode ?? 1,
			verifyFailures: verifyResult.failures,
			duration,
			phases: outcome.phases,
		});
		const report = await formatRunResult(loaded, outputDir, workerResult, verifyResult, false, attempts, duration, runState.progress, runState.notes, outcome.phases);
		lastTaskRunReview = { taskbookName: finalName, content: buildTaskRunReviewContext(finalName, report) };
		sendTaskProgressMessage(pi, { taskbookName: finalName, status: "FAIL", lines: runState.progress });
		onFail?.({
			taskbookName: finalName,
			taskbookScope: loaded.scope,
			spec: loaded.spec,
			runDir,
			summary: await formatRepairSummary(loaded, outputDir, workerResult, verifyResult),
		});
		sendTaskMessage(pi, ctx, `${report}\n\n下一步: 输入修改意见修正 taskbook,或用 /task 选择修正/重新运行/查看/放弃。`, "error");
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
	(pi as any).registerMessageRenderer?.("task-progress", renderTaskProgressMessage);
	(pi as any).registerMessageRenderer?.(TASK_REVIEW_PROMPT_TYPE, renderTaskReviewPromptMessage);
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

	async function startTaskbookEdit(ctx: any, loaded: LoadedTaskbook, userEditRequest = ""): Promise<void> {
		restoreToolsSnapshot ??= typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS;
		state = enterReviewing({
			...state,
			spec: loaded.spec,
			taskbookName: loaded.taskbook.name,
			taskbookScope: loaded.scope,
		}, formatTaskbookUpdateSummary(loaded));
		pi.setActiveTools?.(TASK_PLANNING_TOOLS);
		persistState();
		setTaskStatus(ctx, "📋 reviewing");
		sendTaskReviewPromptMessage(
			pi,
			buildTaskReviewPrompt(state.spec, state.summary, userEditRequest),
			userEditRequest.trim() ? { mode: "edit", userEditRequest } : {},
		);
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
		sendTaskReviewPromptMessage(pi, buildTaskReviewPrompt(state.spec, state.summary));
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
		sendTaskReviewPromptMessage(pi, buildTaskReviewPrompt(state.spec, state.summary));
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
		// ponytail: 单点防御 — 覆盖 command:task、agent_end save、resumed 脏 state 三条路径。
		// 旧会话 resume 会带回修复前产生的非法 reviewResult.contract,agent_end guard 救不了已存数据。
		// 这里拦住后友好反馈,不让 raw assertValidContract 错误冒泡成 Extension error。
		let contractError: string | undefined;
		try {
			assertValidContract(state.reviewResult.contract);
		} catch (error) {
			contractError = (error as Error).message;
		}
		if (contractError) {
			ctx.ui.notify("复盘产出的 contract.json 不合法,拒绝保存。", "warning");
			pi.sendUserMessage?.(`复盘产出的 contract 不合法:${contractError}\n\ncontract 约定:runtimeInput 必须是字符串数组(字段名列表);runtimeInputMeta 是对象,每个 key 必须已在 runtimeInput 中声明。请按此约定修正 contract,重新输出完整 taskbook JSON。`, { deliverAs: "followUp" });
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
					// ponytail: 不 terminate。确定性任务的 PASS/FAIL + 产物路径已在 content 里,
					// agent 拿到后自行判断是否结束还是继续下一步(如"先抓列表再下载"的组合编排)。
					// 之前 terminate:true 是为绕开"工具后自动总结轮 provider 卡死",但那是 provider 层
					// 问题,terminate 只是回避不是修复,且代价是截断所有后续 agent 决策——多步编排的
					// 第一步(往往是 single)会被截断,逼用户手动"继续"。若 provider 卡死重现,应从
					// abort/provider 层修,不在 task 工具层用 terminate 兜底。
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
				const userObservation = ctx.ui?.input
					? await ctx.ui.input("你觉得刚刚的运行结果有什么问题吗?", "")
					: "";
				if (userObservation === undefined) return;
				setTaskRunWidget(ctx, [
					`📋 正在复盘 taskbook "${lastTaskRunReview.taskbookName}"...`,
					"reviewer 分析中,请稍候",
				]);
				try {
					const result = await dispatchTaskRunReviewer({
						runContext: lastTaskRunReview.content,
						userObservation,
					}, { cwd: cwdOf(ctx) });
					sendTaskMessage(pi, ctx, result.summary, result.ok ? "info" : "warning");
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
				const userEditRequest = ctx.ui?.input
					? await ctx.ui.input("你想怎么修改这个 taskbook?(可留空)", "")
					: "";
				if (userEditRequest === undefined) return;
				const loaded = await loadTaskbook(cwdOf(ctx), finalName);
				if (!loaded) {
					ctx.ui.notify(`taskbook "${finalName}" 不存在`, "warning");
					return;
				}
				await startTaskbookEdit(ctx, loaded, userEditRequest);
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
			if (action === "show") return await handleTaskShow(ctx, name ?? (state.pendingTransition === "repair" ? state.taskbookName : undefined), async (loaded, request) => {
				const userEditRequest = request ?? (ctx.ui?.input ? await ctx.ui.input("你想怎么修改这个 taskbook?(可留空)", "") : "");
				if (userEditRequest === undefined) return;
				await startTaskbookEdit(ctx, loaded, userEditRequest);
			});
			if (action === "run" || action === "rerun") return await handleTaskRun(pi, ctx, name ?? (action === "rerun" ? state.taskbookName : undefined), rawInput, (failure) => {
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

	// before_agent_start: 追加 taskbook 清单到 system prompt,而非整体覆盖。
	// 覆盖会吃掉 base prompt 里的 skill 清单/工具说明/项目上下文等全部内容,
	// 导致模型既看不到 skill 也触发不了。pi 把当前完整 systemPrompt 传给 event,
	// 我们只在其末尾追加 task 清单。
	pi.on("before_agent_start", async (event: any) => {
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
		if (cachedTaskbookPrompt) {
			const base = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
			result.systemPrompt = `${base}\n\n${cachedTaskbookPrompt}`;
		}
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
		if (isPlanningAllowedCommand(command)) return undefined;
		return {
			block: true,
			reason: `Task planning: command blocked (destructive or side-effecting). Command: ${command}`,
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
			const text = getTextContent(lastAssistant);
			if (isCancelledAssistantText(text)) {
				ctx.ui.notify("Task review cancelled; reviewing remains active.", "info");
				return;
			}
			const result = extractTaskReviewResult(text);
			if (!result) {
				ctx.ui.notify("Task review did not find skill/verify/contract JSON yet.", "warning");
				pi.sendUserMessage?.("你刚才的 taskbook 结果没有被 /task 解析成合法 JSON。请重新输出一个合法 JSON 对象,包含 description、skill、verify、contract；不要输出 markdown 代码块或改动摘要；skill/verify 里的换行必须作为 JSON 字符串内容正确转义。", { deliverAs: "followUp" });
				return;
			}
			// ponytail: 早拦截。解析阶段就校验 contract,避免非法 reviewResult 进 state 后
			// 在 saveTaskbook 才抛 Invalid contract.runtimeInput —— 那时已误发"复盘完成"。
			// saveCurrentTask 入口和 saveTaskbook 各有一道校验,覆盖 resumed 脏 state 和物理写入。
			let contractError: string | undefined;
			try {
				assertValidContract(result.contract);
			} catch (error) {
				contractError = (error as Error).message;
			}
			if (contractError) {
				ctx.ui.notify("复盘产出的 contract.json 不合法,请修正后重新输出。", "warning");
				pi.sendUserMessage?.(`你刚才的 taskbook JSON 解析成功,但 contract 不合法:${contractError}\n\ncontract 约定:runtimeInput 必须是字符串数组(字段名列表);runtimeInputMeta 是对象,每个 key 必须已在 runtimeInput 中声明。请按此约定修正 contract,重新输出完整 taskbook JSON。`, { deliverAs: "followUp" });
				return;
			}
			state = setTaskReviewResult(state, result);
			state = setPendingTransition(state, "save");
			persistState();
			ctx.ui.notify("复盘完成。请选择下一步,或输入修改意见。", "info");
			await promptTaskMenu(ctx);
			return;
		}
		const text = getTextContent(lastAssistant);
		if (isCancelledAssistantText(text)) {
			ctx.ui.notify("Task planning cancelled; planning remains active.", "info");
			return;
		}
		const spec = extractRequirementsSpec(text);
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
