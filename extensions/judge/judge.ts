import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { Type, type AssistantMessage, type TextContent } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionMode,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	abortJudge,
	completeJudge,
	createJudgeState,
	enterDelivering,
	enterAligning,
	markAligningQuestionnaireUsed,
	markPendingAck,
	recordJudgeEscalation,
	recordJudgeSteer,
	setAligningMode,
	setPendingTaskbookRun,
	setRequirementsSpec,
	setTaskbookForRun,
	startDriving,
	type DriverSummary,
	type JudgeState,
	type PendingTaskbookRun,
	type RequirementsSpec,
} from "./judge-state.ts";
import { ALIGN_PROMPT, buildDecidePrompt, buildEditPrompt, buildFinalizePrompt } from "./judge-prompts.ts";
import {
	extractRequirementsSpec,
	formatRequirementsSpec,
	isSafeCommand,
	parseJudgeFinalVerdict,
	parseJudgeVerdict,
	type JudgeFinalVerdict,
	type JudgeVerdict,
	type TranscriptTail,
} from "./judge-utils.ts";
import {
	createJudgeDriver,
	type JudgeEscalationContext,
	type JudgeDriverHandle,
	type JudgeDriverOptions,
	type JudgeWakeupContext,
} from "./judge-driver.ts";
import {
	createDriverSession,
	defaultDriverSessionFactory,
	type DriverSession,
	type DriverSessionFactory,
} from "../shared/driver-session.ts";
import { resolveBashCommand } from "../doctor/checks.ts";
import registerQuestionnaire from "./questionnaire.ts";
import { formatDeliveryReport } from "./delivery.ts";
import {
	buildBashLiveLogCommand,
	buildWindowsLiveLogLaunchPlan,
	openPreparedLiveLogTerminal,
	setOpenLiveLogTerminalForTests,
} from "./terminal-launcher.ts";
import {
	appendRunToTaskbook,
	draftExperienceMd,
	isValidTaskbookName,
	listTaskbooks,
	loadTaskbook,
	readExperienceMd,
	saveTaskbook,
	updateTaskbookSpec,
	writeExperienceMd,
	type RunSummary,
} from "./taskbook.ts";

// Re-export so existing test imports from "./judge.ts" keep working unchanged.
export {
	buildBashLiveLogCommand,
	buildWindowsLiveLogLaunchPlan,
	setOpenLiveLogTerminalForTests,
} from "./terminal-launcher.ts";

const JUDGE_ALIGNING_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const JUDGE_NORMAL_TOOLS = ["read", "bash", "edit", "write", "subagent"];
const JUDGE_MENU_OPTIONS = ["委派 driver 执行", "继续澄清", "改需求"];
const JUDGE_PHASES = new Set(["aligning", "driving", "delivering", "aborted", "done"]);
const JUDGE_DRIVER_WIDGET_KEY = "judge-driver-view";
type PassDeliveryAction = "accept" | "revise" | "stop" | "pending";

export function shouldOpenLiveLogTerminal(ctx: { hasUI?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(ctx.hasUI) && env.UGK_SKIP_JUDGE_LIVE_LOG_TERMINAL !== "1";
}

/** 把 Judge verdict 格式化成 widget 用的单行文本。 */
function formatJudgeVerdictLine(verdict: { action: string; direction?: string; reason?: string; keepWatching?: boolean }): string {
	if (verdict.action === "pass") {
		return verdict.keepWatching === false ? "PASS" : "PASS (keepWatching)";
	}
	if (verdict.action === "steer") {
		return `STEER: ${verdict.direction ?? "(no direction)"}`;
	}
	if (verdict.action === "parse_failed") {
		return `PARSE_FAILED: ${verdict.reason}`;
	}
	return `ABORT: ${verdict.reason ?? "(no reason)"}`;
}

/** 移除 driver 过程可视化 widget。可在任何拿到 ui 的清理点调用。 */
function clearJudgeDriverWidget(ui: { setWidget?: (key: string, content: unknown, options?: { placement: string }) => void }): void {
	try {
		ui.setWidget?.(JUDGE_DRIVER_WIDGET_KEY, undefined, { placement: "aboveEditor" });
	} catch {
		// setWidget 在非 TUI 模式可能不可用,忽略
	}
}

export const JUDGE_AGENT_DEFINITION_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"agents",
	"judge.md",
);

let judgeDriverFactoryForTests:
	| ((options: JudgeDriverOptions) => Promise<JudgeDriverHandle>)
	| undefined;
type JudgeVerdictProviderContext = JudgeWakeupContext & {
	spec: string;
};
type JudgeVerdictProvider = (context: JudgeVerdictProviderContext) => Promise<JudgeVerdict> | JudgeVerdict;
type JudgeFinalVerdictProviderContext = JudgeWakeupContext & {
	spec: string;
	finalizePrompt: string;
};
type JudgeFinalVerdictProvider = (context: JudgeFinalVerdictProviderContext) => Promise<JudgeFinalVerdict> | JudgeFinalVerdict;
interface JudgeVerdictProviderHandle {
	decide: JudgeVerdictProvider;
	finalize: JudgeFinalVerdictProvider;
	dispose(): void;
}
let judgeVerdictProviderForTests: JudgeVerdictProvider | undefined;
let judgeDecisionSessionFactoryForTests: DriverSessionFactory | undefined;

export function setJudgeDriverFactoryForTests(factory: typeof judgeDriverFactoryForTests): void {
	judgeDriverFactoryForTests = factory;
}

export function setJudgeVerdictProviderForTests(provider: typeof judgeVerdictProviderForTests): void {
	judgeVerdictProviderForTests = provider;
}

export function setJudgeDecisionSessionFactoryForTests(factory: typeof judgeDecisionSessionFactoryForTests): void {
	judgeDecisionSessionFactoryForTests = factory;
}

function getCwd(ctx: ExtensionContext): string {
	const cwd = (ctx as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : process.cwd();
}

function formatJudgeEscalation(context: JudgeEscalationContext): string {
	return [
		"[JUDGE ESCALATION]",
		"",
		`Reason: ${context.reason}`,
		"",
		"DriverSummary:",
		JSON.stringify(context.summary, null, "\t"),
		"",
		"TranscriptTail:",
		JSON.stringify(context.tail, null, "\t"),
		"",
		"Transcript:",
		context.transcript || "(empty)",
	].join("\n");
}

function createJudgeVerdictProviderHandle(options: {
	cwd: string;
	runId: string;
	runDir: string;
	specText: string;
	uiContext: ExtensionUIContext;
	extensionMode: ExtensionMode;
}): JudgeVerdictProviderHandle {
	let session: DriverSession | undefined;

	async function getSession(): Promise<DriverSession> {
		if (session) return session;
		session = await createDriverSession(
			{
				cwd: options.cwd,
				taskId: "judge-decider",
				runId: `${options.runId}-judge`,
				runDir: path.join(options.runDir, "judge"),
				initialPrompt: "",
				label: "Judge decider",
				uiContext: options.uiContext,
				extensionMode: options.extensionMode,
				agentDefinitionPath: JUDGE_AGENT_DEFINITION_PATH,
			},
			judgeDecisionSessionFactoryForTests ?? defaultDriverSessionFactory,
		);
		return session;
	}

	return {
		async decide(context) {
			const judgeSession = await getSession();
			const decidePrompt = context.decidePrompt || buildDecidePrompt(options.specText, context.summary, context.tail);
			const currentTurn = await judgeSession.ask(decidePrompt);
			const verdict = parseJudgeVerdict(currentTurn);
			// parse 失败不 ABORT 整个 driver —— Judge LLM 偶发输出格式异常(被截断/无 JSON)
			// 不该让一个跑了 N 步、方向正确的任务被判死刑。返回显式 parse_failed,
			// 由 driver 层按 maxSteer 预算兜底,避免无限放行。
			if (!verdict) {
				return {
					action: "parse_failed",
					keepWatching: true,
					reason: "(Judge 输出解析失败,默认放行,下次唤醒重新判定)",
				};
			}
			return verdict;
		},
		async finalize(context) {
			const judgeSession = await getSession();
			const finalizePrompt = context.finalizePrompt || buildFinalizePrompt(options.specText, context.summary, context.tail);
			const currentTurn = await judgeSession.ask(finalizePrompt);
			const verdict = parseJudgeFinalVerdict(currentTurn);
			return verdict ?? {
				status: "fail",
				reason: "Judge final verdict parse failed",
				evidence: [],
			};
		},
		dispose() {
			session?.dispose();
			session = undefined;
		},
	};
}

function createJudgeWakeupHandler(
	specText: string,
	provider: JudgeVerdictProvider,
	hooks: {
		onSteer?: () => void;
		onAbort?: (reason: string) => void;
		onFinalize?: (context: JudgeWakeupContext) => Promise<JudgeVerdict> | JudgeVerdict;
	} = {},
): JudgeDriverOptions["onWakeup"] {
	return async (context) => {
		if (context.reason === "judge_complete" && context.summary.completed && hooks.onFinalize) {
			const finalVerdict = await hooks.onFinalize(context);
			if (finalVerdict.action === "steer") {
				hooks.onSteer?.();
			}
			if (finalVerdict.action === "abort") {
				hooks.onAbort?.(finalVerdict.reason);
			}
			return finalVerdict;
		}
		const summary = context.summary;
		const decidePrompt = context.decidePrompt || buildDecidePrompt(specText, summary, context.tail);
		const verdict = await provider({
			...context,
			spec: specText,
			summary,
			decidePrompt,
		});
		if (verdict.action === "steer") {
			hooks.onSteer?.();
		}
		if (verdict.action === "abort") {
			hooks.onAbort?.(verdict.reason);
		}
		return verdict;
	};
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function persistState(pi: ExtensionAPI, state: JudgeState): void {
	pi.appendEntry("judge-state", {
		phase: state.phase,
		spec: state.spec,
		summary: state.summary,
		steerCount: state.steerCount,
		maxSteer: state.maxSteer,
		keepWatching: state.keepWatching,
		pendingAckStatus: state.pendingAckStatus,
		pendingTaskbookRun: state.pendingTaskbookRun,
		taskbookName: state.taskbookName,
		aligningMode: state.aligningMode,
		aligningQuestionnaireUsed: state.aligningQuestionnaireUsed,
	});
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRequirementsSpec(value: unknown): value is RequirementsSpec {
	if (value === null) return false;
	if (typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.goal === "string" &&
		isStringArray(record.hardConstraints) &&
		isStringArray(record.acceptance) &&
		isStringArray(record.forbidden) &&
		typeof record.context === "string"
	);
}

function restoreJudgeState(data: unknown): JudgeState | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (typeof record.phase !== "string" || !JUDGE_PHASES.has(record.phase)) return undefined;
	if (record.spec !== null && !isRequirementsSpec(record.spec)) return undefined;
	if (typeof record.summary !== "string") return undefined;
	if (typeof record.steerCount !== "number") return undefined;
	if (typeof record.maxSteer !== "number") return undefined;
	if (typeof record.keepWatching !== "boolean") return undefined;
	if (
		record.pendingAckStatus !== undefined &&
		record.pendingAckStatus !== "pass" &&
		record.pendingAckStatus !== "fail"
	) {
		return undefined;
	}

	return {
		phase: record.phase as JudgeState["phase"],
		spec: record.spec,
		summary: record.summary,
		steerCount: record.steerCount,
		maxSteer: record.maxSteer,
		keepWatching: record.keepWatching,
		pendingAckStatus: record.pendingAckStatus as JudgeState["pendingAckStatus"],
		pendingTaskbookRun: record.pendingTaskbookRun as PendingTaskbookRun | undefined,
		taskbookName: typeof record.taskbookName === "string" ? record.taskbookName : undefined,
		aligningMode: record.aligningMode === "edit" ? "edit" : "new",
		aligningQuestionnaireUsed: record.aligningQuestionnaireUsed === true,
	};
}

function isJudgeAlignContextMessage(message: AgentMessage): boolean {
	return message.role === "custom" && (message as { customType?: unknown }).customType === "judge-align-context";
}

function filterJudgeContextMessages(messages: AgentMessage[], state: JudgeState): AgentMessage[] {
	if (state.phase !== "aligning") {
		return messages.filter((message) => !isJudgeAlignContextMessage(message));
	}
	let keepIndex = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (isJudgeAlignContextMessage(messages[index])) {
			keepIndex = index;
			break;
		}
	}
	return messages.filter((message, index) => !isJudgeAlignContextMessage(message) || index === keepIndex);
}

const judgeCompleteTool = defineTool({
	name: "judge_complete",
	label: "Judge Complete",
	description: "Signal to the Judge that the driver believes the delegated task is complete.",
	parameters: Type.Object({
		summary: Type.Optional(Type.String({ description: "Short completion summary from the driver" })),
	}),

	async execute(_toolCallId, params) {
		const summary = typeof params.summary === "string" ? params.summary : "";
		return {
			content: [
				{
					type: "text",
					text: summary
						? `judge_complete received. Summary: ${summary}`
						: "judge_complete received.",
				},
			],
			details: { completed: true, summary },
		};
	},
});

export function registerJudge(pi: ExtensionAPI): void {
	let state = createJudgeState();
	let activeDriver: JudgeDriverHandle | undefined;
	let activeJudgeVerdictProvider: JudgeVerdictProviderHandle | undefined;
	let restoreToolsSnapshot: string[] | undefined;

	function setJudgeStatus(ctx: ExtensionContext, label?: string): void {
		const ui = ctx.ui as {
			setStatus?: (key: string, value: string | undefined) => void;
			theme?: { fg?: (tone: string, text: string) => string };
		};
		ui.setStatus?.("judge-mode", label ? (ui.theme?.fg?.("warning", label) ?? label) : undefined);
	}

	function isJudgeActive(): boolean {
		return state.phase === "aligning" || state.phase === "driving" || state.phase === "delivering";
	}

	function getJudgeCommandMenuOptions(): string[] {
		if (state.phase === "aligning") {
			return state.spec
				? ["开始执行", "继续澄清", "修改当前 Spec", "保存为任务书", "退出 Judge", "Exit"]
				: ["继续澄清", "退出 Judge", "Exit"];
		}
		if (state.phase === "driving") {
			return ["停止本次执行", "Exit"];
		}
		if (state.phase === "delivering") {
			return state.pendingAckStatus === "pass"
				? ["接受交付", "退出 Judge", "Exit"]
				: ["退出 Judge", "Exit"];
		}
		return ["新建监督任务", "运行任务书", "编辑任务书", "列出任务书", "诊断: 检查 bash 新窗口", "Exit"];
	}

	function enableJudge(ctx: ExtensionContext): void {
		restoreToolsSnapshot ??= typeof pi.getActiveTools === "function"
			? pi.getActiveTools()
			: JUDGE_NORMAL_TOOLS;
		state = enterAligning({ ...state, taskbookName: undefined });
		pi.setActiveTools(JUDGE_ALIGNING_TOOLS);
		ctx.ui.notify(`Judge aligning mode enabled. Tools: ${JUDGE_ALIGNING_TOOLS.join(", ")}`, "info");
		setJudgeStatus(ctx, "⚖ judge");
		persistState(pi, state);
	}

	function restoreActiveTools(): void {
		if (!restoreToolsSnapshot) return;
		pi.setActiveTools(restoreToolsSnapshot);
		restoreToolsSnapshot = undefined;
	}

	function disableJudge(ctx: ExtensionContext): void {
		activeDriver?.dispose();
		activeDriver = undefined;
		activeJudgeVerdictProvider?.dispose();
		activeJudgeVerdictProvider = undefined;
		state = abortJudge(state);
		persistState(pi, state);
		restoreActiveTools();
		clearJudgeDriverWidget(ctx.ui);
		setJudgeStatus(ctx, undefined);
		ctx.ui.notify("Judge disabled.", "info");
	}

	async function choosePassDeliveryAction(ctx: ExtensionContext, canRevise: boolean): Promise<PassDeliveryAction> {
		if (ctx.ui?.select && ctx.ui?.confirm) {
			const options = canRevise ? ["接受交付", "继续修订", "停止 Judge"] : ["接受交付", "停止 Judge"];
			const choice = await ctx.ui.select("Judge PASS", options);
			if (choice === "接受交付") return "accept";
			if (choice === "继续修订") return "revise";
			if (choice === "停止 Judge") return "stop";
			return "pending";
		}
		const acknowledged = ctx.ui?.confirm
			? await ctx.ui.confirm("Judge PASS", "Accept this delivery?")
			: false;
		if (acknowledged) return "accept";
		if (!ctx.ui?.confirm) return "pending";
		return canRevise ? "revise" : "pending";
	}

	function checkBashLiveLogWindow(ctx: ExtensionContext): void {
		const runDir = path.join(getCwd(ctx), ".judge", `judge-live-check-${Date.now()}`);
		const liveLogPath = path.join(runDir, "live.log");
		try {
			mkdirSync(runDir, { recursive: true });
			writeFileSync(liveLogPath, `[${new Date().toISOString()}] Judge bash live log check started\n`, "utf8");
		} catch (error) {
			ctx.ui.notify(`创建 bash 窗口检查日志失败: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return;
		}

		const result = openPreparedLiveLogTerminal(liveLogPath);
		if (!result.ok) {
			ctx.ui.notify(`打开 bash 新窗口失败(${result.error})。可手动 tail -f ${liveLogPath}`, "warning");
			return;
		}

		for (let i = 1; i <= 3; i += 1) {
			const timer = setTimeout(() => {
				try {
					appendFileSync(liveLogPath, `[${new Date().toISOString()}] Judge bash live log check update ${i}/3\n`, "utf8");
				} catch {
					// 检查日志后续写入失败不影响 Judge 主流程
				}
			}, i * 750);
			timer.unref?.();
		}
		ctx.ui.notify(`已打开 bash 新窗口检查日志:${liveLogPath}`, "info");
	}

	async function recordTaskbookRun(ctx: ExtensionContext, options: {
		name: string;
		spec: RequirementsSpec;
		summary: DriverSummary;
		finalVerdict: JudgeFinalVerdict;
		updateExperience: boolean;
	}): Promise<void> {
		const cwd = getCwd(ctx);
		try {
			const run: RunSummary = options.finalVerdict.status === "pass"
				? {
					timestamp: new Date().toISOString(),
					status: "pass",
					steerCount: options.summary.steerCount,
					evidence: options.finalVerdict.evidence,
				}
				: {
					timestamp: new Date().toISOString(),
					status: "fail",
					steerCount: options.summary.steerCount,
					failReason: options.finalVerdict.reason || options.summary.abortReason || "unknown",
				};
			const taskbook = await appendRunToTaskbook(cwd, options.name, run);
			if (options.updateExperience) {
				await writeExperienceMd(cwd, options.name, draftExperienceMd(options.name, options.spec, options.summary.steerHistory ?? [], taskbook));
			}
			ctx.ui.notify(
				options.finalVerdict.status === "pass"
					? `任务书 "${options.name}" 已沉淀 PASS 经验`
					: `任务书 "${options.name}" 已记录失败经验`,
				"info",
			);
		} catch (error) {
			ctx.ui.notify(`任务书 "${options.name}" 沉淀失败: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	async function startActiveJudgeDriver(ctx: ExtensionContext, spec: RequirementsSpec, options: { background?: boolean } = {}): Promise<void> {
		setJudgeStatus(ctx, "⚖ driving");
		activeDriver?.dispose();
		clearJudgeDriverWidget(ctx.ui); // 清理上一轮 driver 的 widget,新一轮会重建
		const runId = `judge-${Date.now()}`;
		const specText = formatRequirementsSpec(spec);
		const cwd = getCwd(ctx);
		let initialPrompt = [
			"[JUDGE DRIVER TASK]",
			"Execute the following RequirementsSpec. When complete, call the judge_complete tool.",
			"",
			"Driver rule: If the RequirementsSpec mentions subagent, parallel subagents, or delegated agents, your first substantive tool call must be subagent. Do not spend turns probing bash/PATH/ls first; use bash only after subagent output shows it is necessary or the Spec explicitly requires bash.",
			"",
			specText,
		].join("\n");
		if (state.taskbookName) {
			try {
				const experience = await readExperienceMd(cwd, state.taskbookName);
				if (experience.trim()) {
					initialPrompt = [
						initialPrompt,
						"",
						"## 历史经验(补充参考,非验收标准)",
						experience,
					].join("\n");
				}
			} catch (error) {
				ctx.ui.notify(`读取任务书 "${state.taskbookName}" 经验失败: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		}
		const createDriver = judgeDriverFactoryForTests ?? createJudgeDriver;
		const runDir = path.join(cwd, ".judge", runId);

		// ---- driver 过程可视化 widget ----
		// 常量 JUDGE_DRIVER_WIDGET_KEY、formatJudgeVerdictLine、clearJudgeDriverWidget 在模块顶层。
		let lastWidgetSnapshot = "";
		let lastJudgeVerdictLine = "";
		let transcriptRefreshQueued = false;
		let widgetActive = true;

		function clearDriverWidget() {
			widgetActive = false;
			lastWidgetSnapshot = "";
			lastJudgeVerdictLine = "";
			clearJudgeDriverWidget(ctx.ui);
		}

		function refreshDriverWidget() {
			transcriptRefreshQueued = false;
			if (!widgetActive) return;
			if (!activeDriver) return;
			let lines: string[];
			try {
				const summary = activeDriver.getSummary();
				const transcriptLines = activeDriver.getWidgetLines();
				const titleLine = `─── Judge driver (turn ${summary.turnCount}, steer ${summary.steerCount}/${state.maxSteer}) ───`;
				const verdictBlock = lastJudgeVerdictLine ? ["─── Judge ───", lastJudgeVerdictLine] : [];
				lines = [titleLine, ...transcriptLines, ...verdictBlock];
			} catch {
				return;
			}
			const snapshot = lines.join("\n");
			if (snapshot === lastWidgetSnapshot) return; // 去重,避免 TUI 重建导致滚动跳动
			lastWidgetSnapshot = snapshot;
			try {
				(ctx.ui as { setWidget?: (key: string, content: unknown, options?: { placement: string }) => void })
					.setWidget?.(JUDGE_DRIVER_WIDGET_KEY, lines, { placement: "aboveEditor" });
			} catch {
				// setWidget 在非 TUI 模式可能不可用,忽略
			}
		}

		function scheduleDriverWidgetRefresh() {
			if (transcriptRefreshQueued) return;
			transcriptRefreshQueued = true;
			queueMicrotask(refreshDriverWidget);
		}

		activeJudgeVerdictProvider?.dispose();
		const defaultJudgeVerdictProvider = createJudgeVerdictProviderHandle({
			cwd,
			runId,
			runDir,
			specText,
			uiContext: ctx.ui,
			extensionMode: ctx.mode,
		});
		activeJudgeVerdictProvider = judgeVerdictProviderForTests
			? {
				decide: judgeVerdictProviderForTests,
				finalize: defaultJudgeVerdictProvider.finalize,
				dispose: defaultJudgeVerdictProvider.dispose,
			}
			: defaultJudgeVerdictProvider;
		activeDriver = await createDriver({
			cwd,
			runDir,
			runId,
			spec: specText,
			initialPrompt,
			onWakeup: createJudgeWakeupHandler(specText, activeJudgeVerdictProvider.decide, {
				onSteer() {
					state = recordJudgeSteer(state);
					persistState(pi, state);
				},
				onAbort(reason) {
					state = abortJudge(state);
					persistState(pi, state);
					ctx.ui.notify(`Judge aborted driver: ${reason}`, "error");
					clearDriverWidget();
					setJudgeStatus(ctx, undefined);
					restoreActiveTools();
				},
				async onFinalize(context) {
					const canContinueAfterFail = state.keepWatching && context.summary.steerCount < state.maxSteer;
					state = enterDelivering(state);
					persistState(pi, state);
					setJudgeStatus(ctx, "⚖ delivering");
					const finalizePrompt = buildFinalizePrompt(specText, context.summary, context.tail);
					const finalVerdict = await activeJudgeVerdictProvider!.finalize({
						...context,
						spec: specText,
						finalizePrompt,
					});
					const status = finalVerdict.status === "pass" ? "PASS" : "FAIL";
					const deliveryReport = formatDeliveryReport({
						status,
						finalVerdict,
						summary: context.summary,
						tail: context.tail,
					});
					state = { ...state, summary: deliveryReport };
					persistState(pi, state);
					pi.sendMessage(
						{
							customType: "judge-delivery",
							content: deliveryReport,
							display: true,
						},
						{ triggerTurn: false },
					);

					if (finalVerdict.status === "pass") {
						const passAction = await choosePassDeliveryAction(ctx, canContinueAfterFail);
						if (passAction === "accept") {
							if (state.taskbookName && state.spec) {
								await recordTaskbookRun(ctx, {
									name: state.taskbookName,
									spec: state.spec,
									summary: context.summary,
									finalVerdict,
									updateExperience: true,
								});
							}
							state = completeJudge({ ...state, summary: deliveryReport });
							persistState(pi, state);
							ctx.ui.notify("Judge delivery accepted.", "info");
							clearDriverWidget();
							setJudgeStatus(ctx, undefined);
							restoreActiveTools();
							return { action: "pass", keepWatching: false };
						}
						if (passAction === "revise" && canContinueAfterFail) {
							state = startDriving({ ...state, summary: deliveryReport });
							persistState(pi, state);
							setJudgeStatus(ctx, "⚖ driving");
							ctx.ui.notify("Judge PASS will continue revising.", "warning");
							return {
								action: "steer",
								direction: [
									"User rejected the PASS delivery.",
									"Revise the work until the user can accept it, then call judge_complete again.",
								].join("\n"),
								keepWatching: true,
							};
						}
						if (passAction === "stop") {
							state = abortJudge({ ...state, summary: deliveryReport });
							persistState(pi, state);
							clearDriverWidget();
							setJudgeStatus(ctx, undefined);
							restoreActiveTools();
							ctx.ui.notify("Judge delivery stopped.", "info");
							return { action: "pass", keepWatching: false };
						}
						state = markPendingAck(enterDelivering({ ...state, summary: deliveryReport }), "pass");
						// 暂存 taskbook 沉淀数据:若用户后来 /judge ack 接受,ack handler 会消费它
						// 完成 recordTaskbookRun,避免 pending ack 路径漏沉淀(reviewer Blocker)
						if (state.taskbookName && state.spec) {
							state = setPendingTaskbookRun(state, {
								name: state.taskbookName,
								spec: state.spec,
								summary: context.summary,
								finalVerdict,
							});
						}
						persistState(pi, state);
						setJudgeStatus(ctx, "⚖ delivering");
						clearDriverWidget();
						ctx.ui.notify(
							ctx.ui?.confirm
								? "Judge PASS rejected, but no steer budget remains. Run /judge ack to accept it anyway or /judge toggle to stop Judge."
								: "Judge delivery is waiting for user acknowledgement. Run /judge ack to accept it later.",
							"warning",
						);
						return { action: "pass", keepWatching: false };
					}

					if (!canContinueAfterFail) {
						if (state.taskbookName && state.spec) {
							await recordTaskbookRun(ctx, {
								name: state.taskbookName,
								spec: state.spec,
								summary: context.summary,
								finalVerdict,
								updateExperience: false,
							});
						}
						state = completeJudge({ ...state, summary: deliveryReport });
						persistState(pi, state);
						clearDriverWidget();
						setJudgeStatus(ctx, undefined);
						restoreActiveTools();
						ctx.ui.notify(`Judge final delivery failed and cannot continue automatically: ${finalVerdict.reason}`, "warning");
						return { action: "pass", keepWatching: false };
					}

					state = startDriving({ ...state, summary: deliveryReport });
					persistState(pi, state);
					setJudgeStatus(ctx, "⚖ driving");
					return {
						action: "steer",
						direction: [
							"Final delivery review failed.",
							`Reason: ${finalVerdict.reason}`,
							"Evidence:",
							...finalVerdict.evidence.map((item) => `- ${item}`),
							"Revise the work to satisfy the RequirementsSpec acceptance items, then call judge_complete again.",
						].join("\n"),
						keepWatching: true,
					};
				},
			}),
			maxSteer: state.maxSteer,
			onEscalate: async (context) => {
				const escalationSummary = formatJudgeEscalation(context);
				state = recordJudgeEscalation(state, escalationSummary);
				persistState(pi, state);
				setJudgeStatus(ctx, undefined);
				clearDriverWidget();
				restoreActiveTools();
				pi.sendMessage(
					{
						customType: "judge-escalation",
						content: escalationSummary,
						display: true,
					},
					{ triggerTurn: false },
				);
				ctx.ui.notify(`Judge needs user intervention: ${context.reason}`, "warning");
			},
			uiContext: ctx.ui,
			extensionMode: ctx.mode,
			onTranscriptUpdate: scheduleDriverWidgetRefresh,
			onJudgeVerdict: (verdict) => {
				lastJudgeVerdictLine = formatJudgeVerdictLine(verdict);
				refreshDriverWidget();
			},
		});
		// 委派后自动打开新终端实时看 driver + Judge 过程(零污染主 agent context)。
		if (shouldOpenLiveLogTerminal(ctx)) {
			const liveLogPath = activeDriver.getLiveLogPath?.() ?? path.join(runDir, "live.log");
			const result = openPreparedLiveLogTerminal(liveLogPath);
			if (result.ok) {
				ctx.ui.notify(`已打开过程终端,实时显示:${liveLogPath}`, "info");
			} else {
				ctx.ui.notify(`打开过程终端失败(${result.error})。可手动 tail -f ${liveLogPath}`, "warning");
			}
		}
		const startedDriver = activeDriver;
		function handleDriverStartFailure(error: unknown) {
			if (activeDriver !== startedDriver) return;
			state = abortJudge(state);
			persistState(pi, state);
			ctx.ui.notify(`Judge driver start failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			clearDriverWidget();
			setJudgeStatus(ctx, undefined);
			restoreActiveTools();
		}
		const startPromise = startedDriver.start().then(() => {
			if (activeDriver === startedDriver) refreshDriverWidget();
		});
		if (options.background) {
			void startPromise.catch(handleDriverStartFailure);
			refreshDriverWidget(); // driver 起来后立即显示一次 widget
			ctx.ui.notify("Judge driver started.", "info");
			return;
		}
		try {
			await startPromise;
		} catch (error) {
			handleDriverStartFailure(error);
			return;
		}
		refreshDriverWidget(); // driver 起来后立即显示一次 widget
		ctx.ui.notify("Judge driver started.", "info");
	}

	function emptyDriverSummary(): DriverSummary {
		return {
			pathsTried: [],
			artifacts: [],
			runningTools: [],
			turnCount: 0,
			steerCount: 0,
			steerHistory: [],
			completed: true,
		};
	}

	async function chooseTaskbookName(ctx: ExtensionContext): Promise<string | undefined> {
		const taskbooks = await listTaskbooks(getCwd(ctx));
		if (taskbooks.length === 0) {
			ctx.ui.notify("无任务书", "warning");
			return undefined;
		}
		const selection = await ctx.ui.select("选择任务书", taskbooks.map((taskbook) => taskbook.name));
		return selection || undefined;
	}

	async function handleTaskbookSave(ctx: ExtensionContext, rawName?: string): Promise<void> {
		if (!state.spec) {
			ctx.ui.notify("当前没有可保存的 Judge RequirementsSpec。", "warning");
			return;
		}
		let name = rawName;
		let description = state.spec.goal;
		if (!name) {
			const edited = await ctx.ui.editor("保存任务书", "taskbook-name\n任务书描述");
			const lines = (edited ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
			name = lines[0];
			description = lines.slice(1).join(" ") || description;
		}
		if (!name || !isValidTaskbookName(name)) {
			ctx.ui.notify("任务书名无效,只能使用字母、数字、-、_。", "warning");
			return;
		}
		try {
			const existing = await loadTaskbook(getCwd(ctx), name);
			if (existing && ctx.ui.confirm && !(await ctx.ui.confirm("覆盖任务书", `任务书 "${name}" 已存在,覆盖?`))) {
				return;
			}
			await saveTaskbook(getCwd(ctx), name, {
				description,
				spec: state.spec,
				summary: activeDriver?.getSummary() ?? emptyDriverSummary(),
			});
			ctx.ui.notify(`任务书 "${name}" 已保存。可用 /judge run ${name} 重跑。`, "info");
		} catch (error) {
			ctx.ui.notify(`保存任务书失败: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	async function handleTaskbookRun(ctx: ExtensionContext, rawName?: string): Promise<void> {
		const name = rawName || await chooseTaskbookName(ctx);
		if (!name) return;
		if (!isValidTaskbookName(name)) {
			ctx.ui.notify("任务书名无效,只能使用字母、数字、-、_。", "warning");
			return;
		}
		try {
			const loaded = await loadTaskbook(getCwd(ctx), name);
			if (!loaded) {
				ctx.ui.notify(`任务书 "${name}" 不存在。`, "warning");
				return;
			}
			restoreToolsSnapshot ??= typeof pi.getActiveTools === "function"
				? pi.getActiveTools()
				: JUDGE_NORMAL_TOOLS;
			pi.setActiveTools(JUDGE_NORMAL_TOOLS);
			state = startDriving(setTaskbookForRun(setRequirementsSpec(createJudgeState(), loaded.spec), name));
			persistState(pi, state);
			await startActiveJudgeDriver(ctx, loaded.spec, { background: true });
		} catch (error) {
			ctx.ui.notify(`运行任务书失败: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	async function handleTaskbookEdit(ctx: ExtensionContext, rawName?: string): Promise<void> {
		const name = rawName || await chooseTaskbookName(ctx);
		if (!name) return;
		if (!isValidTaskbookName(name)) {
			ctx.ui.notify("任务书名无效,只能使用字母、数字、-、_。", "warning");
			return;
		}
		try {
			const loaded = await loadTaskbook(getCwd(ctx), name);
			if (!loaded) {
				ctx.ui.notify(`任务书 "${name}" 不存在。`, "warning");
				return;
			}
			restoreToolsSnapshot ??= typeof pi.getActiveTools === "function"
				? pi.getActiveTools()
				: JUDGE_NORMAL_TOOLS;
			state = setTaskbookForRun(setAligningMode(setRequirementsSpec(enterAligning(state), loaded.spec), "edit"), name);
			pi.setActiveTools(JUDGE_ALIGNING_TOOLS);
			persistState(pi, state);
			setJudgeStatus(ctx, "⚖ edit");
			pi.sendUserMessage(`开始编辑任务书 "${name}"。请对照现有 Spec 用 questionnaire 确认需要修改的地方,然后产出修订后的 Spec。`, { deliverAs: "followUp" });
			ctx.ui.notify(`进入任务书 "${name}" 编辑模式。Judge 会逐条确认现有 Spec。`, "info");
		} catch (error) {
			ctx.ui.notify(`进入编辑模式失败: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	async function handleTaskbookList(ctx: ExtensionContext): Promise<void> {
		try {
			const taskbooks = await listTaskbooks(getCwd(ctx));
			if (taskbooks.length === 0) {
				ctx.ui.notify("无任务书", "info");
				return;
			}
			ctx.ui.notify(taskbooks.map((taskbook) => {
				const last = taskbook.lastRun ? ` last=${taskbook.lastRun.status}` : " no-runs";
				return `${taskbook.name}: ${taskbook.description}${last}`;
			}).join("\n"), "info");
		} catch (error) {
			ctx.ui.notify(`列出任务书失败: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	async function resolveJudgeCommandArgs(args: unknown, ctx: ExtensionContext): Promise<string | undefined> {
		const raw = String(args ?? "").trim();
		if (raw) return raw;
		if (!ctx.ui?.select) return undefined;

		const selection = await ctx.ui.select("Judge", getJudgeCommandMenuOptions());
		if (!selection || selection === "Exit") return undefined;
		if (selection === "新建监督任务") return "align";
		if (selection === "运行任务书") return "run";
		if (selection === "保存为任务书") return "save";
		if (selection === "编辑任务书") return "edit";
		if (selection === "列出任务书") return "list";
		if (selection === "诊断: 检查 bash 新窗口") return "check-bash-window";
		if (selection === "退出 Judge" || selection === "停止本次执行") return "toggle";
		if (selection === "继续澄清") return "clarify";
		if (selection === "开始执行") return "delegate";
		if (selection === "修改当前 Spec") return "change-spec";
		if (selection === "接受交付") return "ack";
		return undefined;
	}

	registerQuestionnaire(pi);
	pi.registerTool(judgeCompleteTool);

	pi.registerCommand("judge", {
		description: "Enter Judge aligning mode",
		handler: async (args, ctx) => {
			const resolvedArgs = await resolveJudgeCommandArgs(args, ctx);
			if (resolvedArgs === undefined) return;
			const tokens = resolvedArgs.trim().split(/\s+/).filter(Boolean);
			const action = (tokens[0] ?? "").toLowerCase();
			const name = tokens[1];
			if (action === "align") {
				enableJudge(ctx);
				return;
			}
			if (action === "ack") {
				if (state.phase === "delivering" && state.pendingAckStatus === "pass") {
					// pending ack 路径补 taskbook PASS 沉淀(reviewer Blocker 修复)
					if (state.pendingTaskbookRun) {
						const pending = state.pendingTaskbookRun;
						try {
							await recordTaskbookRun(ctx, {
								name: pending.name,
								spec: pending.spec,
								summary: pending.summary,
								finalVerdict: pending.finalVerdict as JudgeFinalVerdict,
								updateExperience: true,
							});
						} catch (error) {
							ctx.ui.notify(`任务书 "${pending.name}" 沉淀失败: ${error instanceof Error ? error.message : String(error)}`, "warning");
						}
					}
					state = completeJudge(state);
					persistState(pi, state);
					ctx.ui.notify("Judge delivery accepted.", "info");
					clearJudgeDriverWidget(ctx.ui);
					setJudgeStatus(ctx, undefined);
					restoreActiveTools();
					return;
				}
				ctx.ui.notify("No pending PASS Judge delivery to accept.", "warning");
				return;
			}
			if (action === "clarify") {
				if (state.phase !== "aligning") {
					enableJudge(ctx);
					return;
				}
				state = enterAligning(state);
				persistState(pi, state);
				setJudgeStatus(ctx, "⚖ judge");
				pi.sendUserMessage("继续澄清 Judge RequirementsSpec。请优先使用 questionnaire，并重新输出可解析 JSON。", { deliverAs: "followUp" });
				return;
			}
			if (action === "delegate") {
				if (!state.spec) {
					ctx.ui.notify("当前没有可执行的 Judge RequirementsSpec。", "warning");
					return;
				}
				if (!state.aligningQuestionnaireUsed) {
					ctx.ui.notify("Judge 产出 Spec 前未用 questionnaire 确认假设,拒绝委派。", "warning");
					return;
				}
				state = startDriving(state);
				persistState(pi, state);
				await startActiveJudgeDriver(ctx, state.spec);
				return;
			}
			if (action === "change-spec") {
				if (!state.spec) {
					ctx.ui.notify("当前没有可修改的 Judge RequirementsSpec。", "warning");
					return;
				}
				const edited = await ctx.ui.editor("修改当前 Spec", formatRequirementsSpec(state.spec));
				state = enterAligning(state);
				persistState(pi, state);
				setJudgeStatus(ctx, "⚖ judge");
				if (edited?.trim()) {
					pi.sendUserMessage(`按以下修改后的需求继续 Judge aligning：\n\n${edited.trim()}`, { deliverAs: "followUp" });
				}
				return;
			}
			if (action === "toggle") {
				if (isJudgeActive()) {
					disableJudge(ctx);
					return;
				}
				enableJudge(ctx);
				return;
			}
			if (action === "check-bash-window" || action === "check-bash" || action === "bash-window") {
				checkBashLiveLogWindow(ctx);
				return;
			}
			if (action === "save") {
				await handleTaskbookSave(ctx, name);
				return;
			}
			if (action === "run") {
				await handleTaskbookRun(ctx, name);
				return;
			}
			if (action === "edit") {
				await handleTaskbookEdit(ctx, name);
				return;
			}
			if (action === "list") {
				await handleTaskbookList(ctx);
				return;
			}
			enableJudge(ctx);
		},
	});

	pi.on("before_agent_start", async () => {
		if (state.phase !== "aligning") return undefined;
		const content = state.aligningMode === "edit" && state.spec
			? buildEditPrompt(state.spec)
			: ALIGN_PROMPT;
		return {
			message: {
				customType: "judge-align-context",
				content,
				display: false,
			},
		};
	});

	pi.on("context", async (event) => ({
		messages: filterJudgeContextMessages(event.messages, state),
	}));

	pi.on("tool_call", async (event) => {
		// C-2 机制闸:aligning 阶段调过 questionnaire 就置标志,agent_end 时据此判断能否委派。
		if (state.phase === "aligning" && event.toolName === "questionnaire") {
			state = markAligningQuestionnaireUsed(state);
			persistState(pi, state);
		}
		if (state.phase !== "aligning" || event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		if (isSafeCommand(command)) return undefined;

		return {
			block: true,
			reason: `Judge aligning: command blocked (not read-only). Command: ${command}`,
		};
	});

	pi.on("input", async (event, ctx) => {
		if (state.phase !== "driving") return { action: "continue" };
		if (event.source !== "interactive") return { action: "continue" };

		if (!activeDriver) {
			ctx.ui.notify("Driver 未运行,无法转发用户消息。", "warning");
			return { action: "continue" };
		}

		const wrapped = [
			"[USER INTERJECTION during driving]",
			"The user typed the following while you were working. Treat it as authoritative guidance from the user (not a Judge steer). Incorporate it into your current work or revise as needed.",
			"",
			event.text,
		].join("\n");

		try {
			await activeDriver.sendUserInput(wrapped);
			const suffix = event.text.length > 50 ? "..." : "";
			ctx.ui.notify(`已转发用户插话给 Driver: ${event.text.slice(0, 50)}${suffix}`, "info");
		} catch (error) {
			ctx.ui.notify(`转发用户插话给 Driver 失败: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}

		return { action: "handled" };
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const judgeStateEntry = entries
			.filter((entry: { type?: string; customType?: string }) => entry.type === "custom" && entry.customType === "judge-state")
			.pop() as { data?: unknown } | undefined;
		const restored = restoreJudgeState(judgeStateEntry?.data);
		if (!restored) return;

		state = restored;
		if (state.phase === "aligning") {
			restoreToolsSnapshot ??= typeof pi.getActiveTools === "function"
				? pi.getActiveTools()
				: JUDGE_NORMAL_TOOLS;
			pi.setActiveTools(JUDGE_ALIGNING_TOOLS);
			setJudgeStatus(ctx, state.aligningMode === "edit" ? "⚖ edit" : "⚖ judge");
		} else if (state.phase === "driving") {
			restoreToolsSnapshot ??= typeof pi.getActiveTools === "function"
				? pi.getActiveTools()
				: JUDGE_NORMAL_TOOLS;
			pi.setActiveTools(JUDGE_NORMAL_TOOLS);
			setJudgeStatus(ctx, "⚖ driving");
			if (state.spec && !activeDriver) {
				await startActiveJudgeDriver(ctx, state.spec, { background: true });
			}
		} else if (state.phase === "delivering") {
			restoreToolsSnapshot ??= typeof pi.getActiveTools === "function"
				? pi.getActiveTools()
				: JUDGE_NORMAL_TOOLS;
			setJudgeStatus(ctx, "⚖ delivering");
		} else {
			setJudgeStatus(ctx, undefined);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		activeDriver?.dispose();
		activeDriver = undefined;
		activeJudgeVerdictProvider?.dispose();
		activeJudgeVerdictProvider = undefined;
		if (ctx?.ui) clearJudgeDriverWidget(ctx.ui);
		if (ctx?.ui) setJudgeStatus(ctx, undefined);
		restoreActiveTools();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!ctx.hasUI) return;
		if (state.phase === "driving" && state.spec && !activeDriver) {
			await startActiveJudgeDriver(ctx, state.spec);
			return;
		}
		if (state.phase !== "aligning") return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (!lastAssistant) return;

		const spec = extractRequirementsSpec(getTextContent(lastAssistant));
		if (!spec) {
			ctx.ui.notify("Judge did not find a complete RequirementsSpec yet.", "warning");
			return;
		}

		state = setRequirementsSpec(state, spec);
		persistState(pi, state);

		if (state.aligningMode === "edit") {
			if (!state.aligningQuestionnaireUsed) {
				ctx.ui.notify("Judge 产出 Spec 前未用 questionnaire 确认假设,拒绝保存。已让 Judge 回到编辑对齐阶段确认各维度假设。", "warning");
				pi.sendUserMessage("你刚才在编辑任务书时没有调用 questionnaire 确认假设就直接产出了 RequirementsSpec。请立即调用 questionnaire 工具,对照现有 Spec 确认需要保留或修改的点,然后再产出修订后的 Spec。", { deliverAs: "followUp" });
				return;
			}
			const choice = await ctx.ui.select("Judge next step", ["存回任务书", "继续调整", "放弃"]);
			if (!choice) {
				ctx.ui.notify("Judge next step cancelled; edit mode remains active.", "info");
				return;
			}
			if (choice === "存回任务书") {
				await updateTaskbookSpec(getCwd(ctx), state.taskbookName!, state.spec!);
				ctx.ui.notify(`任务书 "${state.taskbookName}" 已更新。`, "info");
				state = completeJudge({ ...state, aligningMode: undefined });
				persistState(pi, state);
				restoreActiveTools();
				setJudgeStatus(ctx, undefined);
				return;
			}
			if (choice === "继续调整") {
				state = setAligningMode(enterAligning(state), "edit");
				persistState(pi, state);
				setJudgeStatus(ctx, "⚖ edit");
				pi.sendUserMessage("用户想继续调整 Spec。请针对用户不满意的地方继续用 questionnaire 确认,然后重新产出 Spec。", { deliverAs: "followUp" });
				return;
			}
			if (choice === "放弃") {
				ctx.ui.notify(`已放弃对任务书 "${state.taskbookName}" 的修改。`, "info");
				state = abortJudge({ ...state, aligningMode: undefined });
				persistState(pi, state);
				restoreActiveTools();
				setJudgeStatus(ctx, undefined);
			}
			return;
		}

		const choice = await ctx.ui.select("Judge next step", JUDGE_MENU_OPTIONS);
		if (!choice) {
			ctx.ui.notify("Judge next step cancelled; aligning remains active.", "info");
			return;
		}
		if (choice === "委派 driver 执行") {
			// C-2 机制闸:aligning 阶段没调过 questionnaire 就选了委派,拒绝,逼 Judge 回去确认假设。
			// 防止 Judge 偷懒跳过 questionnaire 直接拍 Spec(参见 2026-06-19 知乎验证暴露的问题)。
			// 注意:闸只在"委派"时触发;继续澄清/改需求本来就是要回去问,不需要 questionnaire。
			if (!state.aligningQuestionnaireUsed) {
				ctx.ui.notify("Judge 产出 Spec 前未用 questionnaire 确认假设,拒绝委派。已让 Judge 回到对齐阶段确认各维度假设。", "warning");
				pi.sendUserMessage("你刚才在没有调用 questionnaire 确认假设的情况下直接产出了 RequirementsSpec。这违反 ALIGN_PROMPT 的强制要求。请立即调用 questionnaire 工具,把 goal/scope/source/timeliness/format 等维度的假设摆给用户确认或修改,然后再产出 Spec。不要再说\"需求清晰无需澄清\"。", { deliverAs: "followUp" });
				return;
			}
			state = startDriving(state);
			persistState(pi, state);
			await startActiveJudgeDriver(ctx, spec);
			return;
		}

		if (choice === "继续澄清") {
			state = enterAligning(state);
			persistState(pi, state);
			setJudgeStatus(ctx, "⚖ judge");
			pi.sendUserMessage("继续澄清 Judge RequirementsSpec。请优先使用 questionnaire，并重新输出可解析 JSON。", { deliverAs: "followUp" });
			return;
		}

		if (choice === "改需求") {
			const edited = await ctx.ui.editor("改需求", formatRequirementsSpec(spec));
			state = enterAligning(state);
			persistState(pi, state);
			setJudgeStatus(ctx, "⚖ judge");
			if (edited?.trim()) {
				pi.sendUserMessage(`按以下修改后的需求继续 Judge aligning：\n\n${edited.trim()}`, { deliverAs: "followUp" });
			}
		}
	});
}

export default registerJudge;
