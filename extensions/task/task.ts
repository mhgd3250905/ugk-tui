import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
	extractArtifactsFromToolInput,
	extractRequirementsSpec,
	formatRequirementsSpec,
	isSafeCommand,
	summarizeToolArgs,
} from "../judge/judge-utils.ts";
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
import { appendRunToTaskbook, deleteTaskbook, listTaskbooks, loadTaskbook, saveTaskbook, taskDir } from "./task-book.ts";
import { dispatchChecker } from "./task-checker.ts";
import { resolveRuntimeInputFromText } from "./task-dispatcher.ts";
import { buildTaskReviewPrompt, extractTaskReviewResult, TASK_ALIGN_PROMPT } from "./task-prompts.ts";
import { runVerify } from "./task-verify.ts";
import { dispatchWorker, type TaskWorkerResult } from "./task-worker.ts";

const TASK_STATE_TYPE = "task-state";
const TASK_PLAN_CONTEXT_TYPE = "task-plan-context";
const TASK_REVIEW_CONTEXT_TYPE = "task-review-context";
const TASK_PLANNING_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const TASK_EXECUTING_TOOLS = ["read", "write", "edit", "bash", "task_complete"];
const TASK_NORMAL_TOOLS = ["read", "bash", "edit", "write", "subagent"];

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
	["列出 taskbook", "list"],
	["保存为 taskbook", "save"],
	["自动保存 taskbook", "save"],
	["删除 taskbook", "delete"],
	["继续复盘", "continue-review"],
	["放弃", "abort"],
	["停止本次执行", "stop"],
	["退出 Task", "exit"],
	["Exit", undefined],
]);

function isActivePhase(phase: TaskPhase): boolean {
	return phase === "planning" || phase === "executing" || phase === "reviewing";
}

export function getTaskCommandMenuOptions(state: TaskState): string[] {
	if (state.phase === "planning") {
		return state.spec
			? ["开始执行", "继续对齐", "修改当前 Spec", "退出 Task", "Exit"]
			: ["继续对齐", "退出 Task", "Exit"];
	}
	if (state.phase === "executing") return ["停止本次执行", "Exit"];
	if (state.phase === "reviewing") return ["自动保存 taskbook", "继续复盘", "放弃", "退出 Task", "Exit"];
	return ["新建任务", "运行 taskbook(复用)", "列出 taskbook", "查看 taskbook 详情", "编辑 taskbook", "删除 taskbook", "Exit"];
}

export async function resolveTaskCommandArgs(args: string, ctx: any, state: TaskState): Promise<string | undefined> {
	if (args.trim()) return args;
	if (!ctx.ui?.select) return "list";
	const selection = await ctx.ui.select("Task", getTaskCommandMenuOptions(state));
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
		summary: typeof record.summary === "string" ? record.summary : "",
		retryCount: typeof record.retryCount === "number" ? record.retryCount : 0,
		maxRetry: typeof record.maxRetry === "number" ? record.maxRetry : 3,
		planQuestionnaireUsed: record.planQuestionnaireUsed === true,
		reviewQuestionnaireUsed: record.reviewQuestionnaireUsed === true,
		executeRunDir: typeof record.executeRunDir === "string" ? record.executeRunDir : undefined,
		executeProcessLog: Array.isArray(record.executeProcessLog) ? record.executeProcessLog as TaskState["executeProcessLog"] : [],
		pendingTransition: record.pendingTransition === "execute" || record.pendingTransition === "review" || record.pendingTransition === "save"
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

async function resolveRuntimeInput(ctx: any, skill: string, contract: unknown, rawInput: string): Promise<unknown> {
	return await resolveRuntimeInputFromText(ctx, skill, contract, rawInput);
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

async function formatArtifact(outputDir: string, name: string): Promise<string[]> {
	const filePath = path.resolve(outputDir, name);
	try {
		const info = await stat(filePath);
		const lines = [`  ${filePath} (${info.size} bytes)`];
		if (name.endsWith(".json")) {
			const json = JSON.parse(await readFile(filePath, "utf8"));
			lines.push(`  内容: ${JSON.stringify(json)}`);
		}
		return lines;
	} catch (error) {
		return [`  ${filePath} (missing: ${(error as Error).message})`];
	}
}

async function formatArtifacts(contract: unknown, outputDir: string): Promise<string[]> {
	const names = artifactNames(contract);
	const actualNames = names.length > 0
		? names
		: (await readdir(outputDir).catch(() => []));
	const lines = ["产出:"];
	for (const name of actualNames) lines.push(...await formatArtifact(outputDir, name));
	return lines;
}

async function formatRunResult(
	loaded: Awaited<ReturnType<typeof loadTaskbook>> & {},
	outputDir: string,
	workerResult: TaskWorkerResult | undefined,
	verifyResult: Awaited<ReturnType<typeof runVerify>> | undefined,
	passed: boolean,
	attempts: number,
	durationSeconds: number,
): Promise<string> {
	if (passed) {
		return [
			`✅ taskbook "${loaded.taskbook.name}" PASS(尝试 ${attempts} 次, ${durationSeconds.toFixed(1)}s)`,
			"",
			...await formatArtifacts(loaded.contract, outputDir),
			"",
			"verify: 全过",
			workerResult?.summary ? `worker 摘要:\n  ${workerResult.summary}` : "",
		].filter(Boolean).join("\n");
	}
	const failures = verifyResult?.failures ?? [];
	return [
		`❌ taskbook "${loaded.taskbook.name}" FAIL(尝试 ${attempts} 次, ${durationSeconds.toFixed(1)}s)`,
		"",
		"失败断言:",
		...(failures.length > 0
			? failures.map((failure) => `  - ${failure.assertion}: 预期 ${failure.expected}, 实际 ${failure.actual}`)
			: ["  - verify 未返回结构化失败"]),
		"",
		"worker 摘要:",
		`  ${workerResult?.summary || "无"}`,
	].join("\n");
}

function setTaskRunWidget(ctx: any, lines: string[] | undefined): void {
	ctx.ui?.setWidget?.("task-run-view", lines, { placement: "aboveEditor" });
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

async function handleTaskRun(ctx: any, name: string | undefined, rawInput: string): Promise<void> {
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

	const startedAt = Date.now();
	const runDir = path.join(cwdOf(ctx), ".tasks", "runs", `task-${finalName}-${startedAt}`);
	const outputDir = path.join(runDir, "output");
	await mkdir(outputDir, { recursive: true });
	const runtimeInput = await resolveRuntimeInput(ctx, loaded.skill, loaded.contract, finalRawInput ?? "");
	const maxRetry = 3;
	let lastVerifyResult: Awaited<ReturnType<typeof runVerify>> | undefined;
	let lastWorkerResult: TaskWorkerResult | undefined;
	let feedback: unknown;

	try {
	for (let attempt = 0; attempt <= maxRetry; attempt += 1) {
		setTaskRunWidget(ctx, [
			`⏳ taskbook "${finalName}" 运行中...`,
			`尝试 ${attempt + 1}/${maxRetry + 1}`,
			"worker 执行中...",
		]);
		const workerResult = await dispatchWorker({
			skill: loaded.skill,
			contract: loaded.contract,
			runtimeInput,
			outputDir,
			feedback,
		}, { cwd: cwdOf(ctx) });
		lastWorkerResult = workerResult;

		if (!workerResult.ok) {
			ctx.ui.notify(`worker 执行失败: ${workerResult.errorMessage}`, "error");
			break;
		}

		setTaskRunWidget(ctx, [
			`⏳ taskbook "${finalName}" 运行中...`,
			`尝试 ${attempt + 1}/${maxRetry + 1}`,
			"verify 执行中...",
		]);
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
			ctx.ui.notify(await formatRunResult(loaded, outputDir, workerResult, lastVerifyResult, true, attempt + 1, duration), "info");
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
	ctx.ui.notify(await formatRunResult(loaded, outputDir, lastWorkerResult, lastVerifyResult, false, maxRetry + 1, duration), "error");
	} finally {
		setTaskRunWidget(ctx, undefined);
	}
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

export function registerTask(pi: ExtensionAPI): void {
	let state = createTaskState();
	let restoreToolsSnapshot: string[] | undefined;

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
		pi.setActiveTools?.(TASK_EXECUTING_TOOLS);
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
		ctx.ui.notify(`execute 完成,产出在 ${state.executeRunDir ? path.join(state.executeRunDir, "output") : "(unknown)"}。按 Enter 进 review 复盘,或输入意见。`, "info");
	}

	async function enterReviewFromPending(ctx: any): Promise<void> {
		if (state.phase !== "executing" || state.pendingTransition !== "review") return;
		state = enterReviewing(state, state.summary);
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
			return;
		}
		const finalName = name ?? state.taskbookName ?? await ctx.ui?.input?.("taskbook 名字", "my-task");
		if (!finalName?.trim()) {
			ctx.ui.notify("缺少 taskbook 名字。", "warning");
			return;
		}
		const scope = scopeFromTokens(tokens);
		await saveTaskbook(scope, cwdOf(ctx), finalName.trim(), {
			description: state.reviewResult.description,
			spec: state.spec,
			skill: state.reviewResult.skill,
			verify: state.reviewResult.verify,
			contract: state.reviewResult.contract,
			tags: state.reviewResult.tags,
		});
		const outputDir = state.executeRunDir ? path.join(state.executeRunDir, "output") : undefined;
		if (!outputDir?.trim()) {
			ctx.ui.notify("缺少首次成功产出的 outputDir,拒绝 landed。", "warning");
			return;
		}
		let runtimeInput = await resolveSelfCheckInput(ctx, state.reviewResult.contract);
		let verifyResult = await runVerify({
			verifyPath: path.join(taskDir(scope, cwdOf(ctx), finalName.trim()), "verify.mjs"),
			outputDir,
			input: runtimeInput,
		});
		if (!verifyResult.passed && runtimeFields(state.reviewResult.contract).length > 0) {
			runtimeInput = await askSelfCheckInput(ctx, state.reviewResult.contract);
			verifyResult = await runVerify({
				verifyPath: path.join(taskDir(scope, cwdOf(ctx), finalName.trim()), "verify.mjs"),
				outputDir,
				input: runtimeInput,
			});
		}
		if (!verifyResult.passed) {
			ctx.ui.notify(`verify 自证失败,未进入 landed:\n${JSON.stringify(verifyResult.failures, null, 2)}`, "warning");
			return;
		}
		state = landTask(state);
		persistState();
		restoreActiveTools();
		setTaskStatus(ctx, undefined);
		ctx.ui.notify(`taskbook "${finalName.trim()}" 已就绪。以后用 \`/task run ${finalName.trim()} <一句话>\` 复用。`, "info");
	}

	pi.registerTool?.(taskCompleteTool);

	pi.registerCommand("task", {
		description: "UGK task delegation system",
		handler: async (args, ctx) => {
			const resolvedArgs = await resolveTaskCommandArgs(args, ctx, state);
			if (resolvedArgs === undefined) return;
			const { action, name, tokens, rawInput } = parseTaskCommand(resolvedArgs);

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
				state = setTaskSpec(enterPlanning(state), loaded.spec);
				state = { ...state, taskbookName: finalName };
				pi.setActiveTools?.(TASK_PLANNING_TOOLS);
				persistState();
				setTaskStatus(ctx, "📋 task");
				pi.sendUserMessage?.(`请用 questionnaire 重新核对并修订这个 taskbook 的 Spec:\n\n${formatRequirementsSpec(loaded.spec)}`, { deliverAs: "followUp" });
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
				await prepareReviewFromExecute(ctx, rawInput);
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
			if (action === "show") return await handleTaskShow(ctx, name);
			if (action === "run") return await handleTaskRun(ctx, name, rawInput);
			if (action === "delete") return await handleTaskDelete(ctx, name, tokens);
			if (action === "stop" || action === "exit" || action === "toggle" || action === "abort") {
				state = abortTask(state);
				persistState();
				setTaskStatus(ctx, undefined);
				restoreActiveTools();
				ctx.ui.notify("Task disabled.", "info");
				return;
			}
			ctx.ui.notify("Usage: /task list|show|new|run|edit|save|delete|toggle|exit", "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager?.getEntries?.() ?? [];
		for (const entry of [...entries].reverse()) {
			if (entry.customType !== TASK_STATE_TYPE) continue;
			const restored = restoreTaskState(entry.data);
			if (!restored) break;
			state = restored;
			if (isActivePhase(state.phase)) {
				restoreToolsSnapshot ??= typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS;
				if (state.phase === "planning") pi.setActiveTools?.(TASK_PLANNING_TOOLS);
				if (state.phase === "executing") pi.setActiveTools?.(TASK_EXECUTING_TOOLS);
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
		if (state.phase === "reviewing") {
			return {
				message: {
					customType: TASK_REVIEW_CONTEXT_TYPE,
					content: buildTaskReviewPrompt(state.spec, state.summary),
					display: false,
				},
			};
		}
		if (state.phase !== "planning") return undefined;
		return {
			message: {
				customType: TASK_PLAN_CONTEXT_TYPE,
				content: TASK_ALIGN_PROMPT,
				display: false,
			},
		};
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
			if (["bash", "write", "edit", "chrome_cdp", "task_complete"].includes(event.toolName)) {
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
			}
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
		if (!state.pendingTransition || event.source !== "interactive") return;
		const text = typeof event.text === "string" ? event.text.trim() : "";
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
				return;
			}
			state = setTaskReviewResult(state, result);
			state = setPendingTransition(state, "save");
			persistState();
			ctx.ui.notify("复盘完成。按 Enter 自动保存(会跑 verify 自证),或输入修改意见。", "info");
			return;
		}
		const spec = extractRequirementsSpec(getTextContent(lastAssistant));
		if (!spec) {
			ctx.ui.notify("Task planning did not find a complete RequirementsSpec yet.", "warning");
			return;
		}
		state = setPendingTransition(setTaskSpec(state, spec), "execute");
		persistState();
		ctx.ui.notify("Spec 已对齐。按 Enter 进 execute 阶段(我亲手做一遍验证可行性),或输入修改意见。", "info");
		return undefined;
	});
}

export default registerTask;
