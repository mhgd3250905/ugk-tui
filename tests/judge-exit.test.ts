import test from "node:test";
import assert from "node:assert/strict";
import { createJudgeDriver } from "../extensions/judge/judge-driver.ts";
import {
	abortJudge,
	createJudgeState,
	enterAligning,
	recordJudgeEscalation,
	recordJudgeSteer,
} from "../extensions/judge/judge-state.ts";
import {
	registerJudge,
	setJudgeDriverFactoryForTests,
	setJudgeVerdictProviderForTests,
} from "../extensions/judge/judge.ts";
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
	const userInputs: string[] = [];
	let disposed = false;
	const sessionFactory: DriverSessionFactory = async () => ({
		session: {
			isStreaming: true,
			getAllTools() {
				return [{ name: "judge_complete" }];
			},
			subscribe(callback) {
				listener = callback;
				return () => {};
			},
			async prompt() {},
			async steer(text) {
				userInputs.push(text);
			},
			async followUp() {},
			dispose() {
				disposed = true;
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
		userInputs,
		get disposed() {
			return disposed;
		},
	};
}

function createOptions(overrides: Partial<Parameters<typeof createJudgeDriver>[0]> = {}) {
	return {
		cwd: "E:/AII/ugk-core",
		runDir: "E:/AII/ugk-core/.judge/run-001",
		spec: "实现 Judge 阶段 5",
		...overrides,
	};
}

function makePi() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const entries: Array<{ customType: string; data: any }> = [];
	const sentMessages: Array<{ message: any; options: any }> = [];

	return {
		commands,
		handlers,
		entries,
		sentMessages,
		pi: {
			registerCommand(name: string, options: any) {
				commands.set(name, options);
			},
			registerTool() {},
			setActiveTools() {},
			on(event: string, handler: Function) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			sendMessage(message: any, options: any) {
				sentMessages.push({ message, options });
			},
			sendUserMessage() {},
			appendEntry(customType: string, data: any) {
				entries.push({ customType, data });
			},
		},
	};
}

function makeCtx() {
	const notifications: Array<{ message: string; type?: string }> = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		sessionManager: {
			getEntries() {
				return [];
			},
		},
		ui: {
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
			select(_title: string, options: string[]) {
				return options[0];
			},
			editor() {
				return "";
			},
		},
	};
	return { ctx, notifications };
}

function assistantWithSpec() {
	return {
		role: "assistant",
		content: [
			{
				type: "text",
				text: `\`\`\`json
{
  "goal": "完成 Judge 阶段 5",
  "hardConstraints": ["不能无限 steer"],
  "acceptance": ["超限上报", "abort 会停止 driver"],
  "forbidden": ["做阶段 6"],
  "context": "阶段 5"
}
\`\`\``,
			},
		],
	};
}

test("recordJudgeSteer increments steerCount without changing phase", () => {
	const state = recordJudgeSteer(enterAligning(createJudgeState()));

	assert.equal(state.phase, "aligning");
	assert.equal(state.steerCount, 1);
});

test("recordJudgeEscalation stops watching and records readable summary", () => {
	const state = recordJudgeEscalation(enterAligning(createJudgeState()), "maxSteer reached");

	assert.equal(state.phase, "aligning");
	assert.equal(state.keepWatching, false);
	assert.equal(state.summary, "maxSteer reached");
});

test("abortJudge records a terminal aborted state", () => {
	const state = abortJudge(recordJudgeSteer(enterAligning(createJudgeState())));

	assert.equal(state.phase, "aborted");
	assert.equal(state.keepWatching, false);
	assert.equal(state.steerCount, 1);
});

test("driver stops steering and escalates when maxSteer is reached", async () => {
	const harness = makeDriverHarness();
	const escalations: any[] = [];
	const driver = await createJudgeDriver(createOptions({
		sessionFactory: harness.sessionFactory,
		maxSteer: 2,
		onEscalate: async (context) => {
			escalations.push(context);
		},
		onWakeup: async () => ({
			action: "steer",
			direction: "继续按 Spec 修正。",
			keepWatching: true,
		}),
	}));

	harness.emit({ type: "tool_execution_start", toolName: "bash", input: { command: "git status --short" } });
	await harness.flush();
	harness.emit({ type: "tool_execution_start", toolName: "write", input: { path: "E:/out.md" } });
	await harness.flush();
	harness.emit({ type: "tool_execution_start", toolName: "chrome_cdp", input: { url: "https://example.com" } });
	await harness.flush();

	assert.deepEqual(harness.userInputs, ["继续按 Spec 修正。"]);
	assert.equal(driver.getSummary().steerCount, 2);
	assert.equal(escalations.length, 1);
	assert.match(escalations[0].reason, /maxSteer/i);
	assert.equal(escalations[0].summary.steerCount, 2);
});

test("abort verdict disposes the driver and records abort reason", async () => {
	const harness = makeDriverHarness();
	const driver = await createJudgeDriver(createOptions({
		sessionFactory: harness.sessionFactory,
		onWakeup: async () => ({ action: "abort", reason: "连续同类失败，无法推进" }),
	}));

	harness.emit({ type: "tool_execution_start", toolName: "bash" });
	await harness.flush();

	assert.equal(harness.disposed, true);
	assert.equal(driver.getSummary().aborted, true);
	assert.equal(driver.getSummary().abortReason, "连续同类失败，无法推进");
});

test("extension abort wakeup updates Judge state and notifies the user", async () => {
	const { pi, commands, handlers, entries } = makePi();
	const { ctx, notifications } = makeCtx();
	setJudgeVerdictProviderForTests(async () => ({ action: "abort", reason: "违反硬约束" }));
	setJudgeDriverFactoryForTests(async (options: any) => ({
		async start() {
			await options.onWakeup({
				reason: "tool_error",
				summary: { pathsTried: [], artifacts: [], turnCount: 1, completed: false, steerCount: 0 },
				tail: { toolCalls: [], assistantOutput: "" },
				transcript: "",
				decidePrompt: "decide",
			});
		},
		dispose() {},
		getSummary() {
			return { pathsTried: [], artifacts: [], turnCount: 0, completed: false, steerCount: 0 };
		},
	}));
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setJudgeVerdictProviderForTests(undefined);
	}

	assert.equal(entries.at(-1)?.data.phase, "aborted");
	assert.equal(entries.at(-1)?.data.keepWatching, false);
	assert.match(notifications.map((entry) => entry.message).join("\n"), /违反硬约束/);
});

test("extension passes maxSteer and reports driver escalation", async () => {
	const { pi, commands, handlers, entries, sentMessages } = makePi();
	const { ctx, notifications } = makeCtx();
	const received: any[] = [];
	setJudgeDriverFactoryForTests(async (options: any) => {
		received.push(options);
		return {
			async start() {
				await options.onEscalate({
					reason: "maxSteer reached (5/5)",
					summary: {
						pathsTried: [
							{ toolName: "bash", argsSummary: "command=npm test", resultSummary: "failed", failed: true },
						],
						artifacts: [{ path: "E:/out.md", kind: "file" }],
						lastError: "bash failed",
						turnCount: 1,
						completed: false,
						steerCount: 5,
					},
					tail: {
						toolCalls: [
							{ toolName: "bash", argsSummary: "command=npm test", resultSummary: "failed", failed: true },
						],
						assistantOutput: "仍在重复失败",
					},
					transcript: "[tool] bash failed",
				});
			},
			dispose() {},
			getSummary() {
				return { pathsTried: [], artifacts: [], turnCount: 0, completed: false, steerCount: 0 };
			},
		};
	});
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
	}

	assert.equal(received.at(-1).maxSteer, 5);
	assert.match(notifications.map((entry) => entry.message).join("\n"), /maxSteer reached/);
	assert.equal(entries.at(-1)?.data.phase, "driving");
	assert.equal(entries.at(-1)?.data.keepWatching, false);
	assert.match(entries.at(-1)?.data.summary, /DriverSummary/);
	assert.match(entries.at(-1)?.data.summary, /command=npm test/);
	assert.match(entries.at(-1)?.data.summary, /TranscriptTail/);
	assert.equal(sentMessages.at(-1)?.message.customType, "judge-escalation");
	assert.equal(sentMessages.at(-1)?.message.display, true);
	assert.deepEqual(sentMessages.at(-1)?.options, { triggerTurn: false });
	assert.match(sentMessages.at(-1)?.message.content, /仍在重复失败/);
});
