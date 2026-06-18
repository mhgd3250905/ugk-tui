import path from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionMode, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DriverTranscriptTail } from "./driver-view.ts";

export interface FlowDriverSessionOptions {
	cwd: string;
	taskId: string;
	runId: string;
	runDir: string;
	initialPrompt: string;
	onTranscriptUpdate?: () => void;
	uiContext?: ExtensionUIContext;
	extensionMode?: ExtensionMode;
}

type DriverSessionEvent = {
	type?: string;
	assistantMessageEvent?: {
		type?: string;
		delta?: string;
	};
	toolName?: string;
	isError?: boolean;
};

const DIRECT_CHROME_CDP_PATTERNS = [
	/\bws:\/\/(?:127\.0\.0\.1|localhost):\d+\/devtools\//i,
	/\bhttps?:\/\/(?:127\.0\.0\.1|localhost):\d+\/json\/(?:version|list|new|activate|close)\b/i,
	/\/devtools\/(?:page|browser)\b/i,
	/\bwebSocketDebuggerUrl\b/i,
];

export interface DriverSessionLike {
	readonly sessionFile?: string;
	readonly isStreaming: boolean;
	subscribe(listener: (event: DriverSessionEvent) => void): () => void;
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	dispose(): void;
}

export type DriverSessionFactory = (options: FlowDriverSessionOptions) => Promise<{ session: DriverSessionLike }>;

function formatRuntimeEvent(event: DriverSessionEvent): string | undefined {
	if (event.type === "agent_start") {
		return "[runtime] driver turn started";
	}
	if (event.type === "agent_end") {
		return "[runtime] driver turn ended";
	}
	if (event.type === "tool_execution_start" && event.toolName) {
		return `[tool] ${event.toolName} started`;
	}
	if (event.type === "tool_execution_end" && event.toolName) {
		return `[tool] ${event.toolName} ${event.isError ? "failed" : "completed"}`;
	}
	return undefined;
}

function collectStringValues(value: unknown, output: string[] = []): string[] {
	if (typeof value === "string") {
		output.push(value);
		return output;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectStringValues(item, output);
		}
		return output;
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value as Record<string, unknown>)) {
			collectStringValues(item, output);
		}
	}
	return output;
}

export function shouldBlockDirectChromeCdpAccess(event: { toolName: string; input: Record<string, unknown> }): boolean {
	if (event.toolName === "chrome_cdp") {
		return false;
	}
	if (event.toolName !== "bash" && event.toolName !== "write" && event.toolName !== "edit") {
		return false;
	}
	return collectStringValues(event.input).some((text) =>
		DIRECT_CHROME_CDP_PATTERNS.some((pattern) => pattern.test(text))
	);
}

function createFlowDriverCdpGuardExtension(): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.on("tool_call", async (event) => {
			if (!shouldBlockDirectChromeCdpAccess(event)) {
				return undefined;
			}
			return {
				block: true,
				reason:
					"Flow driver blocked direct Chrome CDP endpoint access. Use the chrome_cdp tool for local logged-in Chrome operations instead of raw websocket/json endpoints.",
			};
		});
	};
}

const SUPPRESSED_DRIVER_UI_METHODS = new Set<PropertyKey>([
	"setStatus",
	"setWorkingMessage",
	"setWorkingVisible",
	"setWorkingIndicator",
	"setHiddenThinkingLabel",
	"setWidget",
	"setFooter",
	"setHeader",
	"setTitle",
	"pasteToEditor",
	"setEditorText",
	"addAutocompleteProvider",
	"setEditorComponent",
	"setTheme",
	"setToolsExpanded",
]);

export function createFlowDriverUiContext(parentUi: ExtensionUIContext, driverLabel: string): ExtensionUIContext {
	return new Proxy({} as ExtensionUIContext, {
		get(_target, property) {
			if (SUPPRESSED_DRIVER_UI_METHODS.has(property)) {
				return () => {};
			}
			if (property === "notify") {
				return (message: string, type?: "info" | "warning" | "error") =>
					parentUi.notify(`[Flow driver ${driverLabel}] ${message}`, type);
			}

			const parentValue = (parentUi as any)[property];
			if (typeof parentValue === "function") {
				return parentValue.bind(parentUi);
			}
			if (parentValue !== undefined) {
				return parentValue;
			}

			if (property === "select" || property === "input" || property === "editor" || property === "custom") {
				return async () => undefined;
			}
			if (property === "confirm") {
				return async () => false;
			}
			if (property === "getEditorText") {
				return () => "";
			}
			if (property === "getAllThemes") {
				return () => [];
			}
			if (property === "getTheme") {
				return () => undefined;
			}
			if (property === "getToolsExpanded") {
				return () => false;
			}

			return undefined;
		},
	});
}

export async function defaultDriverSessionFactory(
	options: FlowDriverSessionOptions,
): Promise<{ session: DriverSessionLike }> {
	const agentDir = getAgentDir();
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir,
		extensionFactories: [createFlowDriverCdpGuardExtension()],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir,
		resourceLoader,
		sessionManager: SessionManager.create(options.cwd, path.join(options.runDir, "session")),
	});
	await session.bindExtensions({
		mode: options.extensionMode ?? "print",
		uiContext: options.uiContext,
		commandContextActions: {
			waitForIdle: () => session.agent.waitForIdle(),
			newSession: async () => ({ cancelled: true }),
			fork: async () => ({ cancelled: true }),
			navigateTree: async () => ({ cancelled: true }),
			switchSession: async () => ({ cancelled: true }),
			reload: async () => {
				await session.reload();
			},
		},
		onError: (error) => {
			options.uiContext?.notify(
				`[Flow driver ${options.taskId}/${options.runId}] Extension error (${error.extensionPath}): ${error.error}`,
				"warning",
			);
		},
	});

	return { session };
}

export interface FlowDriverSession {
	readonly taskId: string;
	readonly runId: string;
	readonly runDir: string;
	readonly sessionFile?: string;
	readonly visibleSession?: unknown;
	start(): Promise<void>;
	sendUserInput(text: string): Promise<void>;
	getTranscriptText(): string;
	getWidgetLines(): string[];
	dispose(): void;
}

export async function createFlowDriverSession(
	options: FlowDriverSessionOptions,
	factory: DriverSessionFactory = defaultDriverSessionFactory,
): Promise<FlowDriverSession> {
	const { session } = await factory(options);
	const transcript = new DriverTranscriptTail();
	const unsubscribe = session.subscribe((event) => {
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent?.type === "text_delta" &&
			typeof event.assistantMessageEvent.delta === "string"
		) {
			transcript.appendText(event.assistantMessageEvent.delta);
			options.onTranscriptUpdate?.();
			return;
		}

		const runtimeLine = formatRuntimeEvent(event);
		if (runtimeLine) {
			transcript.appendLine(runtimeLine);
			options.onTranscriptUpdate?.();
		}
	});

	return {
		taskId: options.taskId,
		runId: options.runId,
		runDir: options.runDir,
		sessionFile: session.sessionFile,
		visibleSession: session,
		async start() {
			await session.prompt(options.initialPrompt);
		},
		async sendUserInput(text: string) {
			if (session.isStreaming) {
				await session.steer(text);
				return;
			}
			await session.prompt(text);
		},
		getTranscriptText() {
			return transcript.toText();
		},
		getWidgetLines() {
			return transcript.toWidgetLines(`Flow driver ${options.taskId}/${options.runId}`);
		},
		dispose() {
			unsubscribe();
			session.dispose();
		},
	};
}
