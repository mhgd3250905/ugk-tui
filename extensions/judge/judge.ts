import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
	setRequirementsSpec,
	startDriving,
	type DriverSummary,
	type JudgeState,
	type RequirementsSpec,
} from "./judge-state.ts";
import { ALIGN_PROMPT, buildDecidePrompt, buildFinalizePrompt } from "./judge-prompts.ts";
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
import registerQuestionnaire from "./questionnaire.ts";

const JUDGE_ALIGNING_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const JUDGE_MENU_OPTIONS = ["委派 driver 执行", "继续澄清", "改需求"];
const JUDGE_PHASES = new Set(["aligning", "driving", "delivering", "aborted", "done"]);
const JUDGE_DRIVER_WIDGET_KEY = "judge-driver-view";

/** 把 Judge verdict 格式化成 widget 用的单行文本。 */
function formatJudgeVerdictLine(verdict: { action: string; direction?: string; reason?: string; keepWatching?: boolean }): string {
	if (verdict.action === "pass") {
		return verdict.keepWatching === false ? "PASS" : "PASS (keepWatching)";
	}
	if (verdict.action === "steer") {
		return `STEER: ${verdict.direction ?? "(no direction)"}`;
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

function quotePowerShellLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

export function buildWindowsLiveLogLauncher(liveLogPath: string): { path: string; content: string } {
	const launcherPath = path.join(path.dirname(liveLogPath), "judge-live-launcher.cmd");
	return {
		path: launcherPath,
		content: [
			"@echo off",
			`powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -LiteralPath ${quotePowerShellLiteral(liveLogPath)} -Wait"`,
			"pause",
			"",
		].join("\r\n"),
	};
}

export function buildWindowsLiveLogLaunchPlan(
	liveLogPath: string,
	env: Record<string, string | undefined> = process.env,
): { command: string; args: string[]; launcher?: { path: string; content: string } } {
	if (env.WT_SESSION) {
		return {
			command: "wt.exe",
			args: [
				"new-tab",
				"--title",
				"Judge driver live",
				"powershell.exe",
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				`Get-Content -LiteralPath ${quotePowerShellLiteral(liveLogPath)} -Wait`,
			],
		};
	}

	const launcher = buildWindowsLiveLogLauncher(liveLogPath);
	return {
		command: "cmd.exe",
		args: ["/c", "start", "Judge driver live", launcher.path],
		launcher,
	};
}

/**
 * 在新终端窗口打开 live.log 的实时跟踪(tail -f / Get-Content -Wait)。
 * 零污染主 agent context:过程数据只写文件、只在新终端显示。
 * 跨平台兼容(macOS / Linux / Windows):
 *   - Windows Terminal:用 wt.exe new-tab 直接跑 PowerShell tail。
 *   - Windows conhost:写项目内 .cmd 批处理文件(避免多层引号嵌套),用 start 开独立窗口跑。
 *   - macOS:osascript 让 Terminal.app 跑 tail(路径转义处理空格)。
 *   - Linux:which 检测可用终端(gnome-terminal -- / konsole -e / xterm -e / x-terminal-emulator),用各自正确的参数语法。
 * 开窗失败不抛错(只返回 error),因为这只是辅助查看,不影响 Judge 主流程。
 */
function openLiveLogTerminal(liveLogPath: string): { ok: boolean; error?: string } {
	try {
		if (process.platform === "win32") {
			// Windows Terminal 里优先开 new-tab；非 WT 回退 conhost + 项目内 launcher.cmd。
			const plan = buildWindowsLiveLogLaunchPlan(liveLogPath);
			if (plan.launcher) {
				mkdirSync(path.dirname(plan.launcher.path), { recursive: true });
				writeFileSync(plan.launcher.path, plan.launcher.content, "utf8");
			}
			spawn(plan.command, plan.args, {
				detached: true,
				stdio: "ignore",
				windowsHide: false,
				shell: false,
			}).unref();
			return { ok: true };
		}

		if (process.platform === "darwin") {
			// macOS:osascript 指挥 Terminal.app。路径里的双引号和反斜杠转义。
			const escapedPath = liveLogPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
			const script = `tell application "Terminal"
  activate
  do script "tail -f \\"${escapedPath}\\""
end tell`;
			spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref();
			return { ok: true };
		}

		// Linux:同步检测可用终端(预检避免 spawn 异步 ENOENT 无法捕获的问题)。
		const term = detectLinuxTerminal();
		if (!term) {
			return { ok: false, error: "no supported terminal emulator found (tried x-terminal-emulator, gnome-terminal, konsole, xterm)" };
		}
		// 各终端的"执行命令"参数语法不同:
		//   gnome-terminal: -- <cmd> <args>
		//   konsole: -e <cmd> <args>
		//   xterm: -e <cmd> <args>
		//   x-terminal-emulator: -e <cmd> <args>(Debian 系别名,语法同 -e)
		const sep = term.bin === "gnome-terminal" ? "--" : "-e";
		spawn(term.bin, [sep, "tail", "-f", liveLogPath], {
			detached: true,
			stdio: "ignore",
		}).unref();
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** 同步检测 Linux 上可用的终端模拟器(预检,避免 spawn 异步错误无法捕获)。 */
function detectLinuxTerminal(): { bin: string } | null {
	const candidates = [
		{ bin: "x-terminal-emulator" }, // Debian 系默认别名
		{ bin: "gnome-terminal" }, // GNOME
		{ bin: "konsole" }, // KDE
		{ bin: "xterm" }, // 兜底,大多装了
	];
	const { execFileSync } = require("node:child_process") as { execFileSync: (cmd: string, args: string[]) => string };
	const which = process.platform === "win32" ? "where" : "which";
	for (const c of candidates) {
		try {
			execFileSync(which, [c.bin], { stdio: "ignore" });
			return c;
		} catch {
			// 这个终端没装,试下一个
		}
	}
	return null;
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

function sliceNewTranscript(before: string, after: string): string {
	return after.startsWith(before) ? after.slice(before.length) : after;
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
			const before = judgeSession.getTranscriptText();
			await judgeSession.sendUserInput(decidePrompt);
			const after = judgeSession.getTranscriptText();
			const currentTurn = sliceNewTranscript(before, after);
			const verdict = parseJudgeVerdict(currentTurn);
			return verdict ?? {
				action: "abort",
				reason: "Judge verdict parse failed",
			};
		},
		async finalize(context) {
			const judgeSession = await getSession();
			const finalizePrompt = context.finalizePrompt || buildFinalizePrompt(options.specText, context.summary, context.tail);
			const before = judgeSession.getTranscriptText();
			await judgeSession.sendUserInput(finalizePrompt);
			const after = judgeSession.getTranscriptText();
			const currentTurn = sliceNewTranscript(before, after);
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

function formatDeliveryReport(options: {
	status: "PASS" | "FAIL";
	finalVerdict: JudgeFinalVerdict;
	summary: DriverSummary;
	tail: TranscriptTail;
}): string {
	const artifactLines = options.summary.artifacts.length > 0
		? options.summary.artifacts.map((artifact) => `- ${artifact.kind}: ${artifact.path}`)
		: ["(none)"];
	const pathLines = options.summary.pathsTried.length > 0
		? options.summary.pathsTried.map((path, index) => {
			const state = path.failed ? "failed" : "ok";
			return `${index + 1}. ${path.toolName} ${state}; args=${path.argsSummary || "(none)"}; result=${path.resultSummary || "(none)"}`;
		})
		: ["(none)"];
	const evidenceLines = options.finalVerdict.evidence.length > 0
		? options.finalVerdict.evidence.map((item) => `- ${item}`)
		: ["(none)"];

	return [
		`Judge final verdict: ${options.status}`,
		`Reason: ${options.finalVerdict.reason}`,
		"",
		"artifacts:",
		...artifactLines,
		"",
		"pathsTried:",
		...pathLines,
		"",
		"evidence:",
		...evidenceLines,
		"",
		"DriverSummary:",
		JSON.stringify(options.summary, null, "\t"),
		"",
		"TranscriptTail:",
		JSON.stringify(options.tail, null, "\t"),
	].join("\n");
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
		aligningQuestionnaireUsed: record.aligningQuestionnaireUsed === true,
	};
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

	registerQuestionnaire(pi);
	pi.registerTool(judgeCompleteTool);

	pi.registerCommand("judge", {
		description: "Enter Judge aligning mode",
		handler: async (args, ctx) => {
			if (String(args ?? "").trim().toLowerCase() === "ack") {
				if (state.phase === "delivering" && state.pendingAckStatus === "pass") {
					state = completeJudge(state);
					persistState(pi, state);
					ctx.ui.notify("Judge delivery accepted.", "info");
					clearJudgeDriverWidget(ctx.ui);
					return;
				}
				ctx.ui.notify("No pending PASS Judge delivery to accept.", "warning");
				return;
			}
			state = enterAligning(state);
			pi.setActiveTools(JUDGE_ALIGNING_TOOLS);
			ctx.ui.notify(`Judge aligning mode enabled. Tools: ${JUDGE_ALIGNING_TOOLS.join(", ")}`, "info");
			persistState(pi, state);
		},
	});

	pi.on("before_agent_start", async () => {
		if (state.phase !== "aligning") return undefined;
		return {
			message: {
				customType: "judge-align-context",
				content: ALIGN_PROMPT,
				display: false,
			},
		};
	});

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

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const judgeStateEntry = entries
			.filter((entry: { type?: string; customType?: string }) => entry.type === "custom" && entry.customType === "judge-state")
			.pop() as { data?: unknown } | undefined;
		const restored = restoreJudgeState(judgeStateEntry?.data);
		if (!restored) return;

		state = restored;
		if (state.phase === "aligning") {
			pi.setActiveTools(JUDGE_ALIGNING_TOOLS);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		activeDriver?.dispose();
		activeDriver = undefined;
		activeJudgeVerdictProvider?.dispose();
		activeJudgeVerdictProvider = undefined;
		if (ctx?.ui) clearJudgeDriverWidget(ctx.ui);
	});

	pi.on("agent_end", async (event, ctx) => {
		if (state.phase !== "aligning" || !ctx.hasUI) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (!lastAssistant) return;

		const spec = extractRequirementsSpec(getTextContent(lastAssistant));
		if (!spec) {
			ctx.ui.notify("Judge did not find a complete RequirementsSpec yet.", "warning");
			return;
		}

		state = setRequirementsSpec(state, spec);
		persistState(pi, state);

		const choice = await ctx.ui.select("Judge next step", JUDGE_MENU_OPTIONS);
		if (choice === "委派 driver 执行") {
			// C-2 机制闸:aligning 阶段没调过 questionnaire 就选了委派,拒绝,逼 Judge 回去确认假设。
			// 防止 Judge 偷懒跳过 questionnaire 直接拍 Spec(参见 2026-06-19 知乎验证暴露的问题)。
			// 注意:闸只在"委派"时触发;继续澄清/改需求本来就是要回去问,不需要 questionnaire。
			if (!state.aligningQuestionnaireUsed) {
				ctx.ui.notify("Judge 产出 Spec 前未用 questionnaire 确认假设,拒绝委派。已让 Judge 回到对齐阶段确认各维度假设。", "warning");
				pi.sendUserMessage("你刚才在没有调用 questionnaire 确认假设的情况下直接产出了 RequirementsSpec。这违反 ALIGN_PROMPT 的强制要求。请立即调用 questionnaire 工具,把 goal/scope/source/timeliness/format 等维度的假设摆给用户确认或修改,然后再产出 Spec。不要再说\"需求清晰无需澄清\"。");
				return;
			}
			state = startDriving(state);
			persistState(pi, state);
			activeDriver?.dispose();
			clearJudgeDriverWidget(ctx.ui); // 清理上一轮 driver 的 widget,新一轮会重建
			const runId = `judge-${Date.now()}`;
			const specText = formatRequirementsSpec(spec);
			const initialPrompt = [
				"[JUDGE DRIVER TASK]",
				"Execute the following RequirementsSpec. When complete, call the judge_complete tool.",
				"",
				specText,
			].join("\n");
			const createDriver = judgeDriverFactoryForTests ?? createJudgeDriver;
			const cwd = getCwd(ctx);
			const runDir = path.join(cwd, ".judge", runId);

			// ---- driver 过程可视化 widget ----
			// 搬 Flow 的 setWidget + onTranscriptUpdate 机制,实时显示 driver 过程 + Judge 判定。
			// 常量 JUDGE_DRIVER_WIDGET_KEY、formatJudgeVerdictLine、clearJudgeDriverWidget 在模块顶层。
			let lastWidgetSnapshot = "";
			let lastJudgeVerdictLine = "";
			let transcriptRefreshQueued = false;

			function clearDriverWidget() {
				lastWidgetSnapshot = "";
				lastJudgeVerdictLine = "";
				clearJudgeDriverWidget(ctx.ui);
			}

			function refreshDriverWidget() {
				transcriptRefreshQueued = false;
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
					},
					async onFinalize(context) {
						const canContinueAfterFail = state.keepWatching && context.summary.steerCount < state.maxSteer;
						state = enterDelivering(state);
						persistState(pi, state);
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
							const confirm = (ctx.ui as { confirm?: (message: string) => Promise<boolean> | boolean }).confirm;
							const acknowledged = typeof confirm === "function"
								? await confirm.call(ctx.ui, "Judge PASS. Accept this delivery?")
								: false;
							if (acknowledged) {
								state = completeJudge({ ...state, summary: deliveryReport });
								persistState(pi, state);
								ctx.ui.notify("Judge delivery accepted.", "info");
								clearDriverWidget();
								return { action: "pass", keepWatching: false };
							}
							state = markPendingAck(enterDelivering({ ...state, summary: deliveryReport }), "pass");
							persistState(pi, state);
							ctx.ui.notify("Judge delivery is waiting for user acknowledgement. Run /judge ack to accept it later.", "warning");
							return { action: "pass", keepWatching: false };
						}

						if (!canContinueAfterFail) {
							state = enterDelivering({ ...state, summary: deliveryReport });
							persistState(pi, state);
							ctx.ui.notify(`Judge final delivery failed and cannot continue automatically: ${finalVerdict.reason}`, "warning");
							return { action: "pass", keepWatching: false };
						}

						state = startDriving({ ...state, summary: deliveryReport });
						persistState(pi, state);
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
			// 委派后弹菜单:要不要开新终端实时看 driver + Judge 过程(零污染主 agent context)。
			if (ctx.hasUI) {
				const viewChoice = await ctx.ui.select("Judge driver 即将开始。是否打开过程查看终端?", [
					"打开(新窗口实时显示 driver + Judge 工作过程)",
					"不打开(只在主界面看 widget)",
				]);
				if (viewChoice.startsWith("打开")) {
					const result = openLiveLogTerminal(activeDriver.getLiveLogPath());
					if (result.ok) {
						ctx.ui.notify(`已打开过程终端,实时显示:${activeDriver.getLiveLogPath()}`, "info");
					} else {
						ctx.ui.notify(`打开过程终端失败(${result.error})。可手动 tail -f ${activeDriver.getLiveLogPath()}`, "warning");
					}
				}
			}
			await activeDriver.start();
			refreshDriverWidget(); // driver 起来后立即显示一次 widget
			ctx.ui.notify("Judge driver started.", "info");
			return;
		}

		if (choice === "继续澄清") {
			state = enterAligning(state);
			persistState(pi, state);
			pi.sendUserMessage("继续澄清 Judge RequirementsSpec。请优先使用 questionnaire，并重新输出可解析 JSON。");
			return;
		}

		if (choice === "改需求") {
			const edited = await ctx.ui.editor("改需求", formatRequirementsSpec(spec));
			state = enterAligning(state);
			persistState(pi, state);
			if (edited?.trim()) {
				pi.sendUserMessage(`按以下修改后的需求继续 Judge aligning：\n\n${edited.trim()}`);
			}
		}
	});
}

export default registerJudge;
