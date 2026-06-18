import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { clearFlowDriverBanner, setFlowDriverBanner } from "./driver-banner.ts";
import { attachFlowDriver, detachFlowDriver, restoreFlowFocus, type FlowFocusState } from "./driver-focus.ts";
import { formatFlowActivityCard, type FlowActivityViewModel } from "./status-presenter.ts";
import { readFlowReview } from "./review-store.ts";
import { readFlowRunValidation } from "./run-validation.ts";
import { readDriverStatus, type FlowDriverSummary } from "./driver-store.ts";
import { readFlowTask } from "./task-store.ts";
import type { FlowDriverSession } from "./driver-session.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Driver 视图层(deep module)。
 *
 * 从 index.ts 抽出的 UI 编排:focusState、session-view attach/detach、activity widget、
 * session switcher。这些逻辑原本散落在 index.ts 的 8 个函数里(被 56 处调用),且和
 * driver 生命周期编排混在同一个闭包。本模块把它们收进一个有 locality 的单元。
 *
 * 与进程层的解耦:本模块不持有 liveDrivers/retainedDrivers 进程表,而是通过构造时
 * 注入的 getSession/listSummaries 回调按需读取。这样 UI 层不耦合进程管理。
 *
 * 与持久化的解耦:focus 变更通过 persistFocus 回调通知调用方落盘(供会话恢复用)。
 */

export const FLOW_SESSION_VIEW_OWNER = "flow-driver";

/** 主 UI 上可能存在的 session-view 扩展方法(非所有 UI 实现都提供)。 */
export type FlowSessionViewUi = ExtensionContext["ui"] & {
	attachSessionView?: (
		owner: string,
		session: unknown,
		options?: {
			label?: string;
			detachCommand?: string;
			onDetach?: () => void | Promise<void>;
		},
	) => boolean;
	detachSessionView?: (owner: string) => boolean;
	setSessionSwitcher?: (
		owner: string,
		options?: {
			title?: string;
			items: Array<{
				id: string;
				label: string;
				description?: string;
				active?: boolean;
			}>;
			onSelect: (id: string) => void | Promise<void>;
		},
	) => boolean;
};

export interface DriverViewDeps {
	/** 按 driverKey 拿当前(活跃或留存)的 driver session,供读取 widget/transcript。 */
	getSession: (driverKey: string) => FlowDriverSession | undefined;
	/** 该 driverKey 是否仍是活跃进程(区分 attached vs opened 文案)。 */
	isLiveSession: (driverKey: string) => boolean;
	/** 当前所有可展示的 driver(活跃 + 留存,去重)。 */
	getViewableDrivers: () => FlowDriverSession[];
	/** 按 driverKey 拿 driver 摘要(从磁盘读 status 等)。接收 cwd。 */
	listSummaries: (cwd: string) => FlowDriverSummary[];
	/** focus 变更时落盘,供会话恢复。 */
	persistFocus: (state: FlowFocusState) => void;
	/** 生成 driverKey。 */
	getDriverKey: (taskId: string, runId: string) => string;
}

export interface DriverView {
	/** 当前 focus 状态(供外部判断 input 该转去哪)。 */
	readonly focusState: FlowFocusState;
	/** 从会话条目恢复 focus(启动时用)。 */
	restoreFromEntries(entries: SessionEntry[]): void;
	/** 把焦点切到某个 driver(attach 摘要 + session view + 刷 UI)。 */
	focus(driver: FlowDriverSummary, ctx: ExtensionContext): void;
	/** 退出 driver focus,回 main。 */
	clear(ctx: ExtensionContext, options?: { skipSessionViewDetach?: boolean }): void;
	/** 刷新主 activity widget(driver 列表卡片)。 */
	refreshActivity(ctx: ExtensionContext): void;
	/** 按 focus 状态刷新 banner/status/widget(传 driver 表示聚焦那个,不传表示 main)。 */
	refreshFocus(ctx: ExtensionContext, driver?: FlowDriverSummary, options?: { skipSessionViewDetach?: boolean }): void;
	/** 刷新 session switcher(右上角会话切换)。 */
	updateSwitcher(ctx: ExtensionContext): void;
	/** 仅 detach 当前 session view(不改变 focus,不刷 UI)。供 session_shutdown 单独调用。 */
	detachSessionView(ctx: ExtensionContext): void;
	/** 当前 attach 的 session view driverKey(供外部判断 widget 该不该刷)。 */
	readonly activeSessionViewDriverKey: string | undefined;
}

function transcriptPreview(text: string, maxLines = 3): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(-maxLines);
}

function buildActivityLines(
	deps: DriverViewDeps,
	cwd: string,
): string[] | undefined {
	const drivers = deps.getViewableDrivers();
	if (drivers.length === 0) {
		return undefined;
	}

	const items: FlowActivityViewModel[] = [];
	for (const driver of drivers) {
		const status = readDriverStatus(driver.runDir);
		const validation = readFlowRunValidation(driver.runDir);
		const review = readFlowReview(driver.runDir);
		const task = readFlowTask(cwd, driver.taskId);
		const item: FlowActivityViewModel = {
			taskId: driver.taskId,
			runId: driver.runId,
			status: status?.status ?? "running",
			step: status?.step,
			summary: status?.summary,
			validation: validation
				? {
						result: validation.result,
						summary: validation.summary,
						nextStep: validation.nextStep,
					}
				: undefined,
			review: review ? { status: review.status } : undefined,
			task: task
				? {
						status: task.status,
						nextStep: typeof task.next_step === "string" ? task.next_step : undefined,
					}
				: undefined,
		};
		if (status?.status === "done" || status?.status === "failed" || status?.status === "needs-human") {
			item.preview = validation ? undefined : transcriptPreview(driver.getTranscriptText());
			items.push(item);
			continue;
		}
		const preview = transcriptPreview(driver.getTranscriptText());
		if (preview.length > 0) {
			item.preview = preview;
		}
		items.push(item);
	}
	return formatFlowActivityCard(items);
}

function detachVisibleSessionView(
	ui: FlowSessionViewUi,
	state: { activeSessionViewDriverKey: string | undefined },
): void {
	if (!state.activeSessionViewDriverKey) {
		return;
	}
	ui.detachSessionView?.(FLOW_SESSION_VIEW_OWNER);
	state.activeSessionViewDriverKey = undefined;
}

function attachVisibleSessionView(
	deps: DriverViewDeps,
	state: DriverViewState,
	driver: FlowDriverSummary,
	liveDriver: FlowDriverSession,
	ctx: ExtensionContext,
	clear: (ctx: ExtensionContext, options?: { skipSessionViewDetach?: boolean }) => void,
): boolean {
	if (!liveDriver.visibleSession) {
		return false;
	}
	const ui = ctx.ui as FlowSessionViewUi;
	if (typeof ui.attachSessionView !== "function") {
		return false;
	}

	const driverKey = deps.getDriverKey(driver.taskId, driver.runId);
	const attached = ui.attachSessionView(FLOW_SESSION_VIEW_OWNER, liveDriver.visibleSession, {
		label: `Flow driver ${driverKey}`,
		detachCommand: "/flow detach",
		onDetach: () => {
			if (state.focusState.focus === "driver" && deps.getDriverKey(state.focusState.taskId ?? driver.taskId, state.focusState.runId) === driverKey) {
				clear(ctx, { skipSessionViewDetach: true });
				ctx.ui.notify("Flow driver detached.", "info");
			}
		},
	});
	if (!attached) {
		return false;
	}

	state.activeSessionViewDriverKey = driverKey;
	return true;
}

interface DriverViewState {
	focusState: FlowFocusState;
	activeSessionViewDriverKey: string | undefined;
}

export function createDriverView(deps: DriverViewDeps): DriverView {
	const state: DriverViewState = {
		focusState: { focus: "main" },
		activeSessionViewDriverKey: undefined,
	};

	const refreshActivity = (ctx: ExtensionContext): void => {
		const cwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
		ctx.ui.setWidget?.("flow-driver-view", buildActivityLines(deps, cwd), { placement: "aboveEditor" });
	};

	const refreshFocus = (
		ctx: ExtensionContext,
		driver?: FlowDriverSummary,
		options?: { skipSessionViewDetach?: boolean },
	): void => {
		if (state.focusState.focus === "driver" && driver) {
			setFlowDriverBanner({ taskId: driver.taskId, runId: driver.runId, status: driver.status });
			const statusText = `driver:${driver.runId}`;
			const viewDriver = deps.getSession(deps.getDriverKey(driver.taskId, driver.runId));
			ctx.ui.setStatus?.("flow-driver", ctx.ui.theme?.fg?.("warning", statusText) ?? statusText);
			if (state.activeSessionViewDriverKey === deps.getDriverKey(driver.taskId, driver.runId)) {
				ctx.ui.setWidget?.("flow-driver-view", undefined);
				return;
			}
			ctx.ui.setWidget?.(
				"flow-driver-view",
				viewDriver?.getWidgetLines() ?? [
					`Flow driver: ${driver.taskId}/${driver.runId}`,
					`Status: ${driver.status}`,
					`Step: ${driver.step ?? "-"}`,
				],
				{ placement: "aboveEditor" },
			);
			return;
		}

		if (!options?.skipSessionViewDetach) {
			detachVisibleSessionView(ctx.ui as FlowSessionViewUi, state);
		}
		clearFlowDriverBanner();
		ctx.ui.setStatus?.("flow-driver", undefined);
		refreshActivity(ctx);
	};

	const clear = (ctx: ExtensionContext, options?: { skipSessionViewDetach?: boolean }): void => {
		if (!options?.skipSessionViewDetach) {
			detachVisibleSessionView(ctx.ui as FlowSessionViewUi, state);
		}
		state.focusState = detachFlowDriver(state.focusState);
		deps.persistFocus(state.focusState);
		refreshFocus(ctx, undefined, { skipSessionViewDetach: true });
		updateSwitcher(ctx);
	};

	const focus = (driver: FlowDriverSummary, ctx: ExtensionContext): void => {
		state.focusState = attachFlowDriver(state.focusState, driver);
		deps.persistFocus(state.focusState);
		const driverKey = deps.getDriverKey(driver.taskId, driver.runId);
		const session = deps.getSession(driverKey);
		if (session) {
			attachVisibleSessionView(deps, state, driver, session, ctx, clear);
		}
		refreshFocus(ctx, driver);
		updateSwitcher(ctx);
		if (!session) {
			ctx.ui.notify(`Flow driver is not live; showing summary only: ${driverKey}`, "info");
			return;
		}
		ctx.ui.notify(deps.isLiveSession(driverKey) ? `Flow driver attached: ${driverKey}` : `Flow driver opened: ${driverKey}`, "info");
	};

	const updateSwitcher = (ctx: ExtensionContext): void => {
		const ui = ctx.ui as FlowSessionViewUi;
		if (typeof ui.setSessionSwitcher !== "function") {
			return;
		}
		const viewable = deps.getViewableDrivers();
		if (viewable.length === 0) {
			ui.setSessionSwitcher(FLOW_SESSION_VIEW_OWNER, undefined);
			return;
		}

		const cwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
		const summaries = deps.listSummaries(cwd);
		const activeDriverKey = state.focusState.focus === "driver"
			? deps.getDriverKey(state.focusState.taskId ?? "", state.focusState.runId)
			: undefined;
		const items: Array<{ id: string; label: string; description?: string; active?: boolean }> = [];
		if (state.focusState.focus === "driver") {
			items.push({
				id: "main",
				label: "main",
				description: "main agent",
				active: false,
			});
		}

		for (const viewDriver of viewable) {
			const driverKey = deps.getDriverKey(viewDriver.taskId, viewDriver.runId);
			const status = readDriverStatus(viewDriver.runDir);
			items.push({
				id: driverKey,
				label: driverKey,
				description: [status?.status ?? "running", status?.step].filter(Boolean).join(" "),
				active: activeDriverKey === driverKey,
			});
		}

		ui.setSessionSwitcher(FLOW_SESSION_VIEW_OWNER, {
			title: "Flow sessions",
			items,
			onSelect: async (id) => {
				if (id === "main") {
					clear(ctx);
					return;
				}
				const session = deps.getSession(id);
				if (!session) {
					ctx.ui.notify(`Flow driver is not available in this session: ${id}`, "warning");
					updateSwitcher(ctx);
					return;
				}
				const driverSummary = summaries.find(
					(s) => deps.getDriverKey(s.taskId, s.runId) === id,
				);
				if (!driverSummary) {
					ctx.ui.notify(`Flow driver not found: ${id}`, "warning");
					updateSwitcher(ctx);
					return;
				}
				focus(driverSummary, ctx);
			},
		});
	};

	return {
		get focusState() {
			// 浅拷贝,防止外部拿到引用后就地 mutate 污染内部状态。
			return { ...state.focusState };
		},
		get activeSessionViewDriverKey() {
			return state.activeSessionViewDriverKey;
		},
		restoreFromEntries(entries) {
			state.focusState = restoreFlowFocus(entries);
		},
		focus,
		clear,
		refreshActivity,
		refreshFocus,
		updateSwitcher,
		detachSessionView(ctx) {
			detachVisibleSessionView(ctx.ui as FlowSessionViewUi, state);
		},
	};
}
