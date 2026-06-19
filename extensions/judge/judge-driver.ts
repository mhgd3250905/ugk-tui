import type { ExtensionMode, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
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

function wrapFactoryForJudgeEvents(
	factory: DriverSessionFactory,
	handleEvent: (event: DriverSessionEvent) => void,
): DriverSessionFactory {
	return async (options) => {
		const result = await factory(options);
		const session = result.session;
		const wrapped: DriverSessionLike = {
			...session,
			subscribe(listener) {
				return session.subscribe((event) => {
					listener(event);
					handleEvent(event);
				});
			},
		};
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
	const transcriptEvents: DriverSessionEvent[] = [];
	let wakeupQueue = Promise.resolve();
	const decide = opts.onWakeup ?? defaultWakeup;

	function enqueueWakeup(reason: string, toolName?: string): void {
		if (!watching || disposed) return;
		wakeupQueue = wakeupQueue
			.catch(() => undefined)
			.then(async () => {
				if (!watching || disposed) return;
				try {
					const snapshot = cloneSummary(summary);
					const tail = extractTail(transcriptEvents);
					const verdict = await decide({
						reason,
						toolName,
						summary: snapshot,
						tail,
						transcript: driver?.getTranscriptText() ?? "",
						decidePrompt: buildDecidePrompt(opts.spec, snapshot, tail),
					});

					if (verdict.action === "pass") {
						watching = verdict.keepWatching;
						return;
					}
					if (verdict.action === "steer") {
						summary.steerCount += 1;
						if (summary.steerCount >= maxSteer) {
							watching = false;
							const escalationSummary = cloneSummary(summary);
							await opts.onEscalate?.({
								reason: `maxSteer reached (${summary.steerCount}/${maxSteer})`,
								summary: escalationSummary,
								tail,
								transcript: driver?.getTranscriptText() ?? "",
							});
							return;
						}
						watching = verdict.keepWatching;
						await driver?.sendUserInput(verdict.direction);
						return;
					}

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

		if (event.type === "agent_start") {
			summary.turnCount += 1;
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
	};
}
