import type { ExtensionMode, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	createDriverSession,
	defaultDriverSessionFactory,
	type DriverSession,
	type DriverSessionFactory,
	type DriverSessionLike,
} from "../shared/driver-session.ts";
import { buildDecidePrompt } from "./judge-prompts.ts";
import type { DriverSummary } from "./judge-state.ts";
import type { JudgeVerdict } from "./judge-utils.ts";

type DriverSessionEvent = {
	type?: string;
	assistantMessageEvent?: {
		type?: string;
		delta?: string;
	};
	toolName?: string;
	isError?: boolean;
};

export interface JudgeWakeupContext {
	reason: string;
	toolName?: string;
	summary: DriverSummary;
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
	uiContext?: ExtensionUIContext;
	extensionMode?: ExtensionMode;
}

export interface JudgeDriverHandle {
	start(): Promise<void>;
	dispose(): void;
	getSummary(): DriverSummary;
}

export const JUDGE_WAKEUP_TOOL_NAMES = new Set(["chrome_cdp", "bash", "write", "edit"]);

function cloneSummary(summary: DriverSummary): DriverSummary {
	return {
		pathsTried: [...summary.pathsTried],
		lastError: summary.lastError,
		turnCount: summary.turnCount,
		completed: summary.completed,
		aborted: summary.aborted,
		abortReason: summary.abortReason,
	};
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
		turnCount: 0,
		completed: false,
	};
	let driver: DriverSession | undefined;
	let disposed = false;
	let watching = true;
	let completionStarted = false;
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
					const verdict = await decide({
						reason,
						toolName,
						summary: snapshot,
						transcript: driver?.getTranscriptText() ?? "",
						decidePrompt: buildDecidePrompt(opts.spec, snapshot),
					});

					if (verdict.action === "pass") {
						watching = verdict.keepWatching;
						return;
					}
					if (verdict.action === "steer") {
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
			summary.pathsTried.push(event.toolName);
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
