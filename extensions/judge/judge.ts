import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { execFileSync, spawn } from "node:child_process";
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
import { resolveBashCommand } from "../doctor/checks.ts";
import registerQuestionnaire from "./questionnaire.ts";

const JUDGE_ALIGNING_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const JUDGE_NORMAL_TOOLS = ["read", "bash", "edit", "write"];
const JUDGE_MENU_OPTIONS = ["委派 driver 执行", "继续澄清", "改需求"];
const JUDGE_COMMAND_MENU_OPTIONS = ["Toggle Judge", "检查 bash 新窗口打开", "Exit"];
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

function quotePowerShellLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function quoteBashLiteral(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildBashLiveLogCommand(liveLogPath: string): string {
	const bashPath = liveLogPath.replace(/\\/g, "/");
	const quotedDir = quoteBashLiteral(path.posix.dirname(bashPath));
	const quotedPath = quoteBashLiteral(bashPath);
	return `mkdir -p ${quotedDir}; touch ${quotedPath}; tail -n +1 -f ${quotedPath}; printf '\\n[Judge live log exited]\\n'; read -r -p 'Press Enter to close...' _`;
}

type WindowsLiveLogLaunchPlan = {
	command: string;
	args: string[];
};

export function buildWindowsLiveLogLaunchPlan(liveLogPath: string, bashExecutable = resolveBashCommand().command): WindowsLiveLogLaunchPlan {
	const bashCommand = buildBashLiveLogCommand(liveLogPath);
	return {
		command: "cmd.exe",
		args: ["/d", "/s", "/c", "start", "\"\"", bashExecutable, "--noprofile", "--norc", "-lc", bashCommand],
	};
}

function spawnDetached(command: string, args: string[], options: { windowsHide?: boolean } = {}): { ok: boolean; error?: string } {
	try {
		const child = spawn(command, args, {
			detached: true,
			stdio: "ignore",
			...options,
		});
		child.once("error", () => {
			// 防止辅助终端启动失败变成未处理错误;同步可捕获失败由返回值表达。
		});
		child.unref();
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

function ensureLiveLogFile(liveLogPath: string): { ok: boolean; error?: string } {
	try {
		mkdirSync(path.dirname(liveLogPath), { recursive: true });
		appendFileSync(liveLogPath, "", "utf8");
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function openPreparedLiveLogTerminal(liveLogPath: string): { ok: boolean; error?: string } {
	const prepared = ensureLiveLogFile(liveLogPath);
	if (!prepared.ok) return prepared;
	return (openLiveLogTerminalForTests ?? openLiveLogTerminal)(liveLogPath);
}

/**
 * 在新终端窗口打开 live.log 的实时跟踪。
 * 零污染主 agent context:过程数据只写文件、只在新终端显示。
 * 跨平台兼容(macOS / Linux / Windows):
 *   - Windows:用 cmd start 打开承载 bash tail 的可见过程终端窗口。
 *   - macOS:osascript 让 Terminal.app 跑 tail(路径转义处理空格)。
 *   - Linux:which 检测可用终端(gnome-terminal -- / konsole -e / xterm -e / x-terminal-emulator),用各自正确的参数语法。
 * 开窗失败不抛错(只返回 error),因为这只是辅助查看,不影响 Judge 主流程。
 */
function openLiveLogTerminal(liveLogPath: string): { ok: boolean; error?: string } {
	try {
		if (process.platform === "win32") {
			// Windows 不写 launcher 文件,通过 cmd start 让系统打开一个可见的独立 bash tail 过程终端。
			const plan = buildWindowsLiveLogLaunchPlan(liveLogPath);
			return spawnDetached(plan.command, plan.args, {
				windowsHide: false,
			});
		}

		if (process.platform === "darwin") {
			// macOS:osascript 指挥 Terminal.app。路径里的双引号和反斜杠转义。
			const escapedPath = liveLogPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
			const script = `tell application "Terminal"
  activate
  do script "tail -f \\"${escapedPath}\\""
end tell`;
			return spawnDetached("osascript", ["-e", script]);
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
		return spawnDetached(term.bin, [sep, "tail", "-f", liveLogPath]);
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

let openLiveLogTerminalForTests:
	| ((liveLogPath: string) => { ok: boolean; error?: string })
	| undefined;

export function setOpenLiveLogTerminalForTests(opener: typeof openLiveLogTerminalForTests): void {
	openLiveLogTerminalForTests = opener;
}

/** 同步检测 Linux 上可用的终端模拟器(预检,避免 spawn 异步错误无法捕获)。 */
function detectLinuxTerminal(): { bin: string } | null {
	const candidates = [
		{ bin: "x-terminal-emulator" }, // Debian 系默认别名
		{ bin: "gnome-terminal" }, // GNOME
		{ bin: "konsole" }, // KDE
		{ bin: "xterm" }, // 兜底,大多装了
	];
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

function formatDeliveryReport(options: {
	status: "PASS" | "FAIL";
	finalVerdict: JudgeFinalVerdict;
	summary: DriverSummary;
	tail: TranscriptTail;
}): string {
	const truncateForDisplay = (value: string, maxLength: number): string => {
		const normalized = value.replace(/\s+/g, " ").trim();
		if (normalized.length <= maxLength) return normalized;
		return `${normalized.slice(0, maxLength - 3)}...`;
	};
	const parseJsonText = (jsonText: string): string => {
		try {
			const value = JSON.parse(jsonText);
			if (Array.isArray(value)) {
				return value
					.map((item) => item && typeof item === "object" && "text" in item ? String((item as { text?: unknown }).text ?? "") : "")
					.filter(Boolean)
					.join("\n");
			}
			if (value && typeof value === "object" && "text" in value) {
				return String((value as { text?: unknown }).text ?? "");
			}
		} catch {
			return "";
		}
		return "";
	};
	const summarizeDisplayText = (value: string, maxLength: number): string => {
		const trimmed = value.trim();
		if (!trimmed) return "";
		const contentMatch = /^content=(\[.*\]|\{.*\})$/s.exec(trimmed);
		if (contentMatch) {
			const parsed = parseJsonText(contentMatch[1]);
			return parsed ? truncateForDisplay(parsed, maxLength) : "工具返回内容已隐藏,完整过程见 live.log";
		}
		if (/^content=\[/.test(trimmed) || /^content=\{/.test(trimmed)) {
			return "工具返回内容已隐藏,完整过程见 live.log";
		}
		return truncateForDisplay(trimmed, maxLength);
	};
	const extractEvidenceArtifacts = (): string[] => {
		const paths = new Set<string>();
		for (const item of options.finalVerdict.evidence) {
			const matches = item.matchAll(/(?:[A-Za-z]:[\\/]|\/)[^\s`"',;，；。)）\]]+\.[A-Za-z0-9]{1,8}/g);
			for (const match of matches) {
				paths.add(match[0]);
			}
		}
		return Array.from(paths).slice(0, 8);
	};
	const formatArtifact = (artifact: DriverSummary["artifacts"][number]): string => `- 📄 ${artifact.path}`;
	const evidenceArtifacts = extractEvidenceArtifacts();
	const outputLines = options.summary.artifacts.length > 0
		? options.summary.artifacts.map(formatArtifact)
		: evidenceArtifacts.length > 0
			? evidenceArtifacts.map((path) => `- 📄 ${path}`)
		: options.tail.assistantOutput.trim()
			? [
				"- driver 未产出文件,以下为 driver 的结果摘要:",
				`  ${summarizeDisplayText(options.tail.assistantOutput, 500)}`,
			]
			: ["- ⚠️ driver 未产出可展示的结果(无文件、无输出摘要)。完整过程见 live.log。"];
	const evidenceLines = options.finalVerdict.evidence.map((item) => `- ${item}`);
	const paths = options.summary.pathsTried;
	const visiblePaths = paths.length > 15
		? [
			...paths.slice(0, 5).map((path, index) => ({ path, index })),
			{ omitted: paths.length - 7 },
			...paths.slice(-2).map((path, offset) => ({ path, index: paths.length - 2 + offset })),
		]
		: paths.map((path, index) => ({ path, index }));
	const pathLines = visiblePaths.length > 0
		? visiblePaths.map((entry) => {
			if ("omitted" in entry) return `... 中间省略 ${entry.omitted} 步,完整过程见 live.log`;
			const state = entry.path.failed ? "✗" : "✓";
			const reason = entry.path.failed ? summarizeDisplayText(entry.path.resultSummary, 80) : "";
			const args = entry.path.failed && entry.path.argsSummary ? `; args: ${summarizeDisplayText(entry.path.argsSummary, 80)}` : "";
			return `${entry.index + 1}. ${entry.path.toolName} ${state}${reason ? ` - ${reason}` : ""}${args}`;
		})
		: ["- (none)"];
	const lines = [
		`${options.status === "PASS" ? "✅" : "❌"} Judge ${options.status}`,
		options.finalVerdict.reason,
		"",
		"📦 产出",
		...outputLines,
	];

	if (evidenceLines.length > 0) {
		lines.push("", "🔍 验收证据", ...evidenceLines);
	}

	lines.push(
		"",
		`🛣️ 走过的路径(${paths.length} 步,steer ${options.summary.steerCount}/5)`,
		...pathLines,
	);

	return lines.join("\n");
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

	function enableJudge(ctx: ExtensionContext): void {
		restoreToolsSnapshot ??= typeof pi.getActiveTools === "function"
			? pi.getActiveTools()
			: JUDGE_NORMAL_TOOLS;
		state = enterAligning(state);
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

	async function resolveJudgeCommandArgs(args: unknown, ctx: ExtensionContext): Promise<string | undefined> {
		const raw = String(args ?? "").trim();
		if (raw) return raw;
		if (!ctx.ui?.select) return "toggle";

		const selection = await ctx.ui.select("Judge", JUDGE_COMMAND_MENU_OPTIONS);
		if (!selection || selection === "Exit") return undefined;
		if (selection === "Toggle Judge") return "toggle";
		if (selection === "检查 bash 新窗口打开") return "check-bash-window";
		return undefined;
	}

	registerQuestionnaire(pi);
	pi.registerTool(judgeCompleteTool);

	pi.registerCommand("judge", {
		description: "Enter Judge aligning mode",
		handler: async (args, ctx) => {
			const resolvedArgs = await resolveJudgeCommandArgs(args, ctx);
			if (resolvedArgs === undefined) return;
			const action = resolvedArgs.trim().toLowerCase();
			if (action === "ack") {
				if (state.phase === "delivering" && state.pendingAckStatus === "pass") {
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
			enableJudge(ctx);
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
			restoreToolsSnapshot ??= typeof pi.getActiveTools === "function"
				? pi.getActiveTools()
				: JUDGE_NORMAL_TOOLS;
			pi.setActiveTools(JUDGE_ALIGNING_TOOLS);
			setJudgeStatus(ctx, "⚖ judge");
		} else if (state.phase === "driving") {
			restoreToolsSnapshot ??= typeof pi.getActiveTools === "function"
				? pi.getActiveTools()
				: JUDGE_NORMAL_TOOLS;
			setJudgeStatus(ctx, "⚖ driving");
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
			setJudgeStatus(ctx, "⚖ driving");
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
							const confirm = (ctx.ui as { confirm?: (message: string) => Promise<boolean> | boolean }).confirm;
							const acknowledged = typeof confirm === "function"
								? await confirm.call(ctx.ui, "Judge PASS. Accept this delivery?")
								: false;
							if (acknowledged) {
								state = completeJudge({ ...state, summary: deliveryReport });
								persistState(pi, state);
								ctx.ui.notify("Judge delivery accepted.", "info");
								clearDriverWidget();
								setJudgeStatus(ctx, undefined);
								restoreActiveTools();
								return { action: "pass", keepWatching: false };
							}
							state = markPendingAck(enterDelivering({ ...state, summary: deliveryReport }), "pass");
							persistState(pi, state);
							setJudgeStatus(ctx, "⚖ delivering");
							clearDriverWidget();
							ctx.ui.notify("Judge delivery is waiting for user acknowledgement. Run /judge ack to accept it later.", "warning");
							return { action: "pass", keepWatching: false };
						}

						if (!canContinueAfterFail) {
							state = enterDelivering({ ...state, summary: deliveryReport });
							persistState(pi, state);
							clearDriverWidget();
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
			if (ctx.hasUI) {
				const liveLogPath = activeDriver.getLiveLogPath?.() ?? path.join(runDir, "live.log");
				const result = openPreparedLiveLogTerminal(liveLogPath);
				if (result.ok) {
					ctx.ui.notify(`已打开过程终端,实时显示:${liveLogPath}`, "info");
				} else {
					ctx.ui.notify(`打开过程终端失败(${result.error})。可手动 tail -f ${liveLogPath}`, "warning");
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
			setJudgeStatus(ctx, "⚖ judge");
			pi.sendUserMessage("继续澄清 Judge RequirementsSpec。请优先使用 questionnaire，并重新输出可解析 JSON。");
			return;
		}

		if (choice === "改需求") {
			const edited = await ctx.ui.editor("改需求", formatRequirementsSpec(spec));
			state = enterAligning(state);
			persistState(pi, state);
			setJudgeStatus(ctx, "⚖ judge");
			if (edited?.trim()) {
				pi.sendUserMessage(`按以下修改后的需求继续 Judge aligning：\n\n${edited.trim()}`);
			}
		}
	});
}

export default registerJudge;
