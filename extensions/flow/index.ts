import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearFlowDriverBanner, setFlowDriverBanner } from "./driver-banner.ts";
import {
	attachFlowDriver,
	detachFlowDriver,
	FLOW_FOCUS_ENTRY_TYPE,
	restoreFlowFocus,
} from "./driver-focus.ts";
import { getDriverPickerOptions, parseDriverPickerSelection } from "./driver-picker.ts";
import { appendDriverFeedback, findDriverSummary, listDriverSummaries } from "./driver-store.ts";
import { formatFlowQueued } from "./formatter.ts";
import { parseFlowCommand } from "./parser.ts";
import { buildFlowHelpText, buildFlowRequestPrompt } from "./prompts.ts";
import type { FlowDriverSummary, FlowFocusState, FlowRequest } from "./types.ts";

const FLOW_CONTEXT_TYPE = "flow-task-context";
const FLOW_CONTEXT_ID_PATTERN = /\[FLOW CONTEXT ID: ([^\]]+)\]/;
const FLOW_PROMPT_PREFIXES = [
	"[FLOW TASK CREATE]",
	"[FLOW TASK PROVE]",
	"[FLOW TASK RUN]",
	"[FLOW TASK REVIEW]",
	"[FLOW STATUS]",
	"[FLOW HELP]",
	"[FLOW DRIVER ATTACH]",
	"[FLOW DRIVER DETACH]",
	"[FLOW DRIVER STATUS]",
];

type ActionableFlowRequest = Exclude<FlowRequest, { kind: "help" } | { kind: "error"; message: string }>;

function isActionableFlowRequest(request: FlowRequest): request is ActionableFlowRequest {
	return request.kind !== "help" && request.kind !== "error";
}

function isFlowPromptText(text: string): boolean {
	const trimmed = text.trimStart();
	return FLOW_PROMPT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function hasFlowPromptMarker(message: AgentMessage): boolean {
	if (message.role !== "user") return false;

	const content = message.content;
	if (typeof content === "string") {
		return isFlowPromptText(content);
	}
	if (Array.isArray(content)) {
		return content.some((block) => block.type === "text" && isFlowPromptText((block as TextContent).text ?? ""));
	}
	return false;
}

function getFlowContextId(message: { content?: unknown; customType?: string }): string | undefined {
	if (message.customType !== FLOW_CONTEXT_TYPE || typeof message.content !== "string") return undefined;
	return message.content.match(FLOW_CONTEXT_ID_PATTERN)?.[1];
}

export function registerFlow(pi: ExtensionAPI): void {
	let nextContextId = 0;
	let activeContextId: string | undefined;
	let focusState: FlowFocusState = { focus: "main" };

	function persistFocus(state: FlowFocusState): void {
		pi.appendEntry(FLOW_FOCUS_ENTRY_TYPE, state);
	}

	function getCwd(ctx: ExtensionContext): string {
		return typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
	}

	function renderFocus(ctx: ExtensionContext, driver?: FlowDriverSummary): void {
		if (focusState.focus === "driver" && driver) {
			setFlowDriverBanner({ taskId: driver.taskId, runId: driver.runId, status: driver.status });
			const statusText = `driver:${driver.runId}`;
			ctx.ui.setStatus?.("flow-driver", ctx.ui.theme?.fg?.("warning", statusText) ?? statusText);
			ctx.ui.setWidget?.("flow-driver-view", [
				`Flow driver: ${driver.taskId}/${driver.runId}`,
				`Status: ${driver.status}`,
				`Step: ${driver.step ?? "-"}`,
			]);
			return;
		}

		clearFlowDriverBanner();
		ctx.ui.setStatus?.("flow-driver", undefined);
		ctx.ui.setWidget?.("flow-driver-view", undefined);
	}

	function attachDriverBySummary(driver: FlowDriverSummary, ctx: ExtensionContext): void {
		focusState = attachFlowDriver(focusState, driver);
		persistFocus(focusState);
		renderFocus(ctx, driver);
		ctx.ui.notify(`Flow driver attached: ${driver.runId}`, "info");
	}

	function getAttachableDrivers(ctx: ExtensionContext): FlowDriverSummary[] {
		return listDriverSummaries(getCwd(ctx)).filter((driver) => driver.status !== "done");
	}

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

			if (request.kind === "attach") {
				if (request.runId) {
					const driver = findDriverSummary(getCwd(ctx), request.runId);
					if (!driver) {
						ctx.ui.notify(`Flow driver not found: ${request.runId}`, "warning");
						return;
					}
					attachDriverBySummary(driver, ctx);
					return;
				}

				const drivers = getAttachableDrivers(ctx);
				if (drivers.length === 0) {
					ctx.ui.notify("No Flow drivers available to attach.", "info");
					return;
				}

				const options = getDriverPickerOptions(drivers);
				const selection = await ctx.ui.select("Select Flow driver", options);
				const driver = parseDriverPickerSelection(selection, drivers);
				if (!driver) {
					ctx.ui.notify("Flow driver attach cancelled.", "info");
					return;
				}
				attachDriverBySummary(driver, ctx);
				return;
			}

			if (request.kind === "detach") {
				focusState = detachFlowDriver(focusState);
				persistFocus(focusState);
				renderFocus(ctx);
				ctx.ui.notify("Flow driver detached.", "info");
				return;
			}

			if (request.kind === "driver-status") {
				const drivers = listDriverSummaries(getCwd(ctx));
				if (drivers.length === 0) {
					ctx.ui.notify("No Flow drivers found.", "info");
					return;
				}
				ctx.ui.notify(
					drivers
						.map((driver) =>
							[
								`${driver.taskId}/${driver.runId}`,
								driver.status,
								driver.step ?? "-",
								driver.summary ?? "-",
							].join("  "),
						)
						.join("\n"),
					"info",
				);
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Flow 请求需要等待当前 agent 空闲后再运行。", "warning");
				return;
			}

			const contextId = `flow-${++nextContextId}`;
			activeContextId = contextId;
			pi.sendMessage(
				{
					customType: FLOW_CONTEXT_TYPE,
					content: `${buildFlowRequestPrompt(request)}\n\n[FLOW CONTEXT ID: ${contextId}]`,
					display: false,
				},
				{ triggerTurn: true },
			);
			ctx.ui.notify(formatFlowQueued(request), "info");
		},
	});

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((message) => {
				const msg = message as AgentMessage & { customType?: string };
				if (msg.customType === FLOW_CONTEXT_TYPE) {
					return activeContextId !== undefined && getFlowContextId(msg) === activeContextId;
				}
				return !hasFlowPromptMarker(msg);
			}),
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager?.getEntries?.() ?? [];
		focusState = restoreFlowFocus(entries);
		if (focusState.focus === "driver") {
			const driver = findDriverSummary(getCwd(ctx), focusState.runId);
			if (driver) {
				renderFocus(ctx, driver);
				return;
			}
		}
		focusState = { focus: "main" };
		renderFocus(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (!event.streamingBehavior) {
			activeContextId = undefined;
		}
		if (event.source === "extension") {
			return { action: "continue" };
		}
		if (event.text.trimStart().startsWith("/")) {
			return { action: "continue" };
		}
		if (focusState.focus !== "driver") {
			return { action: "continue" };
		}

		const driver = findDriverSummary(getCwd(ctx), focusState.runId);
		if (!driver) {
			ctx.ui.notify(`Focused Flow driver not found: ${focusState.runId}`, "warning");
			focusState = detachFlowDriver(focusState);
			persistFocus(focusState);
			renderFocus(ctx);
			return { action: "handled" };
		}

		appendDriverFeedback(driver.runDir, {
			message: event.text,
			driverResponse: "queued to driver",
			affectedStep: driver.step,
		});
		ctx.ui.notify(`Sent to Flow driver ${driver.runId}`, "info");
		return { action: "handled" };
	});
}

export default registerFlow;
