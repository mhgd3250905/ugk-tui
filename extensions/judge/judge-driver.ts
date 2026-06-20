import type { ExtensionMode, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createDriverSession,
	defaultDriverSessionFactory,
	type DriverSession,
	type DriverSessionFactory,
	type DriverSessionLike,
} from "../shared/driver-session.ts";
import { buildDecidePrompt } from "./judge-prompts.ts";
import type { DriverSummary } from "./judge-state.ts";
import {
	extractArtifactsFromToolInput,
	extractTail,
	summarizeToolArgs,
	summarizeToolResult,
	type JudgeVerdict,
	type TranscriptTail,
} from "./judge-utils.ts";

type DriverSessionEvent = {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
	};
	assistantMessageEvent?: {
		type?: string;
		delta?: string;
	};
	toolName?: string;
	isError?: boolean;
	input?: unknown;
	result?: unknown;
	output?: unknown;
};

export interface JudgeWakeupContext {
	reason: string;
	toolName?: string;
	summary: DriverSummary;
	tail: TranscriptTail;
	transcript: string;
	decidePrompt: string;
}

export interface JudgeDriverOptions {
	cwd: string;
	runDir: string;
	spec: string;
	initialPrompt?: string;
	taskId?: string;
	runId?: string;
	sessionFactory?: DriverSessionFactory;
	onWakeup?: (context: JudgeWakeupContext) => Promise<JudgeVerdict> | JudgeVerdict;
	maxSteer?: number;
	onEscalate?: (context: JudgeEscalationContext) => Promise<void> | void;
	uiContext?: ExtensionUIContext;
	extensionMode?: ExtensionMode;
	/** driver transcript 有更新时回调(用于刷新可视化 widget)。 */
	onTranscriptUpdate?: () => void;
	/** Judge 每次 wakeup 产出 verdict 后回调(用于把判定显示到 UI)。 */
	onJudgeVerdict?: (verdict: JudgeVerdict) => void;
}

export interface JudgeEscalationContext {
	reason: string;
	summary: DriverSummary;
	tail: TranscriptTail;
	transcript: string;
}

export interface JudgeDriverHandle {
	start(): Promise<void>;
	dispose(): void;
	getSummary(): DriverSummary;
	/** driver transcript 的 widget 行(格式化好的尾部,直接喂 setWidget)。 */
	getWidgetLines(): string[];
	/** driver 累积的完整 transcript 文本(截断到 DriverTranscriptTail 上限)。 */
	getTranscriptText(): string;
	/** live.log 文件路径(外部终端可 tail -f 实时查看 driver + Judge 过程)。 */
	getLiveLogPath(): string;
}

export const JUDGE_WAKEUP_TOOL_NAMES = new Set(["chrome_cdp", "bash", "write", "edit"]);
export const DRIVER_AGENT_DEFINITION_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"agents",
	"driver.md",
);

function cloneSummary(summary: DriverSummary): DriverSummary {
	return {
		pathsTried: summary.pathsTried.map((path) => ({ ...path })),
		artifacts: summary.artifacts.map((artifact) => ({ ...artifact })),
		lastError: summary.lastError,
		turnCount: summary.turnCount,
		steerCount: summary.steerCount,
		completed: summary.completed,
		aborted: summary.aborted,
		abortReason: summary.abortReason,
	};
}

function addArtifacts(summary: DriverSummary, artifacts: Array<{ path: string; kind: string }>): void {
	const existing = new Set(summary.artifacts.map((artifact) => `${artifact.kind}:${artifact.path}`));
	for (const artifact of artifacts) {
		const key = `${artifact.kind}:${artifact.path}`;
		if (existing.has(key)) continue;
		existing.add(key);
		summary.artifacts.push(artifact);
	}
}

function findLatestPath(summary: DriverSummary, toolName: string): DriverSummary["pathsTried"][number] | undefined {
	for (let index = summary.pathsTried.length - 1; index >= 0; index -= 1) {
		const path = summary.pathsTried[index];
		if (path.toolName === toolName && path.resultSummary === "") return path;
	}
	return undefined;
}

function upsertToolResult(summary: DriverSummary, event: DriverSessionEvent): void {
	if (!event.toolName) return;
	const path = findLatestPath(summary, event.toolName) ?? {
		toolName: event.toolName,
		argsSummary: "",
		resultSummary: "",
		failed: false,
	};
	if (!summary.pathsTried.includes(path)) {
		summary.pathsTried.push(path);
	}
	path.resultSummary = summarizeToolResult(event.result ?? event.output);
	path.failed = event.isError === true;
}

function defaultWakeup(): JudgeVerdict {
	return { action: "pass", keepWatching: true };
}

function formatError(toolName?: string): string {
	return toolName ? `${toolName} failed` : "tool execution failed";
}

function formatWakeupError(error: unknown): string {
	if (error instanceof Error && error.message) {
		return `judge wakeup failed: ${error.message}`;
	}
	return `judge wakeup failed: ${String(error)}`;
}

function indentContinuation(text: string): string {
	return text.replace(/\n/g, "\n           ");
}

function getAssistantMessageText(event: DriverSessionEvent): string {
	if (event.type !== "message_end") return "";
	if (event.message?.role !== "assistant") return "";
	const content = event.message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object" || Array.isArray(block)) return "";
			const record = block as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

/** 把 driver 事件格式化成 live.log 的一行。message_update(text_delta)太碎不写,返回空串跳过。 */
function formatEventLine(event: DriverSessionEvent): string {
	if (event.type === "agent_start") return "[T] driver turn started";
	if (event.type === "agent_end") return "[T] driver turn ended";
	if (event.type === "tool_execution_start") {
		const args = summarizeToolArgs(event.input);
		return [`[tool] ${event.toolName ?? "(tool)"} | started`, args ? `           args: ${indentContinuation(args)}` : ""]
			.filter(Boolean)
			.join("\n");
	}
	if (event.type === "tool_execution_end") {
		const status = event.isError ? "FAILED" : "completed";
		const result = summarizeToolResult(event.result ?? event.output);
		return [`[tool] ${event.toolName ?? "(tool)"} | ${status}`, result ? `           result: ${indentContinuation(result)}` : ""]
			.filter(Boolean)
			.join("\n");
	}
	if (event.type === "message_end") {
		const text = getAssistantMessageText(event);
		return text ? `[driver] ${text}` : "";
	}
	// message_update / 其他:不写(避免逐 token 刷屏)
	return "";
}

/** 把 Judge verdict 格式化成 live.log 的一行。 */
function formatJudgeVerdictForLog(verdict: { action: string; direction?: string; reason?: string }): string {
	if (verdict.action === "pass") return `PASS${verdict.reason ? ` - ${verdict.reason}` : ""}`;
	if (verdict.action === "steer") {
		const direction = verdict.direction ?? "(no direction)";
		return `STEER: ${direction}${verdict.reason ? ` - ${verdict.reason}` : ""}`;
	}
	if (verdict.action === "parse_failed") return `PARSE_FAILED: ${verdict.reason ?? "(no reason)"}`;
	return `ABORT: ${verdict.reason ?? "(no reason)"}`;
}

function wrapFactoryForJudgeEvents(
	factory: DriverSessionFactory,
	handleEvent: (event: DriverSessionEvent) => void,
): DriverSessionFactory {
	return async (options) => {
		const result = await factory(options);
		const session = result.session;
		// 用 Proxy 透传,只覆盖 subscribe 把事件喂给 Judge。
		// 不能用 {...session} 展开 —— 会丢掉 prototype 上的方法(getAllTools/prompt/steer/dispose 等),
		// 导致 assertExpectedDriverTools 的 getAllTools 返回空,误报 "Missing judge_complete"。
		const wrapped: DriverSessionLike = new Proxy(session as object, {
			get(target, property, receiver) {
				if (property === "subscribe") {
					return function subscribe(listener: (event: DriverSessionEvent) => void) {
						return session.subscribe((event) => {
							listener(event);
							handleEvent(event);
						});
					};
				}
				const value = Reflect.get(target as object, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as unknown as DriverSessionLike;
		return { session: wrapped };
	};
}

export async function createJudgeDriver(opts: JudgeDriverOptions): Promise<JudgeDriverHandle> {
	const summary: DriverSummary = {
		pathsTried: [],
		artifacts: [],
		turnCount: 0,
		steerCount: 0,
		completed: false,
	};
	const maxSteer = opts.maxSteer ?? 5;
	let driver: DriverSession | undefined;
	let disposed = false;
	let watching = true;
	let completionStarted = false;
	let consecutiveParseFailures = 0;
	const transcriptEvents: DriverSessionEvent[] = [];
	let wakeupQueue = Promise.resolve();
	const decide = opts.onWakeup ?? defaultWakeup;

	// live.log:把每个 driver 事件 append 到 <runDir>/live.log,供外部终端 tail -f 实时查看。
	// 零污染主 agent context(不进 state.messages)。写入失败不影响 Judge 主流程。
	const liveLogPath = path.join(opts.runDir, "live.log");
	function writeLiveLog(line: string): void {
		if (!line) return; // 空行(如 message_update)跳过
		try {
			const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
			appendFileSync(liveLogPath, `[${ts}] ${line}\n`);
		} catch {
			// 写日志失败不影响 Judge 主流程
		}
	}

	function enqueueWakeup(reason: string, toolName?: string): void {
		if (!watching || disposed) return;
		const snapshot = cloneSummary(summary);
		const tail = extractTail(transcriptEvents);
		const transcript = driver?.getTranscriptText() ?? "";
		const decidePrompt = buildDecidePrompt(opts.spec, snapshot, tail);
		wakeupQueue = wakeupQueue
			.catch(() => undefined)
			.then(async () => {
				if (!watching || disposed) return;
				try {
					const verdict = await decide({
						reason,
						toolName,
						summary: snapshot,
						tail,
						transcript,
						decidePrompt,
					});

					// 把 Judge 判定报给 UI(用于可视化),在副作用执行前就报,保证 UI 即时。
					writeLiveLog(`[Judge] ${formatJudgeVerdictForLog(verdict)}`);
					try {
						opts.onJudgeVerdict?.(verdict);
					} catch {
						// UI 回调失败不影响 Judge 主流程
					}

					if (verdict.action === "pass") {
						consecutiveParseFailures = 0;
						watching = verdict.keepWatching;
						return;
					}
					if (verdict.action === "steer") {
						consecutiveParseFailures = 0;
						summary.steerCount += 1;
						if (summary.steerCount >= maxSteer) {
							watching = false;
							const escalationSummary = cloneSummary(summary);
							await opts.onEscalate?.({
								reason: `maxSteer reached (${summary.steerCount}/${maxSteer})`,
								summary: escalationSummary,
								tail,
								transcript,
							});
							return;
						}
						watching = verdict.keepWatching;
						await driver?.sendUserInput(verdict.direction);
						return;
					}
					if (verdict.action === "parse_failed") {
						consecutiveParseFailures += 1;
						if (consecutiveParseFailures >= maxSteer) {
							watching = false;
							const escalationSummary = cloneSummary(summary);
							await opts.onEscalate?.({
								reason: `parse failures reached (${consecutiveParseFailures}/${maxSteer})`,
								summary: escalationSummary,
								tail,
								transcript,
							});
							return;
						}
						watching = verdict.keepWatching;
						return;
					}

					consecutiveParseFailures = 0;
					summary.aborted = true;
					summary.abortReason = verdict.reason;
					watching = false;
					disposed = true;
					driver?.dispose();
				} catch (error) {
					summary.lastError = formatWakeupError(error);
				}
			});
	}

	function handleEvent(event: DriverSessionEvent): void {
		transcriptEvents.push(event);
		if (transcriptEvents.length > 200) {
			transcriptEvents.splice(0, transcriptEvents.length - 200);
		}

		// 实时写 live.log(供外部终端 tail -f)。
		writeLiveLog(formatEventLine(event));

		if (event.type === "agent_start") {
			summary.turnCount += 1;
			completionStarted = false;
			summary.completed = false;
			return;
		}
		if (event.type === "agent_end") {
			if (completionStarted || !summary.completed) {
				enqueueWakeup("agent_end");
			}
			return;
		}
		if (!event.toolName) return;

		if (event.type === "tool_execution_start") {
			summary.pathsTried.push({
				toolName: event.toolName,
				argsSummary: summarizeToolArgs(event.input),
				resultSummary: "",
				failed: false,
			});
			addArtifacts(summary, extractArtifactsFromToolInput(event.toolName, event.input));
			if (event.toolName === "judge_complete") {
				completionStarted = true;
				return;
			}
			if (JUDGE_WAKEUP_TOOL_NAMES.has(event.toolName)) {
				enqueueWakeup("guarded_tool_start", event.toolName);
			}
			return;
		}

		if (event.type === "tool_execution_end") {
			upsertToolResult(summary, event);
			if (event.toolName === "judge_complete") {
				completionStarted = false;
				if (event.isError) {
					summary.lastError = formatError(event.toolName);
					enqueueWakeup("tool_error", event.toolName);
					return;
				}
				summary.completed = true;
				enqueueWakeup("judge_complete", event.toolName);
				return;
			}
			if (event.isError) {
				summary.lastError = formatError(event.toolName);
				enqueueWakeup("tool_error", event.toolName);
			}
		}
	}

	const factory = wrapFactoryForJudgeEvents(opts.sessionFactory ?? defaultDriverSessionFactory, handleEvent);
	driver = await createDriverSession(
		{
			cwd: opts.cwd,
			taskId: opts.taskId ?? "judge-driver",
			runId: opts.runId ?? "run-001",
			runDir: opts.runDir,
			initialPrompt: opts.initialPrompt ?? opts.spec,
			label: "Judge driver",
			expectedToolNames: ["judge_complete"],
			uiContext: opts.uiContext,
			extensionMode: opts.extensionMode,
			agentDefinitionPath: DRIVER_AGENT_DEFINITION_PATH,
			onTranscriptUpdate: opts.onTranscriptUpdate,
		},
		factory,
	);

	return {
		async start() {
			await driver?.start();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			watching = false;
			driver?.dispose();
		},
		getSummary() {
			return cloneSummary(summary);
		},
		getWidgetLines() {
			return driver?.getWidgetLines() ?? ["(driver not started)"];
		},
		getTranscriptText() {
			return driver?.getTranscriptText() ?? "";
		},
		getLiveLogPath() {
			return liveLogPath;
		},
	};
}
