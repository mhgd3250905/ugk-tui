import path from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { DriverTranscriptTail } from "./driver-view.ts";

export interface FlowDriverSessionOptions {
	cwd: string;
	taskId: string;
	runId: string;
	runDir: string;
	initialPrompt: string;
}

type DriverSessionEvent = {
	type?: string;
	assistantMessageEvent?: {
		type?: string;
		delta?: string;
	};
};

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

export async function defaultDriverSessionFactory(
	options: FlowDriverSessionOptions,
): Promise<{ session: DriverSessionLike }> {
	const agentDir = getAgentDir();
	const resourceLoader = new DefaultResourceLoader({ cwd: options.cwd, agentDir });
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir,
		resourceLoader,
		sessionManager: SessionManager.create(options.cwd, path.join(options.runDir, "session")),
	});

	return { session };
}

export interface FlowDriverSession {
	readonly taskId: string;
	readonly runId: string;
	readonly runDir: string;
	readonly sessionFile?: string;
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
		}
	});

	return {
		taskId: options.taskId,
		runId: options.runId,
		runDir: options.runDir,
		sessionFile: session.sessionFile,
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
