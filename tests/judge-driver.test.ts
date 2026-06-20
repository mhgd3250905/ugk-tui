import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createJudgeDriver } from "../extensions/judge/judge-driver.ts";
import type { DriverSessionFactory } from "../extensions/shared/driver-session.ts";

type DriverEvent = {
	type?: string;
	toolName?: string;
	isError?: boolean;
	input?: unknown;
	result?: unknown;
};

function makeDriverHarness() {
	let listener: ((event: DriverEvent) => void) | undefined;
	const prompts: string[] = [];
	const userInputs: string[] = [];
	const calls: string[] = [];
	let disposed = false;
	const sessionFactory: DriverSessionFactory = async () => ({
		session: {
			isStreaming: true,
			getAllTools() {
				return [{ name: "judge_complete" }];
			},
			subscribe(callback) {
				listener = callback;
				return () => {
					calls.push("unsubscribe");
				};
			},
			async prompt(text) {
				prompts.push(text);
			},
			async steer(text) {
				userInputs.push(text);
			},
			async followUp() {},
			dispose() {
				disposed = true;
				calls.push("dispose");
			},
		},
	});

	return {
		sessionFactory,
		emit(event: DriverEvent) {
			assert.ok(listener, "driver listener should be registered");
			listener(event);
		},
		async flush() {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
		prompts,
		userInputs,
		calls,
		get disposed() {
			return disposed;
		},
	};
}

function createOptions(overrides: Partial<Parameters<typeof createJudgeDriver>[0]> = {}) {
	return {
		cwd: "E:/AII/ugk-core",
		runDir: "E:/AII/ugk-core/.judge/run-001",
		spec: "实现 Judge 阶段 3",
		...overrides,
	};
}

test("wakes up when the driver starts a guarded network or write-capable tool", async () => {
	const harness = makeDriverHarness();
	const wakeups: string[] = [];
	const driver = await createJudgeDriver(createOptions({
		sessionFactory: harness.sessionFactory,
		onWakeup: async ({ summary }) => {
			wakeups.push(summary.pathsTried.at(-1)?.toolName ?? "");
			return { action: "pass", keepWatching: true };
		},
	}));
	await driver.start();

	harness.emit({ type: "tool_execution_start", toolName: "chrome_cdp", input: { url: "https://www.zhihu.com/hot" } });
	await harness.flush();

	assert.deepEqual(wakeups, ["chrome_cdp"]);
	assert.deepEqual(driver.getSummary().pathsTried, [
		{
			toolName: "chrome_cdp",
			argsSummary: "url=https://www.zhihu.com/hot",
			resultSummary: "",
			failed: false,
		},
	]);
});

test("driver summary exposes running tools while waiting for tool results", async () => {
	const harness = makeDriverHarness();
	const wakeups: Array<{ runningTools?: Array<{ toolName: string; argsSummary: string; elapsedMs: number }> }> = [];
	const driver = await createJudgeDriver(createOptions({
		sessionFactory: harness.sessionFactory,
		onWakeup: async ({ summary }) => {
			wakeups.push({ runningTools: summary.runningTools });
			return { action: "pass", keepWatching: true };
		},
	}));

	harness.emit({ type: "tool_execution_start", toolName: "bash", input: { command: "python E:/AII/TUI/transcribe_full.py" } });
	await harness.flush();

	assert.equal(driver.getSummary().runningTools?.length, 1);
	assert.equal(driver.getSummary().runningTools?.[0]?.toolName, "bash");
	assert.match(driver.getSummary().runningTools?.[0]?.argsSummary ?? "", /transcribe_full\.py/);
	assert.equal(typeof driver.getSummary().runningTools?.[0]?.elapsedMs, "number");
	assert.equal(wakeups[0].runningTools?.[0]?.toolName, "bash");

	harness.emit({ type: "tool_execution_end", toolName: "bash", isError: false, result: { ok: true } });
	await harness.flush();

	assert.deepEqual(driver.getSummary().runningTools, []);
});

test("wakeup summary snapshots do not mutate the driver summary", async () => {
	const harness = makeDriverHarness();
	const driver = await createJudgeDriver(createOptions({
		sessionFactory: harness.sessionFactory,
		onWakeup: async ({ summary }) => {
			summary.pathsTried[0].toolName = "mutated";
			summary.artifacts.push({ path: "E:/tmp/mutated.md", kind: "file" });
			return { action: "pass", keepWatching: true };
		},
	}));

	harness.emit({ type: "tool_execution_start", toolName: "write", input: { path: "E:/tmp/out.md" } });
	await harness.flush();

	assert.equal(driver.getSummary().pathsTried[0].toolName, "write");
	assert.deepEqual(driver.getSummary().artifacts, [{ path: "E:/tmp/out.md", kind: "file" }]);
});

test("requires the delegated driver environment to expose judge_complete", async () => {
	let expectedToolNames: string[] | undefined;
	const sessionFactory: DriverSessionFactory = async (options) => {
		expectedToolNames = options.expectedToolNames;
		return {
			session: {
				isStreaming: false,
				getAllTools() {
					return [];
				},
				subscribe() {
					return () => {};
				},
				async prompt() {},
				async steer() {},
				async followUp() {},
				dispose() {},
			},
		};
	};

	await assert.rejects(
		() => createJudgeDriver(createOptions({ sessionFactory })),
		/Missing required capabilities: judge_complete/,
	);
	assert.deepEqual(expectedToolNames, ["judge_complete"]);
});

test("delegated Judge driver uses the isolated driver agent definition", async () => {
	let agentDefinitionPath: string | undefined;
	const sessionFactory: DriverSessionFactory = async (options) => {
		agentDefinitionPath = options.agentDefinitionPath;
		return {
			session: {
				isStreaming: false,
				getAllTools() {
					return [{ name: "judge_complete" }];
				},
				subscribe() {
					return () => {};
				},
				async prompt() {},
				async steer() {},
				async followUp() {},
				dispose() {},
			},
		};
	};

	await createJudgeDriver(createOptions({ sessionFactory }));

	assert.equal(path.basename(agentDefinitionPath ?? ""), "driver.md");
	assert.match(agentDefinitionPath ?? "", /agents[/\\]driver\.md$/);
});

test("wakes up when any driver tool execution ends with an error", async () => {
	const harness = makeDriverHarness();
	const wakeups: Array<string | undefined> = [];
	const driver = await createJudgeDriver(createOptions({
		sessionFactory: harness.sessionFactory,
		onWakeup: async ({ summary }) => {
			wakeups.push(summary.lastError);
			return { action: "pass", keepWatching: true };
		},
	}));

	harness.emit({ type: "tool_execution_end", toolName: "read", isError: true });
	await harness.flush();

	assert.deepEqual(wakeups, ["read failed"]);
	assert.equal(driver.getSummary().lastError, "read failed");
});

test("steer verdict sends direction back to the driver", async () => {
	const harness = makeDriverHarness();
	const driver = await createJudgeDriver(createOptions({
		sessionFactory: harness.sessionFactory,
		onWakeup: async () => ({ action: "steer", direction: "先停止写文件，改为只读确认路径。", keepWatching: true }),
	}));

	harness.emit({ type: "tool_execution_start", toolName: "write" });
	await harness.flush();

	assert.deepEqual(harness.userInputs, ["先停止写文件，改为只读确认路径。"]);
	assert.equal(driver.getSummary().completed, false);
});

test("abort verdict disposes the driver and records the abort reason", async () => {
	const harness = makeDriverHarness();
	const driver = await createJudgeDriver(createOptions({
		sessionFactory: harness.sessionFactory,
		onWakeup: async () => ({ action: "abort", reason: "违反硬约束" }),
	}));

	harness.emit({ type: "tool_execution_start", toolName: "bash" });
	await harness.flush();

	assert.equal(harness.disposed, true);
	assert.deepEqual(harness.calls, ["unsubscribe", "dispose"]);
	assert.equal(driver.getSummary().aborted, true);
	assert.equal(driver.getSummary().abortReason, "违反硬约束");
});

test("judge_complete marks completed only after a successful end and wakes Judge", async () => {
	const harness = makeDriverHarness();
	const wakeups: boolean[] = [];
	const driver = await createJudgeDriver(createOptions({
		sessionFactory: harness.sessionFactory,
		onWakeup: async ({ summary }) => {
			wakeups.push(summary.completed);
			return { action: "pass", keepWatching: false };
		},
	}));

	harness.emit({ type: "tool_execution_start", toolName: "judge_complete" });
	assert.equal(driver.getSummary().completed, false);
	harness.emit({ type: "tool_execution_end", toolName: "judge_complete", isError: false });
	await harness.flush();

	assert.deepEqual(wakeups, [true]);
	assert.equal(driver.getSummary().completed, true);
});

test("onWakeup errors are recorded and the wakeup queue continues", async () => {
	const harness = makeDriverHarness();
	const wakeupReasons: string[] = [];
	const driver = await createJudgeDriver(createOptions({
		sessionFactory: harness.sessionFactory,
		onWakeup: async ({ reason }) => {
			wakeupReasons.push(reason);
			if (wakeupReasons.length === 1) {
				throw new Error("judge decide failed");
			}
			return { action: "pass", keepWatching: true };
		},
	}));

	harness.emit({ type: "tool_execution_start", toolName: "bash" });
	await harness.flush();
	assert.match(driver.getSummary().lastError ?? "", /judge decide failed/);

	harness.emit({ type: "tool_execution_start", toolName: "write", input: { path: "E:/tmp/out.md" } });
	await harness.flush();

	assert.deepEqual(wakeupReasons, ["guarded_tool_start", "guarded_tool_start"]);
	assert.deepEqual(driver.getSummary().pathsTried.map((entry) => entry.toolName), ["bash", "write"]);
	assert.equal(driver.getSummary().pathsTried[1].argsSummary, "path=E:/tmp/out.md");
});

test("judge_complete end error wakes through tool_error and does not mark completed", async () => {
	const harness = makeDriverHarness();
	const wakeups: Array<{ reason: string; lastError?: string; completed: boolean }> = [];
	const driver = await createJudgeDriver(createOptions({
		sessionFactory: harness.sessionFactory,
		onWakeup: async ({ reason, summary }) => {
			wakeups.push({ reason, lastError: summary.lastError, completed: summary.completed });
			return { action: "pass", keepWatching: true };
		},
	}));

	harness.emit({ type: "tool_execution_start", toolName: "judge_complete" });
	harness.emit({ type: "tool_execution_end", toolName: "judge_complete", isError: true });
	await harness.flush();

	assert.deepEqual(wakeups, [{ reason: "tool_error", lastError: "judge_complete failed", completed: false }]);
	assert.equal(driver.getSummary().completed, false);
});

test("agent_end wakes Judge after judge_complete starts but never succeeds", async () => {
	const harness = makeDriverHarness();
	const wakeupReasons: string[] = [];
	const driver = await createJudgeDriver(createOptions({
		sessionFactory: harness.sessionFactory,
		onWakeup: async ({ reason }) => {
			wakeupReasons.push(reason);
			return { action: "pass", keepWatching: true };
		},
	}));

	harness.emit({ type: "tool_execution_start", toolName: "judge_complete" });
	harness.emit({ type: "agent_end" });
	await harness.flush();

	assert.deepEqual(wakeupReasons, ["agent_end"]);
	assert.equal(driver.getSummary().completed, false);
});

test("judge_complete start and end sequence wakes Judge only once", async () => {
	const harness = makeDriverHarness();
	const wakeupReasons: string[] = [];
	await createJudgeDriver(createOptions({
		sessionFactory: harness.sessionFactory,
		onWakeup: async ({ reason }) => {
			wakeupReasons.push(reason);
			return { action: "pass", keepWatching: true };
		},
	}));

	harness.emit({ type: "tool_execution_start", toolName: "judge_complete" });
	harness.emit({ type: "tool_execution_end", toolName: "judge_complete", isError: false });
	await harness.flush();

	assert.deepEqual(wakeupReasons, ["judge_complete"]);
});

test("agent_end wakes Judge when the driver ends without judge_complete", async () => {
	const harness = makeDriverHarness();
	const wakeupReasons: string[] = [];
	await createJudgeDriver(createOptions({
		sessionFactory: harness.sessionFactory,
		onWakeup: async ({ reason }) => {
			wakeupReasons.push(reason);
			return { action: "pass", keepWatching: true };
		},
	}));

	harness.emit({ type: "agent_end" });
	await harness.flush();

	assert.deepEqual(wakeupReasons, ["agent_end"]);
});

test("agent_end does not wake Judge again after judge_complete completed", async () => {
	const harness = makeDriverHarness();
	const wakeupReasons: string[] = [];
	await createJudgeDriver(createOptions({
		sessionFactory: harness.sessionFactory,
		onWakeup: async ({ reason }) => {
			wakeupReasons.push(reason);
			return { action: "pass", keepWatching: true };
		},
	}));

	harness.emit({ type: "tool_execution_start", toolName: "judge_complete" });
	harness.emit({ type: "tool_execution_end", toolName: "judge_complete", isError: false });
	harness.emit({ type: "agent_end" });
	await harness.flush();

	assert.deepEqual(wakeupReasons, ["judge_complete"]);
});

test("stale guarded wakeups queued before successful judge_complete cannot abort completed driver", async () => {
	const harness = makeDriverHarness();
	const wakeups: Array<{ reason: string; completed: boolean }> = [];
	let releaseGuardedWakeup: (() => void) | undefined;

	const driver = await createJudgeDriver(createOptions({
		sessionFactory: harness.sessionFactory,
		onWakeup: async ({ reason, summary }) => {
			wakeups.push({ reason, completed: summary.completed });
			if (reason === "guarded_tool_start") {
				await new Promise<void>((resolve) => {
					releaseGuardedWakeup = resolve;
				});
				return { action: "abort", reason: "stale guarded wakeup" };
			}
			return { action: "pass", keepWatching: true };
		},
	}));

	harness.emit({ type: "tool_execution_start", toolName: "bash" });
	await harness.flush();
	assert.equal(typeof releaseGuardedWakeup, "function", "guarded wakeup should be pending");

	harness.emit({ type: "tool_execution_start", toolName: "judge_complete" });
	harness.emit({ type: "tool_execution_end", toolName: "judge_complete", isError: false });
	releaseGuardedWakeup?.();
	await harness.flush();

	assert.deepEqual(wakeups, [
		{ reason: "guarded_tool_start", completed: false },
		{ reason: "judge_complete", completed: true },
	]);
	assert.equal(driver.getSummary().completed, true);
	assert.notEqual(driver.getSummary().aborted, true);
	assert.equal(driver.getSummary().abortReason, undefined);
	assert.equal(harness.disposed, false);
	assert.deepEqual(harness.userInputs, []);
});

test("agent_end wakes on the next turn after a completed turn is steered back", async () => {
	const harness = makeDriverHarness();
	const wakeups: Array<{ reason: string; completed: boolean }> = [];
	await createJudgeDriver(createOptions({
		sessionFactory: harness.sessionFactory,
		onWakeup: async ({ reason, summary }) => {
			wakeups.push({ reason, completed: summary.completed });
			return reason === "judge_complete"
				? { action: "steer", direction: "继续补齐验收证据。", keepWatching: true }
				: { action: "pass", keepWatching: true };
		},
	}));

	harness.emit({ type: "agent_start" });
	harness.emit({ type: "tool_execution_start", toolName: "judge_complete" });
	harness.emit({ type: "tool_execution_end", toolName: "judge_complete", isError: false });
	harness.emit({ type: "agent_start" });
	harness.emit({ type: "agent_end" });
	await harness.flush();

	assert.deepEqual(wakeups, [
		{ reason: "judge_complete", completed: true },
		{ reason: "agent_end", completed: false },
	]);
	assert.deepEqual(harness.userInputs, ["继续补齐验收证据。"]);
});

// 回归测试:wrapFactoryForJudgeEvents 必须透传 prototype 上的方法。
// 真 AgentSession 的 getAllTools/prompt/steer/dispose 在 prototype 上,不在 own 属性。
// 之前用 {...session} 对象展开会丢掉 prototype 方法,导致 getAllTools 返回 undefined,
// assertExpectedDriverTools 误报 "Missing judge_complete"(createJudgeDriver 内部传 expectedToolNames)。
// 改用 Proxy 后,prototype 方法必须能透传 —— 若回归到对象展开,createJudgeDriver 会抛 "Missing judge_complete"。
test("createJudgeDriver tolerates session whose methods live on the prototype (regression: proxy must forward getAllTools)", async () => {
	// 模拟真 AgentSession 结构:方法在 prototype 上,不在 own 属性
	class PrototypeMethodSession {
		subscribe() {
			return () => {};
		}
		getAllTools() {
			return [{ name: "judge_complete" }];
		}
		// eslint-disable-next-line @typescript-eslint/no-empty-function
		async prompt() {}
		// eslint-disable-next-line @typescript-eslint/no-empty-function
		async steer() {}
		// eslint-disable-next-line @typescript-eslint/no-empty-function
		async followUp() {}
		// eslint-disable-next-line @typescript-eslint/no-empty-function
		dispose() {}
	}

	const sessionFactory: DriverSessionFactory = async () => ({
		session: new PrototypeMethodSession() as any,
	});

	// createJudgeDriver 内部会调 createDriverSession(..., expectedToolNames: ["judge_complete"]),
	// 进而调 assertExpectedDriverTools → session.getAllTools()。
	// 如果包装丢了 getAllTypes(回归到 {...session} 展开或其它丢 prototype 的写法),这里会抛错。
	const driver = await createJudgeDriver(createOptions({
		sessionFactory,
		onWakeup: async () => ({ action: "pass", keepWatching: true }),
	}));

	assert.ok(driver, "createJudgeDriver should not throw when session methods are on the prototype");
});

// ---- driver 过程可视化回调测试 ----

test("getWidgetLines and getTranscriptText reflect driver transcript accumulated from subscribe events", async () => {
	let emit: ((e: DriverEvent) => void) | undefined;
	const sessionFactory: DriverSessionFactory = async () => ({
		session: {
			isStreaming: true,
			getAllTools() { return [{ name: "judge_complete" }]; },
			subscribe(callback) { emit = callback as (e: DriverEvent) => void; return () => {}; },
			async prompt() {},
			async steer() {},
			async followUp() {},
			dispose() {},
		},
	});

	const driver = await createJudgeDriver(createOptions({ sessionFactory, onWakeup: async () => ({ action: "pass", keepWatching: true }) }));

	// 初始:transcript 空,getWidgetLines 返回占位
	const beforeLines = driver.getWidgetLines();
	assert.ok(beforeLines.some((l) => /no driver output|Judge driver/i.test(l)), "empty transcript should show placeholder");

	// emit 一个 runtime 事件让 transcript 累积
	emit!({ type: "tool_execution_start", toolName: "chrome_cdp" });
	await new Promise((r) => setTimeout(r, 0));

	// 现在 getWidgetLines 应反映累积的内容(含 chrome_cdp 的 runtime 行)
	const afterLines = driver.getWidgetLines();
	assert.ok(afterLines.some((l) => /chrome_cdp/i.test(l)), "getWidgetLines should reflect accumulated tool events");
	assert.ok(driver.getTranscriptText().length > 0, "getTranscriptText should be non-empty after events");
});

test("onJudgeVerdict is called with the verdict after each wakeup", async () => {
	const sessionFactory: DriverSessionFactory = async () => ({
		session: {
			isStreaming: true,
			getAllTools() { return [{ name: "judge_complete" }]; },
			subscribe(callback) { (callback as (e: DriverEvent) => void)({ type: "agent_start" }); return () => {}; },
			async prompt() {},
			async steer() {},
			async followUp() {},
			dispose() {},
			getWidgetLines() { return []; },
			getTranscriptText() { return ""; },
		},
	});

	const verdicts: Array<{ action: string; direction?: string }> = [];
	let emit: ((e: DriverEvent) => void) | undefined;
	const sessionFactory2: DriverSessionFactory = async () => ({
		session: {
			isStreaming: true,
			getAllTools() { return [{ name: "judge_complete" }]; },
			subscribe(callback) { emit = callback as (e: DriverEvent) => void; return () => {}; },
			async prompt() {},
			async steer() {},
			async followUp() {},
			dispose() {},
			getWidgetLines() { return []; },
			getTranscriptText() { return ""; },
		},
	});

	await createJudgeDriver(createOptions({
		sessionFactory: sessionFactory2,
		onWakeup: async () => ({ action: "steer", direction: "换 cdp", keepWatching: true }),
		onJudgeVerdict: (v) => { verdicts.push(v as { action: string; direction?: string }); },
	}));

	// 触发一次需要唤醒的事件(chrome_cdp start,硬规则唤醒)
	emit!({ type: "tool_execution_start", toolName: "chrome_cdp" });
	await new Promise((r) => setTimeout(r, 10));

	assert.equal(verdicts.length, 1, "onJudgeVerdict should fire once after wakeup");
	assert.equal(verdicts[0].action, "steer");
	assert.equal(verdicts[0].direction, "换 cdp");

	// 抑制未使用变量(sessionFactory 在此测试里不用,保留以对照)
	void sessionFactory;
});

test("onTranscriptUpdate is forwarded to createDriverSession options", async () => {
	let capturedOnTranscriptUpdate: (() => void) | undefined;
	const sessionFactory: DriverSessionFactory = async (options) => {
		capturedOnTranscriptUpdate = options.onTranscriptUpdate;
		return {
			session: {
				isStreaming: true,
				getAllTools() { return [{ name: "judge_complete" }]; },
				subscribe() { return () => {}; },
				async prompt() {},
				async steer() {},
				async followUp() {},
				dispose() {},
				getWidgetLines() { return []; },
				getTranscriptText() { return ""; },
			},
		};
	};

	let transcriptUpdateCalled = false;
	await createJudgeDriver(createOptions({
		sessionFactory,
		onWakeup: async () => ({ action: "pass", keepWatching: true }),
		onTranscriptUpdate: () => { transcriptUpdateCalled = true; },
	}));

	// onTranscriptUpdate 应被透传给 session options
	assert.equal(typeof capturedOnTranscriptUpdate, "function", "onTranscriptUpdate should be forwarded to session options");
	capturedOnTranscriptUpdate!();
	assert.equal(transcriptUpdateCalled, true, "forwarded callback should invoke the original onTranscriptUpdate");
});

// ---- live.log 实时过程日志测试 ----

test("driver events append readable lines to live.log and getLiveLogPath returns the path", async () => {
	const { mkdtempSync, rmSync } = await import("node:fs");
	const os = await import("node:os");
	const pathMod = await import("node:path");
	const runDir = mkdtempSync(pathMod.join(os.tmpdir(), "ugk-live-"));

	let emit: ((e: DriverEvent) => void) | undefined;
	const sessionFactory: DriverSessionFactory = async () => ({
		session: {
			isStreaming: true,
			getAllTools() { return [{ name: "judge_complete" }]; },
			subscribe(callback) { emit = callback as (e: DriverEvent) => void; return () => {}; },
			async prompt() {},
			async steer() {},
			async followUp() {},
			dispose() {},
		},
	});

	const driver = await createJudgeDriver({
		cwd: runDir,
		runDir,
		spec: "test spec",
		sessionFactory,
		onWakeup: async () => ({ action: "steer", direction: "换 cdp", reason: "HTTP 路径被限制", keepWatching: true }),
	});

	// getLiveLogPath 指向 runDir/live.log
	const liveLogPath = driver.getLiveLogPath();
	assert.equal(liveLogPath, pathMod.join(runDir, "live.log"));

	// emit 几个事件,live.log 应被追加可读行
	emit!({ type: "tool_execution_start", toolName: "chrome_cdp", input: { url: "https://www.zhihu.com/hot" } });
	emit!({ type: "tool_execution_end", toolName: "chrome_cdp", isError: false, result: { message: "Navigated Chrome tab" } });
	emit!({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "我会先用 Chrome CDP 打开热榜。\n然后读取页面标题。" }],
		},
	} as any);
	emit!({ type: "tool_execution_end", toolName: "bash", isError: true, result: { stderr: "command failed" } });
	await new Promise((r) => setTimeout(r, 10));

	const { readFileSync } = await import("node:fs");
	const logContent = readFileSync(liveLogPath, "utf8");
	assert.doesNotMatch(logContent, /[🔄🔧🤖🧑]/u, "live.log should use ASCII markers");
	assert.ok(logContent.includes("chrome_cdp"), "live.log should contain chrome_cdp tool events");
	assert.ok(logContent.includes("started"), "live.log should mark tool start");
	assert.ok(logContent.includes("completed"), "live.log should mark tool completed");
	assert.ok(logContent.includes("FAILED"), "live.log should mark failed tools");
	assert.ok(logContent.includes("args: url=https://www.zhihu.com/hot"), "live.log should include tool args summary");
	assert.ok(logContent.includes("result: message=Navigated Chrome tab"), "live.log should include tool result summary");
	assert.ok(logContent.includes("[driver] 我会先用 Chrome CDP 打开热榜。"), "live.log should include assistant text");
	// steer verdict 也应进 live.log
	assert.ok(logContent.includes("STEER"), "live.log should contain Judge steer verdict");
	assert.ok(logContent.includes("HTTP 路径被限制"), "live.log should contain Judge verdict reason");

	rmSync(runDir, { recursive: true, force: true });
});
