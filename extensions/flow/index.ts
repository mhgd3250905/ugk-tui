import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
	buildFlowConsoleOptions,
	buildFlowTaskActionOptions,
	buildFlowTaskListOptions,
	buildFlowStageGateOptions,
	parseFlowConsoleSelection,
	parseFlowStageGateSelection,
	type FlowStageGate,
} from "./flow-console.ts";
import { FLOW_FOCUS_ENTRY_TYPE } from "./driver-focus.ts";
import { getDriverPickerOptions, parseDriverPickerSelection } from "./driver-picker.ts";
import { createDriverView } from "./driver-viewport.ts";
import { createFlowDriverSession, createFlowDriverUiContext, type FlowDriverSession } from "./driver-session.ts";
import {
	appendDriverFeedback,
	buildDriverInitialPrompt,
	createRunArtifacts,
	listDriverSummaries,
	nextRunId,
	readDriverStatus,
	writeDriverStatus,
} from "./driver-store.ts";
import { formatFlowQueued } from "./formatter.ts";
import { lockTaskAssets, type FlowWriteGuard } from "./flow-write-guard.ts";
import { autoMigrateIfNeeded, resignAllRecords } from "./flow-resign.ts";
import { closeMigrationWindow } from "./task-store.ts";
import {
	isTransientDriverStatus,
	readTaskMetadata,
	validateTaskForDriver,
	type TaskGuardResult,
} from "./lifecycle-gates.ts";
import { parseFlowCommand } from "./parser.ts";
import {
	buildFlowDriverContractRepairPrompt,
	buildFlowHelpText,
	buildFlowRequestPrompt,
	buildFlowTaskContractRepairPrompt,
	buildFlowTaskReviewPrompt,
} from "./prompts.ts";
import { acceptReview, rejectReview, startReview, type ReviewActionOutcome } from "./review-actions.ts";
import { isFlowReviewAccepted, readFlowReview } from "./review-store.ts";
import { readFlowRunValidation, validateFlowRun } from "./run-validation.ts";
import { validateFlowTaskAssets } from "./task-validation.ts";
import { deleteFlowTask, readFlowTask, updateFlowTaskStatus } from "./task-store.ts";
import { transition } from "./task-state.ts";
import type { FlowDriverStatus, FlowDriverSummary, FlowFocusState, FlowRequest } from "./types.ts";

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
const FLOW_DRIVER_CRITICAL_TOOL_NAMES = ["chrome_cdp"];

type ActionableFlowRequest = Exclude<FlowRequest, { kind: "help" } | { kind: "error"; message: string }>;

function isActionableFlowRequest(request: FlowRequest): request is ActionableFlowRequest {
	return request.kind !== "help" && request.kind !== "error";
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

let driverSessionFactoryForTests:
	| ((options: Parameters<typeof createFlowDriverSession>[0]) => Promise<FlowDriverSession>)
	| undefined;

export function setFlowDriverSessionFactoryForTests(factory: typeof driverSessionFactoryForTests): void {
	driverSessionFactoryForTests = factory;
}

export function registerFlow(pi: ExtensionAPI): void {
	let nextContextId = 0;
	let activeContextId: string | undefined;
	const liveDrivers = new Map<string, FlowDriverSession>();
	const retainedDrivers = new Map<string, FlowDriverSession>();
	// driver 执行期间的 task 资产只读锁,按 driverKey 索引。
	// 所有 driver 终态(dispose/clear/shutdown)都必须释放对应 guard,否则文件永久只读。
	const writeGuards = new Map<string, FlowWriteGuard>();
	let pendingCreateTaskIds: Set<string> | undefined;
	let pendingTaskAssetRepair: { taskId: string; attempts: number } | undefined;

	function persistFocus(state: FlowFocusState): void {
		pi.appendEntry(FLOW_FOCUS_ENTRY_TYPE, state);
	}

	function getCwd(ctx: ExtensionContext): string {
		return typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
	}

	/** 释放某 driver 的 task 资产只读锁。幂等;所有 driver 终态路径都应调用。 */
	function releaseWriteGuard(driverKey: string): void {
		const guard = writeGuards.get(driverKey);
		if (guard) {
			guard.unlock();
			writeGuards.delete(driverKey);
		}
	}

	// Driver 视图层:持有 focusState/sessionView 状态,封装 banner/widget/switcher 编排。
	// 通过回调解耦进程表(liveDrivers/retainedDrivers),UI 层不耦合进程管理。
	const driverView = createDriverView({
		getSession: (driverKey) => liveDrivers.get(driverKey) ?? retainedDrivers.get(driverKey),
		isLiveSession: (driverKey) => liveDrivers.has(driverKey),
		getViewableDrivers: () => {
			const drivers = [...liveDrivers.values()];
			for (const [driverKey, driver] of retainedDrivers) {
				if (!liveDrivers.has(driverKey)) {
					drivers.push(driver);
				}
			}
			return drivers;
		},
		listSummaries: (cwd) => listDriverSummaries(cwd),
		persistFocus,
		getDriverKey,
	});

	function getExpectedDriverToolNames(ctx: ExtensionContext): string[] {
		const available = new Set(ctx.getAllTools?.().map((tool) => tool.name) ?? []);
		return FLOW_DRIVER_CRITICAL_TOOL_NAMES.filter((name) => available.has(name));
	}

	function listConsoleTasks(cwd: string): Array<{ id: string; status?: string }> {
		const tasksDir = path.join(cwd, ".flow", "tasks");
		if (!existsSync(tasksDir)) {
			return [];
		}
		return readdirSync(tasksDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => readFlowTask(cwd, entry.name))
			.filter((task): task is NonNullable<ReturnType<typeof readFlowTask>> => task !== undefined)
			.map((task) => ({ id: task.id, status: task.status }))
			.sort((a, b) => a.id.localeCompare(b.id));
	}

	function listConsoleDrivers(cwd: string): Array<FlowDriverSummary & { reviewStatus?: string }> {
		return listDriverSummaries(cwd).map((driver) => ({
			...driver,
			reviewStatus: readFlowReview(driver.runDir)?.status,
		}));
	}

	async function resolveConsoleCommand(args: string, ctx: ExtensionContext): Promise<string | undefined> {
		if (args.trim()) {
			return args;
		}
		const cwd = getCwd(ctx);
		const tasks = listConsoleTasks(cwd);
		const options = buildFlowConsoleOptions({
			tasks,
		});
		const selection = await ctx.ui.select("Flow", options.map((option) => option.label));
		const option = parseFlowConsoleSelection(selection);
		if (!option?.command) {
			return undefined;
		}
		if (option.command === "task create") {
			const goal = await ctx.ui.input("Create Flow task", "Describe the goal");
			return goal?.trim() ? `task create ${JSON.stringify(goal.trim())}` : undefined;
		}
		if (option.command === "tasks") {
			const taskOptions = buildFlowTaskListOptions(tasks);
			const taskSelection = await ctx.ui.select("Flow tasks", taskOptions.map((taskOption) => taskOption.label));
			const taskOption = taskOptions.find((candidate) => candidate.label === taskSelection && candidate.command);
			const taskId = taskOption?.command?.match(/^task select (.+)$/)?.[1];
			if (!taskId) {
				return undefined;
			}
			const task = tasks.find((candidate) => candidate.id === taskId);
			if (!task) {
				ctx.ui.notify(`Flow task not found: ${taskId}`, "warning");
				return undefined;
			}
			const actionOptions = buildFlowTaskActionOptions({
				task,
				drivers: listConsoleDrivers(cwd),
			});
			const actionSelection = await ctx.ui.select(`Flow task: ${task.id}`, actionOptions.map((actionOption) => actionOption.label));
			return parseFlowConsoleSelection(actionSelection)?.command;
		}
		return option.command;
	}

	async function runStageGate(ctx: ExtensionContext, gate: FlowStageGate): Promise<boolean> {
		const options = buildFlowStageGateOptions(gate);
		const selection = await ctx.ui.select("Flow next step", options.map((option) => option.label));
		const selected = parseFlowStageGateSelection(selection, gate);
		if (!selected?.command) {
			return false;
		}
		const request = parseFlowCommand(selected.command);
		if (!isActionableFlowRequest(request)) {
			return false;
		}
		if (request.kind === "task-review") {
			startCompletedFlowReview(ctx, request.runId);
			return true;
		}
		if (request.kind === "task-run") {
			await startDriverForTask("run", request.taskId, request.input, ctx);
			return true;
		}
		if (request.kind === "task-prove") {
			await startDriverForTask("prove", request.taskId, request.input, ctx);
			return true;
		}
		return false;
	}

	function queueFlowContextPrompt(prompt: string): void {
		const contextId = `flow-${++nextContextId}`;
		activeContextId = contextId;
		pi.sendMessage(
			{
				customType: FLOW_CONTEXT_TYPE,
				content: `${prompt}\n\n[FLOW CONTEXT ID: ${contextId}]`,
				display: false,
			},
			{ triggerTurn: true },
		);
	}

	function queueTaskAssetRepair(ctx: ExtensionContext, taskId: string, issues: string[]): void {
		const attempts = pendingTaskAssetRepair?.taskId === taskId ? pendingTaskAssetRepair.attempts + 1 : 1;
		pendingTaskAssetRepair = { taskId, attempts };
		queueFlowContextPrompt(buildFlowTaskContractRepairPrompt({ taskId, issues }));
		ctx.ui.notify(`Flow task contract failed for ${taskId}; asking main agent to repair task assets.`, "warning");
	}

	// driver UI 编排已迁入 driver-view.ts(driverView)。下列为转发薄封装,
	// 保留原函数名以避免改动散落各处的调用点;行为与原实现一致。
	function renderMainDriverActivity(ctx: ExtensionContext): void {
		driverView.refreshActivity(ctx);
	}

	function clearFocusedDriver(ctx: ExtensionContext, options?: { skipSessionViewDetach?: boolean }): void {
		driverView.clear(ctx, options);
	}

	function renderFocus(
		ctx: ExtensionContext,
		driver?: FlowDriverSummary,
		options?: { skipSessionViewDetach?: boolean },
	): void {
		driverView.refreshFocus(ctx, driver, options);
	}

	function attachDriverBySummary(driver: FlowDriverSummary, ctx: ExtensionContext): void {
		driverView.focus(driver, ctx);
	}

	function updateSessionSwitcher(ctx: ExtensionContext): void {
		driverView.updateSwitcher(ctx);
	}

	async function startDriverForTask(
		kind: "prove" | "run",
		taskId: string,
		input: string | undefined,
		ctx: ExtensionContext,
	): Promise<void> {
		const cwd = getCwd(ctx);
		if (kind === "prove") {
			const task = readTaskMetadata(cwd, taskId);
			if (!task.ok) {
				ctx.ui.notify(task.message, task.type);
				return;
			}
			const assetValidation = validateFlowTaskAssets(cwd, taskId);
			if (!assetValidation.ok) {
				queueTaskAssetRepair(ctx, taskId, assetValidation.issues);
				return;
			}
		}
		const guard = validateTaskForDriver(kind, cwd, taskId);
		if (!guard.ok) {
			ctx.ui.notify(guard.message, guard.type);
			return;
		}

		const runId = nextRunId(cwd, taskId);
		const artifacts = createRunArtifacts(cwd, taskId, input, runId);
		if (kind === "prove") {
			const proveStart = transition(cwd, taskId, {
				kind: "prove-start",
				runId,
			});
			if (!proveStart.ok) {
				ctx.ui.notify(proveStart.reason, "error");
				return;
			}
		}
		const initialPrompt = buildDriverInitialPrompt(artifacts);
		const createDriver = driverSessionFactoryForTests ?? createFlowDriverSession;
		const driverKey = getDriverKey(taskId, runId);
		let driver: FlowDriverSession | undefined;
		let transcriptRefreshQueued = false;
		const isCurrentFocusedDriver = () =>
			driverView.focusState.focus === "driver" &&
			driverView.focusState.runId === runId &&
			(driverView.focusState.taskId === undefined || driverView.focusState.taskId === taskId);
		const scheduleTranscriptWidgetRefresh = () => {
			if (driverView.focusState.focus !== "driver") {
				return;
			}
			if (!isCurrentFocusedDriver() || driverView.activeSessionViewDriverKey === driverKey || transcriptRefreshQueued) {
				return;
			}
			transcriptRefreshQueued = true;
			queueMicrotask(() => {
				transcriptRefreshQueued = false;
				if (!driver || !isCurrentFocusedDriver()) {
					return;
				}
				driverView.setWidget(ctx, driver.getWidgetLines());
			});
		};
		try {
			driver = await createDriver({
				cwd,
				taskId,
				runId,
				runDir: artifacts.runDir,
				initialPrompt,
				expectedToolNames: getExpectedDriverToolNames(ctx),
				onTranscriptUpdate: scheduleTranscriptWidgetRefresh,
				uiContext: ctx.hasUI ? createFlowDriverUiContext(ctx.ui, driverKey) : undefined,
				extensionMode: "print",
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
		if (!driver) {
			return;
		}
		const liveDriver = driver;
		retainedDrivers.delete(driverKey);
		liveDrivers.set(driverKey, liveDriver);
		writeDriverStatus(artifacts.runDir, {
			taskId,
			runId,
			status: "running",
			step: "starting",
			summary: `${kind} driver running`,
			sessionFile: liveDriver.sessionFile,
		});
		if (driverView.focusState.focus === "driver") {
			renderFocus(ctx, readDriverStatus(artifacts.runDir)!);
		} else {
			renderMainDriverActivity(ctx);
		}
		updateSessionSwitcher(ctx);
		// driver 执行期间锁定 task 设计资产为只读;存入 map 以便所有终态路径统一释放。
		writeGuards.set(driverKey, lockTaskAssets(cwd, taskId));
		void liveDriver
			.start()
			.then(async () => {
				writeDriverStatus(artifacts.runDir, {
					taskId,
					runId,
					status: "validating",
					step: "validating output",
					summary: "validating driver output",
					sessionFile: liveDriver.sessionFile,
				});
				let attemptedContractRepair = false;
				let validation = validateFlowRun({
					cwd,
					taskId,
					runId,
					taskDir: artifacts.taskDir,
					runDir: artifacts.runDir,
					phase: kind,
				});
				if (validation.result !== "PASS") {
					attemptedContractRepair = true;
					writeDriverStatus(artifacts.runDir, {
						taskId,
						runId,
						status: "running",
						step: "repairing output contract",
						summary: `${validation.result}: ${validation.summary}`,
						sessionFile: liveDriver.sessionFile,
					});
					if (isCurrentFocusedDriver()) {
						renderFocus(ctx, readDriverStatus(artifacts.runDir)!);
					} else {
						renderMainDriverActivity(ctx);
					}
					ctx.ui.notify(`Flow runtime gate failed for ${driverKey}; asking driver to repair output contract.\n${validation.summary}`, "warning");
					await liveDriver.sendUserInput(
						buildFlowDriverContractRepairPrompt({
							kind,
							taskId,
							runId,
							issues: validation.issues,
							summary: validation.summary,
						}),
					);
					writeDriverStatus(artifacts.runDir, {
						taskId,
						runId,
						status: "validating",
						step: "validating repaired output",
						summary: "validating repaired driver output",
						sessionFile: liveDriver.sessionFile,
					});
					validation = validateFlowRun({
						cwd,
						taskId,
						runId,
						taskDir: artifacts.taskDir,
						runDir: artifacts.runDir,
						phase: kind,
					});
				}
				const terminalStatus: FlowDriverStatus =
					validation.result === "PASS" ? "done" : "failed";
				writeDriverStatus(artifacts.runDir, {
					taskId,
					runId,
					status: terminalStatus,
					step: validation.result === "PASS" ? "validated" : "validation failed",
					summary: `${validation.result}: ${validation.summary}`,
					sessionFile: liveDriver.sessionFile,
				});
				const status = readDriverStatus(artifacts.runDir)!;
				if (kind === "prove") {
					const event = validation.result === "PASS"
						? { kind: "prove-pass" as const, runId, validatedAt: validation.createdAt, nextStep: validation.nextStep }
						: { kind: "prove-fail" as const, runId, nextStep: `/flow task prove ${taskId}` };
					const proveResult = transition(cwd, taskId, event);
					if (!proveResult.ok) {
						ctx.ui.notify(proveResult.reason, "error");
					}
				}

				liveDrivers.delete(driverKey);
				retainedDrivers.set(driverKey, liveDriver);
				if (isCurrentFocusedDriver()) {
					renderFocus(ctx, status);
				} else {
					renderMainDriverActivity(ctx);
				}
				updateSessionSwitcher(ctx);
				if (validation.result !== "PASS" && attemptedContractRepair) {
					// run 路径:ready task 连结构都过不了 → 复用链路断了,转 needs-work。
					// prove 路径的 FAIL 已在上方 prove-fail transition 处理。
					if (kind === "run") {
						const runFail = transition(cwd, taskId, {
							kind: "run-fail",
							runId,
							nextStep: `fix ${taskId}/${runId} and run /flow task prove ${taskId}`,
						});
						if (!runFail.ok) {
							ctx.ui.notify(runFail.reason, "error");
						}
					}
					ctx.ui.notify(
						`Flow driver contract failed after automatic repair: ${driverKey}\n${validation.summary}`,
						"error",
					);
					releaseWriteGuard(driverKey);
					return;
				}
				const summary = status.summary ? `\n${status.summary}` : "";
				const type = status.status === "failed" ? "error" : status.status === "needs-human" ? "warning" : "info";
				ctx.ui.notify(`Flow driver completed: ${driverKey}\nStatus: ${status.status}${summary}`, type);
				if ((kind === "prove" || kind === "run") && validation.result === "PASS") {
					await runStageGate(ctx, {
						phase: kind === "prove" ? "prove-pass" : "run-pass",
						taskId,
						runId,
					});
					releaseWriteGuard(driverKey);
					return;
				}
				releaseWriteGuard(driverKey);
			})
			.catch((error) => {
				const summary = errorMessage(error);
				releaseWriteGuard(driverKey);
				writeDriverStatus(artifacts.runDir, {
					taskId,
					runId,
					status: "failed",
					step: "driver start",
					summary,
					sessionFile: liveDriver.sessionFile,
				});
				if (isCurrentFocusedDriver()) {
					clearFocusedDriver(ctx);
				}
				liveDrivers.delete(driverKey);
				liveDriver.dispose();
				updateSessionSwitcher(ctx);
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
				`Flow driver run id is ambiguous: ${target}. Use the exact task/run id, for example: ${matches[0].taskId}/${matches[0].runId}`,
				"warning",
			);
			return undefined;
		}
		return matches[0];
	}

	function findDriverForFocus(ctx: ExtensionContext): FlowDriverSummary | undefined {
		if (driverView.focusState.focus !== "driver") {
			return undefined;
		}

		const drivers = listDriverSummaries(getCwd(ctx));
		if (driverView.focusState.taskId) {
			return drivers.find((driver) => driver.taskId === driverView.focusState.taskId && driver.runId === driverView.focusState.runId);
		}

		const matches = drivers.filter((driver) => driver.runId === driverView.focusState.runId);
		return matches.length === 1 ? matches[0] : undefined;
	}

	function findDriverForReview(ctx: ExtensionContext, runId: string): FlowDriverSummary | undefined {
		return findDriverForAttach(ctx, runId);
	}

	function startCompletedFlowReview(ctx: ExtensionContext, runId: string): void {
		const driver = findDriverForReview(ctx, runId);
		if (!driver) {
			return;
		}
		const driverKey = getDriverKey(driver.taskId, driver.runId);
		const driverLive = Boolean(liveDrivers.get(driverKey)) || isTransientDriverStatus(driver.status);
		const outcome = startReview({ driver, driverLive }, getCwd(ctx));
		if (!outcome.ok) {
			ctx.ui.notify(outcome.reason, outcome.type);
			return;
		}
		if (driverView.focusState.focus === "driver") {
			clearFocusedDriver(ctx);
		}
		queueFlowContextPrompt(buildFlowTaskReviewPrompt({ taskId: driver.taskId, runId: driver.runId }));
		ctx.ui.notify(formatFlowQueued({ kind: "task-review", runId }), "info");
	}

	async function acceptCompletedFlowReview(ctx: ExtensionContext, runId: string): Promise<void> {
		const driver = findDriverForReview(ctx, runId);
		if (!driver) {
			return;
		}
		const driverKey = getDriverKey(driver.taskId, driver.runId);
		const driverLive = Boolean(liveDrivers.get(driverKey)) || isTransientDriverStatus(driver.status);
		const outcome = acceptReview({ driver, driverLive }, getCwd(ctx));
		if (!outcome.ok) {
			ctx.ui.notify(outcome.reason, outcome.type);
			return;
		}
		if (driverView.focusState.focus === "driver") {
			clearFocusedDriver(ctx);
		} else {
			renderMainDriverActivity(ctx);
		}
		updateSessionSwitcher(ctx);
		ctx.ui.notify(`Flow review accepted: ${driver.taskId}/${driver.runId}\nTask status: ready\nNext: /flow run ${driver.taskId}`, "info");
		await runStageGate(ctx, { phase: "review-accepted", taskId: driver.taskId, runId: driver.runId });
	}

	function rejectCompletedFlowReview(ctx: ExtensionContext, runId: string, reason?: string): void {
		const driver = findDriverForReview(ctx, runId);
		if (!driver) {
			return;
		}
		const driverKey = getDriverKey(driver.taskId, driver.runId);
		const driverLive = Boolean(liveDrivers.get(driverKey)) || isTransientDriverStatus(driver.status);
		const outcome = rejectReview({ driver, driverLive }, getCwd(ctx), reason);
		if (!outcome.ok) {
			ctx.ui.notify(outcome.reason, outcome.type);
			return;
		}
		if (driverView.focusState.focus === "driver") {
			clearFocusedDriver(ctx);
		} else {
			renderMainDriverActivity(ctx);
		}
		updateSessionSwitcher(ctx);
		ctx.ui.notify(`Flow review rejected: ${driver.taskId}/${driver.runId}\nTask status: needs-work`, "warning");
	}

	async function deleteCompletedFlowTask(ctx: ExtensionContext, taskId: string): Promise<void> {
		const hasLiveDriver = [...liveDrivers.values()].some((driver) => driver.taskId === taskId);
		if (hasLiveDriver) {
			ctx.ui.notify(`Flow task cannot be deleted while a driver is running: ${taskId}`, "warning");
			return;
		}
		const confirmed = await ctx.ui.confirm(
			"Delete Flow task",
			`Delete ${taskId} and all recorded runs? This cannot be undone.`,
		);
		if (!confirmed) {
			ctx.ui.notify(`Flow task delete cancelled: ${taskId}`, "info");
			return;
		}
		const deleted = deleteFlowTask(getCwd(ctx), taskId);
		if (!deleted) {
			ctx.ui.notify(`Flow task not found: ${taskId}`, "warning");
			return;
		}
		for (const [driverKey, driver] of retainedDrivers) {
			if (driver.taskId === taskId) {
				driver.dispose();
				retainedDrivers.delete(driverKey);
			}
		}
		if (driverView.focusState.focus === "driver" && driverView.focusState.taskId === taskId) {
			clearFocusedDriver(ctx);
		} else {
			renderMainDriverActivity(ctx);
		}
		updateSessionSwitcher(ctx);
		ctx.ui.notify(`Flow task deleted: ${taskId}`, "info");
	}

	pi.registerCommand("flow", {
		description: "Queue Flow task workflow requests",
		handler: async (args, ctx) => {
			const resolvedArgs = await resolveConsoleCommand(args, ctx);
			if (resolvedArgs === undefined) {
				return;
			}
			const request = parseFlowCommand(resolvedArgs);

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
				clearFocusedDriver(ctx);
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
			if (request.kind === "task-review") {
				startCompletedFlowReview(ctx, request.runId);
				return;
			}
			if (request.kind === "task-accept") {
				await acceptCompletedFlowReview(ctx, request.runId);
				return;
			}
			if (request.kind === "task-reject") {
				rejectCompletedFlowReview(ctx, request.runId, request.reason);
				return;
			}
			if (request.kind === "task-delete") {
				await deleteCompletedFlowTask(ctx, request.taskId);
				return;
			}

			if (request.kind === "reset-signing") {
				const confirmed = await ctx.ui.confirm(
					"Reset Flow record signatures",
					"This will re-sign all Flow task/review/validation records with the current key. It trusts their current content. Continue?",
				);
				if (!confirmed) {
					ctx.ui.notify("Flow reset-signing cancelled.", "info");
					return;
				}
				const result = resignAllRecords(getCwd(ctx), "manual /flow reset-signing");
				closeMigrationWindow(getCwd(ctx));
				ctx.ui.notify(
					`Flow records re-signed: ${result.tasks} tasks, ${result.reviews} reviews, ${result.validations} validations (${result.skipped} skipped).`,
					"info",
				);
				return;
			}

			if (request.kind === "task-create") {
				pendingCreateTaskIds = new Set(listConsoleTasks(getCwd(ctx)).map((task) => task.id));
			}
			queueFlowContextPrompt(buildFlowRequestPrompt(request));
			ctx.ui.notify(formatFlowQueued(request), "info");
		},
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx && pendingTaskAssetRepair) {
			const repair = pendingTaskAssetRepair;
			const validation = validateFlowTaskAssets(getCwd(ctx), repair.taskId);
			if (validation.ok) {
				pendingTaskAssetRepair = undefined;
				await runStageGate(ctx, { phase: "create", taskId: repair.taskId });
				return;
			}
			if (repair.attempts >= 1) {
				pendingTaskAssetRepair = undefined;
				ctx.ui.notify(
					`Flow task contract failed after automatic repair: ${repair.taskId}\n${validation.issues.join("\n")}`,
					"error",
				);
				return;
			}
			queueTaskAssetRepair(ctx, repair.taskId, validation.issues);
			return;
		}
		if (!ctx || !pendingCreateTaskIds) {
			return;
		}
		const previousTaskIds = pendingCreateTaskIds;
		pendingCreateTaskIds = undefined;
		const createdTasks = listConsoleTasks(getCwd(ctx)).filter((task) =>
			!previousTaskIds.has(task.id) && task.status === "draft"
		);
		if (createdTasks.length !== 1) {
			return;
		}
		const validation = validateFlowTaskAssets(getCwd(ctx), createdTasks[0].id);
		if (!validation.ok) {
			queueTaskAssetRepair(ctx, createdTasks[0].id, validation.issues);
			return;
		}
		await runStageGate(ctx, { phase: "create", taskId: createdTasks[0].id });
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
		// 启动期自动迁移:仅在主 session 触发(driver session 的 mode 是 "print")。
		// driver session 不做迁移,避免在 driver cwd 下产生多余的 migrated marker。
		if (ctx.mode !== "print") {
			autoMigrateIfNeeded(getCwd(ctx));
		}
		const entries = ctx.sessionManager?.getEntries?.() ?? [];
		driverView.restoreFromEntries(entries);
		if (driverView.focusState.focus === "driver") {
			const driver = findDriverForFocus(ctx);
			if (driver) {
				renderFocus(ctx, driver);
				updateSessionSwitcher(ctx);
				return;
			}
			driverView.clear(ctx);
			return;
		}
		renderFocus(ctx);
		updateSessionSwitcher(ctx);
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
		if (driverView.focusState.focus !== "driver") {
			return { action: "continue" };
		}

		const driver = findDriverForFocus(ctx);
		if (!driver) {
			ctx.ui.notify(`Focused Flow driver not found: ${driverView.focusState.runId}`, "warning");
			driverView.clear(ctx);
			return { action: "handled" };
		}

		const liveDriver = liveDrivers.get(getDriverKey(driver.taskId, driver.runId));
		if (!liveDriver) {
			appendDriverFeedback(driver.runDir, {
				message: event.text,
				driverResponse: "recorded; not delivered because driver is not live",
				affectedStep: driver.step,
			});
			ctx.ui.notify(`Flow driver ${driver.runId} is recoverable but not live in this process. Feedback was recorded.`, "warning");
			return { action: "handled" };
		}
		if (driverView.activeSessionViewDriverKey === getDriverKey(driver.taskId, driver.runId)) {
			return { action: "continue" };
		}
		appendDriverFeedback(driver.runDir, {
			message: event.text,
			driverResponse: "queued to driver",
			affectedStep: driver.step,
		});
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
			const failedDriverKey = getDriverKey(driver.taskId, driver.runId);
			liveDrivers.delete(failedDriverKey);
			releaseWriteGuard(failedDriverKey);
			liveDriver.dispose();
			updateSessionSwitcher(ctx);
			renderFocus(ctx, { ...driver, status: "failed", summary });
			ctx.ui.notify(`Flow driver input delivery failed: ${driver.taskId}/${driver.runId}\n${summary}`, "warning");
			return { action: "handled" };
		}
		driverView.setWidget(ctx, liveDriver.getWidgetLines());
		ctx.ui.notify(`Sent to Flow driver ${driver.runId}`, "info");
		return { action: "handled" };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx) {
			driverView.detachSessionView(ctx);
		}
		for (const driver of liveDrivers.values()) {
			const status = readDriverStatus(driver.runDir);
			if (status && isTransientDriverStatus(status.status)) {
				writeDriverStatus(driver.runDir, {
					taskId: status.taskId,
					runId: status.runId,
					status: "paused",
					step: status.step,
					summary: "driver paused because session shut down",
					sessionFile: status.sessionFile ?? driver.sessionFile,
				});
			}
			driver.dispose();
		}
		for (const [driverKey, driver] of retainedDrivers) {
			if (!liveDrivers.has(driverKey)) {
				driver.dispose();
			}
		}
		liveDrivers.clear();
		retainedDrivers.clear();
		// 会话关闭:释放所有未释放的 task 资产只读锁,避免文件永久卡在 0444。
		for (const key of [...writeGuards.keys()]) {
			releaseWriteGuard(key);
		}
		ctx?.ui && updateSessionSwitcher(ctx);
	});
}

export default registerFlow;
