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
