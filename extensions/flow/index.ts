import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { clearFlowDriverBanner, setFlowDriverBanner } from "./driver-banner.ts";
import {
	attachFlowDriver,
	detachFlowDriver,
	FLOW_FOCUS_ENTRY_TYPE,
	restoreFlowFocus,
} from "./driver-focus.ts";
import { getDriverPickerOptions, parseDriverPickerSelection } from "./driver-picker.ts";
import { createFlowDriverSession, type FlowDriverSession } from "./driver-session.ts";
import {
	appendDriverFeedback,
	buildDriverInitialPrompt,
	createRunArtifacts,
	listDriverSummaries,
	nextRunId,
	writeDriverStatus,
} from "./driver-store.ts";
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
const REQUIRED_TASK_FILES = ["task.json", "SKILL.md", "todo.template.md", "validator.md"];

type ActionableFlowRequest = Exclude<FlowRequest, { kind: "help" } | { kind: "error"; message: string }>;
type TaskGuardResult =
	| { ok: true; taskDir: string; status: string | undefined }
	| { ok: false; message: string; type: "warning" | "error" };

function isActionableFlowRequest(request: FlowRequest): request is ActionableFlowRequest {
	return request.kind !== "help" && request.kind !== "error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

function getDriverKey(taskId: string, runId: string): string {
	return `${taskId}/${runId}`;
}

function readTaskMetadata(cwd: string, taskId: string): TaskGuardResult {
	const taskDir = path.join(cwd, ".flow", "tasks", taskId);
	const taskJsonPath = path.join(taskDir, "task.json");
	if (!existsSync(taskJsonPath)) {
		return { ok: false, message: `Flow task not found: ${taskId}`, type: "error" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(taskJsonPath, "utf8"));
	} catch (error) {
		return {
			ok: false,
			message: `Flow task metadata is invalid: ${taskJsonPath}\n${errorMessage(error)}`,
			type: "error",
		};
	}

	return {
		ok: true,
		taskDir,
		status: isRecord(parsed) && typeof parsed.status === "string" ? parsed.status : undefined,
	};
}

function validateTaskForDriver(kind: "prove" | "run", cwd: string, taskId: string): TaskGuardResult {
	const task = readTaskMetadata(cwd, taskId);
	if (!task.ok) {
		return task;
	}

	if (kind === "prove") {
		const missingFiles = REQUIRED_TASK_FILES.filter((file) => !existsSync(path.join(task.taskDir, file)));
		if (missingFiles.length > 0) {
			return {
				ok: false,
				message: `Flow task ${taskId} is incomplete. Missing required file(s): ${missingFiles.join(", ")}`,
				type: "error",
			};
		}
		return task;
	}

	if (task.status !== "verified" && task.status !== "active") {
		return {
			ok: false,
			message: `Flow task ${taskId} status is ${task.status ?? "unknown"}; /flow run requires verified/active.`,
			type: "warning",
		};
	}
	return task;
}

let driverSessionFactoryForTests:
	| ((options: Parameters<typeof createFlowDriverSession>[0]) => Promise<FlowDriverSession>)
	| undefined;

export function setFlowDriverSessionFactoryForTests(factory: typeof driverSessionFactoryForTests): void {
	driverSessionFactoryForTests = factory;
}

export function registerFlow(pi: ExtensionAPI): void {
	let nextContextId = 0;
	let activeContextId: string | undefined;
	let focusState: FlowFocusState = { focus: "main" };
	const liveDrivers = new Map<string, FlowDriverSession>();

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
		ctx.ui.notify(`Flow driver attached: ${driver.taskId}/${driver.runId}`, "info");
	}

	async function startDriverForTask(
		kind: "prove" | "run",
		taskId: string,
		input: string | undefined,
		ctx: ExtensionContext,
	): Promise<void> {
		const cwd = getCwd(ctx);
		const guard = validateTaskForDriver(kind, cwd, taskId);
		if (!guard.ok) {
			ctx.ui.notify(guard.message, guard.type);
			return;
		}

		const runId = nextRunId(cwd, taskId);
		const artifacts = createRunArtifacts(cwd, taskId, input, runId);
		const initialPrompt = buildDriverInitialPrompt(artifacts);
		const createDriver = driverSessionFactoryForTests ?? createFlowDriverSession;
		const driverKey = getDriverKey(taskId, runId);
		let driver: FlowDriverSession;
		try {
			driver = await createDriver({
				cwd,
				taskId,
				runId,
				runDir: artifacts.runDir,
				initialPrompt,
			});
		} catch (error) {
			const summary = errorMessage(error);
			writeDriverStatus(artifacts.runDir, {
				taskId,
				runId,
				status: "failed",
				step: "driver session",
				summary,
			});
			ctx.ui.notify(`Flow driver failed: ${driverKey}\n${summary}`, "error");
			return;
		}
		liveDrivers.set(driverKey, driver);
		writeDriverStatus(artifacts.runDir, {
			taskId,
			runId,
			status: "running",
			step: "starting",
			summary: `${kind} driver running`,
			sessionFile: driver.sessionFile,
		});
		ctx.ui.setWidget?.("flow-driver-view", driver.getWidgetLines(), { placement: "aboveEditor" });
		void driver.start().catch((error) => {
			const summary = errorMessage(error);
			writeDriverStatus(artifacts.runDir, {
				taskId,
				runId,
				status: "failed",
				step: "driver start",
				summary,
				sessionFile: driver.sessionFile,
			});
			liveDrivers.delete(driverKey);
			driver.dispose();
			ctx.ui.notify(`Flow driver failed: ${driverKey}\n${summary}`, "error");
		});
		ctx.ui.notify(`Flow driver running: ${driverKey}\nAttach: /flow attach ${driverKey}`, "info");
	}

	function findDriverForAttach(ctx: ExtensionContext, target: string): FlowDriverSummary | undefined {
		const drivers = listDriverSummaries(getCwd(ctx));
		const matches = target.includes("/")
			? drivers.filter((driver) => `${driver.taskId}/${driver.runId}` === target)
			: drivers.filter((driver) => driver.runId === target);

		if (matches.length === 0) {
			ctx.ui.notify(`Flow driver not found: ${target}`, "warning");
			return undefined;
		}
		if (matches.length > 1) {
			ctx.ui.notify(
				`Flow driver run id is ambiguous: ${target}. Use /flow attach and select a driver.`,
				"warning",
			);
			return undefined;
		}
		return matches[0];
	}

	function findDriverForFocus(ctx: ExtensionContext): FlowDriverSummary | undefined {
		if (focusState.focus !== "driver") {
			return undefined;
		}

		const drivers = listDriverSummaries(getCwd(ctx));
		if (focusState.taskId) {
			return drivers.find((driver) => driver.taskId === focusState.taskId && driver.runId === focusState.runId);
		}

		const matches = drivers.filter((driver) => driver.runId === focusState.runId);
		return matches.length === 1 ? matches[0] : undefined;
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
					const driver = findDriverForAttach(ctx, request.runId);
					if (!driver) {
						return;
					}
					attachDriverBySummary(driver, ctx);
					return;
				}

				const drivers = listDriverSummaries(getCwd(ctx));
				if (drivers.length === 0) {
					ctx.ui.notify("No Flow drivers available to attach.", "info");
					return;
				}

				const now = new Date();
				const options = getDriverPickerOptions(drivers, now);
				const selection = await ctx.ui.select("Select Flow driver", options);
				const driver = parseDriverPickerSelection(selection, drivers, now);
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

			if (request.kind === "task-prove") {
				await startDriverForTask("prove", request.taskId, request.input, ctx);
				return;
			}
			if (request.kind === "task-run") {
				await startDriverForTask("run", request.taskId, request.input, ctx);
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
			const driver = findDriverForFocus(ctx);
			if (driver) {
				renderFocus(ctx, driver);
				return;
			}
			focusState = { focus: "main" };
			persistFocus(focusState);
			renderFocus(ctx);
			return;
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

		const driver = findDriverForFocus(ctx);
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
		const liveDriver = liveDrivers.get(getDriverKey(driver.taskId, driver.runId));
		if (!liveDriver) {
			ctx.ui.notify(`Flow driver ${driver.runId} is recoverable but not live in this process. Feedback was recorded.`, "warning");
			return { action: "handled" };
		}
		try {
			await liveDriver.sendUserInput(event.text);
		} catch (error) {
			const summary = errorMessage(error);
			appendDriverFeedback(driver.runDir, {
				message: event.text,
				driverResponse: `delivery failed: ${summary}`,
				affectedStep: driver.step,
			});
			writeDriverStatus(driver.runDir, {
				taskId: driver.taskId,
				runId: driver.runId,
				status: "failed",
				step: driver.step ?? "input delivery",
				summary,
				sessionFile: liveDriver.sessionFile,
			});
			liveDrivers.delete(getDriverKey(driver.taskId, driver.runId));
			liveDriver.dispose();
			renderFocus(ctx, { ...driver, status: "failed", summary });
			ctx.ui.notify(`Flow driver input delivery failed: ${driver.taskId}/${driver.runId}\n${summary}`, "warning");
			return { action: "handled" };
		}
		ctx.ui.setWidget?.("flow-driver-view", liveDriver.getWidgetLines(), { placement: "aboveEditor" });
		ctx.ui.notify(`Sent to Flow driver ${driver.runId}`, "info");
		return { action: "handled" };
	});

	pi.on("session_shutdown", async () => {
		for (const driver of liveDrivers.values()) driver.dispose();
		liveDrivers.clear();
	});
}

export default registerFlow;
