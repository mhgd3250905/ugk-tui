import test from "node:test";
import assert from "node:assert/strict";
import { createDriverView, type DriverViewDeps } from "../extensions/flow/driver-viewport.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FlowDriverSession } from "../extensions/flow/driver-session.ts";
import type { FlowDriverSummary } from "../extensions/flow/types.ts";

/**
 * DriverView 的 headless 单元测试。
 *
 * 这是 deepening 的核心价值:driver UI 编排原本埋在 index.ts 闭包里,
 * 只能靠 mock 整个 ctx.ui 间接测。现在 DriverView 通过注入的回调解耦了进程表,
 * 可以用一个最小 fake ctx + fake sessions 直接测 focus/clear/refresh 的状态流转。
 */

function makeFakeSession(taskId: string, runId: string): FlowDriverSession {
	return {
		taskId,
		runId,
		runDir: `/fake/${taskId}/${runId}`,
		getTranscriptText: () => "transcript line",
		getWidgetLines: () => [`driver ${taskId}/${runId}`, "output"],
		start: async () => {},
		sendUserInput: async () => {},
		dispose: () => {},
	};
}

function makeFakeCtx(): ExtensionContext & {
	_widgets: Map<string, unknown>;
	_statuses: Map<string, string | undefined>;
	_notifies: Array<{ message: string; type?: string }>;
	_switcherCalls: Array<{ owner: string; options?: unknown }>;
} {
	const widgets = new Map<string, unknown>();
	const statuses = new Map<string, string | undefined>();
	const notifies: Array<{ message: string; type?: string }> = [];
	const switcherCalls: Array<{ owner: string; options?: unknown }> = [];
	const ctx = {
		cwd: "/fake-cwd",
		hasUI: true,
		mode: "tui",
		isIdle: () => true,
		ui: {
			notify: (message: string, type?: string) => notifies.push({ message, type }),
			setWidget: (key: string, value: unknown) => widgets.set(key, value),
			setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
			setSessionSwitcher: (owner: string, options?: unknown) => switcherCalls.push({ owner, options }),
			select: async () => undefined,
			input: async () => undefined,
			confirm: async () => false,
		},
		_widgets: widgets,
		_statuses: statuses,
		_notifies: notifies,
		_switcherCalls: switcherCalls,
	};
	return ctx as unknown as ExtensionContext & {
		_widgets: Map<string, unknown>;
		_statuses: Map<string, string | undefined>;
		_notifies: Array<{ message: string; type?: string }>;
		_switcherCalls: Array<{ owner: string; options?: unknown }>;
	};
}

function makeDeps(sessions: Map<string, FlowDriverSession>, liveKeys: Set<string>, summaries: FlowDriverSummary[]): DriverViewDeps {
	return {
		getSession: (key) => sessions.get(key),
		isLiveSession: (key) => liveKeys.has(key),
		getViewableDrivers: () => [...sessions.values()],
		listSummaries: () => summaries,
		persistFocus: () => {},
		getDriverKey: (taskId, runId) => `${taskId}/${runId}`,
	};
}

test("DriverView starts focused on main", () => {
	const ctx = makeFakeCtx();
	const view = createDriverView(makeDeps(new Map(), new Set(), []));
	assert.equal(view.focusState.focus, "main");
	assert.equal(view.activeSessionViewDriverKey, undefined);
});

test("focus moves to a driver and renders its widget", () => {
	const ctx = makeFakeCtx();
	const session = makeFakeSession("task-a", "run-001");
	const sessions = new Map([["task-a/run-001", session]]);
	const summary: FlowDriverSummary = {
		taskId: "task-a",
		runId: "run-001",
		status: "running",
		runDir: "/fake/task-a/run-001",
	};
	const view = createDriverView(makeDeps(sessions, new Set(["task-a/run-001"]), [summary]));

	view.focus(summary, ctx);

	assert.equal(view.focusState.focus, "driver");
	assert.equal(view.focusState.runId, "run-001");
	// widget 被写入(驱动 transcript 行)
	const widget = (ctx as any)._widgets.get("flow-driver-view");
	assert.ok(Array.isArray(widget));
});

test("clear returns focus to main and clears driver status", () => {
	const ctx = makeFakeCtx();
	const session = makeFakeSession("task-a", "run-001");
	const sessions = new Map([["task-a/run-001", session]]);
	const summary: FlowDriverSummary = { taskId: "task-a", runId: "run-001", status: "running", runDir: "/fake" };
	const view = createDriverView(makeDeps(sessions, new Set(), [summary]));

	view.focus(summary, ctx);
	assert.equal(view.focusState.focus, "driver");

	view.clear(ctx);
	assert.equal(view.focusState.focus, "main");
	// driver status 被清
	assert.equal((ctx as any)._statuses.get("flow-driver"), undefined);
});

test("focus notifies 'attached' for live session, 'opened' for retained", () => {
	const liveCtx = makeFakeCtx();
	const liveSession = makeFakeSession("t", "r1");
	const liveSummary: FlowDriverSummary = { taskId: "t", runId: "r1", status: "running", runDir: "/f" };
	const liveView = createDriverView(makeDeps(new Map([["t/r1", liveSession]]), new Set(["t/r1"]), [liveSummary]));
	liveView.focus(liveSummary, liveCtx);
	assert.match((liveCtx as any)._notifies.at(-1)?.message ?? "", /attached/);

	const retainedCtx = makeFakeCtx();
	const retainedSession = makeFakeSession("t", "r2");
	const retainedSummary: FlowDriverSummary = { taskId: "t", runId: "r2", status: "done", runDir: "/f" };
	// isLiveSession 返回 false → opened
	const retainedView = createDriverView(makeDeps(new Map([["t/r2", retainedSession]]), new Set(), [retainedSummary]));
	retainedView.focus(retainedSummary, retainedCtx);
	assert.match((retainedCtx as any)._notifies.at(-1)?.message ?? "", /opened/);
});

test("focus without a live session shows summary-only notice", () => {
	const ctx = makeFakeCtx();
	const summary: FlowDriverSummary = { taskId: "t", runId: "r1", status: "done", runDir: "/f" };
	// 没有 session 可 attach
	const view = createDriverView(makeDeps(new Map(), new Set(), [summary]));
	view.focus(summary, ctx);
	assert.match((ctx as any)._notifies.at(-1)?.message ?? "", /not live; showing summary only/);
});

test("restoreFromEntries restores a persisted driver focus", () => {
	const ctx = makeFakeCtx();
	const view = createDriverView(makeDeps(new Map(), new Set(), []));
	view.restoreFromEntries([
		{ type: "custom", customType: "flow-focus", data: { focus: "driver", taskId: "t", runId: "r1" } } as never,
	]);
	assert.equal(view.focusState.focus, "driver");
	assert.equal(view.focusState.runId, "r1");
});

test("updateSwitcher populates items including a 'main' entry when focused on a driver", () => {
	const ctx = makeFakeCtx();
	const session = makeFakeSession("task-a", "run-001");
	const sessions = new Map([["task-a/run-001", session]]);
	const summary: FlowDriverSummary = { taskId: "task-a", runId: "run-001", status: "running", runDir: "/fake" };
	const view = createDriverView(makeDeps(sessions, new Set(["task-a/run-001"]), [summary]));

	view.focus(summary, ctx);
	view.updateSwitcher(ctx);

	const last = (ctx as any)._switcherCalls.at(-1);
	assert.ok(last?.options, "switcher should be set with options");
	const items = (last.options as { items: Array<{ id: string; label: string; active?: boolean }> }).items;
	const ids = items.map((i) => i.id);
	assert.ok(ids.includes("main"), "switcher must include a 'main' entry when focused on a driver");
	assert.ok(ids.includes("task-a/run-001"), "switcher must include the focused driver");
});

test("updateSwitcher clears switcher when no drivers are viewable", () => {
	const ctx = makeFakeCtx();
	const view = createDriverView(makeDeps(new Map(), new Set(), []));
	view.updateSwitcher(ctx);
	const last = (ctx as any)._switcherCalls.at(-1);
	assert.equal(last?.options, undefined, "switcher should be cleared when no drivers");
});

test("focusState getter returns a copy, not the internal reference", () => {
	const ctx = makeFakeCtx();
	const session = makeFakeSession("t", "r1");
	const sessions = new Map([["t/r1", session]]);
	const summary: FlowDriverSummary = { taskId: "t", runId: "r1", status: "running", runDir: "/f" };
	const view = createDriverView(makeDeps(sessions, new Set(["t/r1"]), [summary]));
	view.focus(summary, ctx);

	const snapshot = view.focusState;
	// 外部就地 mutate 不应影响内部状态
	(snapshot as { runId: string }).runId = "tampered";
	assert.equal(view.focusState.runId, "r1", "internal focusState must not be mutated by external aliasing");
});
