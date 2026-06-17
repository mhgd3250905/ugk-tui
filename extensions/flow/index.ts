import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatFlowQueued } from "./formatter.ts";
import { parseFlowCommand } from "./parser.ts";
import { buildFlowHelpText, buildFlowRequestPrompt } from "./prompts.ts";
import type { FlowRequest } from "./types.ts";

const FLOW_CONTEXT_TYPE = "flow-task-context";

type ActionableFlowRequest = Exclude<FlowRequest, { kind: "help" } | { kind: "error"; message: string }>;

function isActionableFlowRequest(request: FlowRequest): request is ActionableFlowRequest {
	return request.kind !== "help" && request.kind !== "error";
}

function hasFlowTaskMarker(message: AgentMessage): boolean {
	if (message.role !== "user") return false;

	const content = message.content;
	if (typeof content === "string") {
		return content.includes("[FLOW TASK");
	}
	if (Array.isArray(content)) {
		return content.some((block) => block.type === "text" && (block as TextContent).text?.includes("[FLOW TASK"));
	}
	return false;
}

export function registerFlow(pi: ExtensionAPI): void {
	let pendingRequest: ActionableFlowRequest | undefined;

	pi.registerCommand("flow", {
		description: "Queue Flow task workflow requests",
		handler: async (args, ctx) => {
			const request = parseFlowCommand(args);

			if (request.kind === "help") {
				ctx.ui.notify(buildFlowHelpText(), "info");
				return;
			}
			if (!isActionableFlowRequest(request)) {
				ctx.ui.notify(request.message, "error");
				return;
			}

			pendingRequest = request;
			ctx.ui.notify(formatFlowQueued(request), "info");
		},
	});

	pi.on("context", async (event) => {
		if (pendingRequest) return;

		return {
			messages: event.messages.filter((message) => {
				const msg = message as AgentMessage & { customType?: string };
				if (msg.customType === FLOW_CONTEXT_TYPE) return false;
				return !hasFlowTaskMarker(msg);
			}),
		};
	});

	pi.on("before_agent_start", async () => {
		if (!pendingRequest) return;

		const request = pendingRequest;
		pendingRequest = undefined;

		return {
			message: {
				customType: FLOW_CONTEXT_TYPE,
				content: buildFlowRequestPrompt(request),
				display: false,
			},
		};
	});
}

export default registerFlow;
