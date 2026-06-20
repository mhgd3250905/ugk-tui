import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionMode, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { DriverTranscriptTail } from "./driver-view.ts";

export interface DriverSessionOptions {
	cwd: string;
	taskId: string;
	runId: string;
	runDir: string;
	initialPrompt: string;
	label?: string;
	expectedToolNames?: string[];
	onTranscriptUpdate?: () => void;
	uiContext?: ExtensionUIContext;
	extensionMode?: ExtensionMode;
	agentDefinitionPath?: string;
}

export type FlowDriverSessionOptions = DriverSessionOptions;

type DriverSessionEvent = {
	type?: string;
	assistantMessageEvent?: {
		type?: string;
		delta?: string;
	};
	message?: {
		role?: string;
		content?: unknown;
	};
	toolName?: string;
	isError?: boolean;
};

export interface DriverSessionLike {
	readonly sessionFile?: string;
	readonly isStreaming: boolean;
	getAllTools?(): Array<{ name: string }>;
	subscribe(listener: (event: DriverSessionEvent) => void): () => void;
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	dispose(): void;
}

export type DriverSessionFactory = (options: DriverSessionOptions) => Promise<{ session: DriverSessionLike }>;

export function createFlowDriverResourceLoaderOptions(options: { cwd: string; agentDir: string; agentDefinitionPath?: string }): {
	cwd: string;
	agentDir: string;
	additionalExtensionPaths: string[];
	agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
} {
	const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const agentDefinitionPath = options.agentDefinitionPath ? path.resolve(options.agentDefinitionPath) : undefined;
	return {
		cwd: options.cwd,
		agentDir: options.agentDir,
		additionalExtensionPaths: [path.join(extensionRoot, "index.ts")],
		agentsFilesOverride: agentDefinitionPath
			? (base) => ({
				agentsFiles: [
					...base.agentsFiles,
					{
						path: agentDefinitionPath,
						content: readFileSync(agentDefinitionPath, "utf8"),
					},
				],
			})
			: undefined,
	};
}

export function assertExpectedDriverTools(session: DriverSessionLike, expectedToolNames: string[] = []): void {
	if (expectedToolNames.length === 0) {
		return;
	}
	const availableToolNames = new Set(session.getAllTools?.().map((tool) => tool.name) ?? []);
	const missing = expectedToolNames.filter((name) => !availableToolNames.has(name));
	if (missing.length > 0) {
		throw new Error(
			`Flow driver environment initialization failed. Missing required capabilities: ${missing.join(", ")}. Please update or restart UGK, then retry.`,
		);
	}
}

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
	options: DriverSessionOptions,
): Promise<{ session: DriverSessionLike }> {
	const agentDir = getAgentDir();
	const resourceLoader = new DefaultResourceLoader(createFlowDriverResourceLoaderOptions({
		cwd: options.cwd,
		agentDir,
		agentDefinitionPath: options.agentDefinitionPath,
	}));
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

export interface DriverSession {
	readonly taskId: string;
	readonly runId: string;
	readonly runDir: string;
	readonly sessionFile?: string;
	readonly visibleSession?: unknown;
	start(): Promise<void>;
	sendUserInput(text: string): Promise<void>;
	ask(text: string): Promise<string>;
	getTranscriptText(): string;
	getWidgetLines(): string[];
	dispose(): void;
}

export type FlowDriverSession = DriverSession;

export async function createDriverSession(
	options: DriverSessionOptions,
	factory: DriverSessionFactory = defaultDriverSessionFactory,
): Promise<DriverSession> {
	const { session } = await factory(options);
	assertExpectedDriverTools(session, options.expectedToolNames);
	const transcript = new DriverTranscriptTail();
	const activeCaptures: Array<{ chunks: string[] }> = [];
	const unsubscribe = session.subscribe((event) => {
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent?.type === "text_delta" &&
			typeof event.assistantMessageEvent.delta === "string"
		) {
			transcript.appendText(event.assistantMessageEvent.delta);
			for (const capture of activeCaptures) {
				capture.chunks.push(event.assistantMessageEvent.delta);
			}
			options.onTranscriptUpdate?.();
			return;
		}
		if (event.type === "message_end") {
			const text = getAssistantMessageText(event);
			for (const capture of activeCaptures) {
				if (capture.chunks.length === 0 && text) {
					capture.chunks.push(text);
				}
			}
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
		async ask(text: string) {
			const capture = { chunks: [] as string[] };
			activeCaptures.push(capture);
			try {
				if (session.isStreaming) {
					await session.steer(text);
				} else {
					await session.prompt(text);
				}
				return capture.chunks.join("");
			} finally {
				const index = activeCaptures.indexOf(capture);
				if (index >= 0) {
					activeCaptures.splice(index, 1);
				}
			}
		},
		getTranscriptText() {
			return transcript.toText();
		},
		getWidgetLines() {
			return transcript.toWidgetLines(options.label ?? `Flow driver ${options.taskId}/${options.runId}`);
		},
		dispose() {
			unsubscribe();
			session.dispose();
		},
	};
}

export const createFlowDriverSession = createDriverSession;
