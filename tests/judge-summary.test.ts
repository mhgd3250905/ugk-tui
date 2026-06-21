import test from "node:test";
import assert from "node:assert/strict";
import { createJudgeDriver } from "../extensions/judge/judge-driver.ts";
import { buildDecidePrompt } from "../extensions/judge/judge-prompts.ts";
import { extractTail } from "../extensions/judge/judge-utils.ts";
import type { DriverSessionFactory } from "../extensions/shared/driver-session.ts";

type DriverEvent = {
	type?: string;
	toolName?: string;
	isError?: boolean;
	input?: unknown;
	result?: unknown;
	assistantMessageEvent?: {
		type?: string;
		delta?: string;
	};
};

function makeDriverHarness() {
	let listener: ((event: DriverEvent) => void) | undefined;
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
			async steer() {},
			async followUp() {},
			dispose() {},
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
	};
}

test("extractTail keeps the latest tool calls and latest assistant output", () => {
	const tail = extractTail([
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "old assistant\n" } },
		{ type: "tool_execution_start", toolName: "read", input: { path: "old.md" } },
		{ type: "tool_execution_end", toolName: "read", result: "old result" },
		{ type: "tool_execution_start", toolName: "bash", input: { command: "git status --short" } },
		{ type: "tool_execution_end", toolName: "bash", result: "clean" },
		{ type: "tool_execution_start", toolName: "write", input: { path: "E:/out.md" } },
		{ type: "tool_execution_end", toolName: "write", isError: true, result: "permission denied" },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "new assistant output" } },
	], 2);

	assert.deepEqual(tail.toolCalls.map((call) => call.toolName), ["bash", "write"]);
	assert.deepEqual(tail.toolCalls.map((call) => call.failed), [false, true]);
	assert.match(tail.toolCalls[0].argsSummary, /git status --short/);
	assert.match(tail.toolCalls[1].resultSummary, /permission denied/);
	assert.equal(tail.assistantOutput, "new assistant output");
});

test("extractTail treats turn boundaries as assistant output boundaries", () => {
	const tail = extractTail([
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "old assistant" } },
		{ type: "agent_end" },
		{ type: "agent_start" },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "new assistant" } },
		{ type: "agent_end" },
		{ type: "agent_start" },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "latest assistant" } },
	]);

	assert.equal(tail.assistantOutput, "latest assistant");
	assert.deepEqual(tail.toolCalls, []);
});

test("judge driver maintains structured summary, artifacts, and wakeup tail", async () => {
	const harness = makeDriverHarness();
	const wakeups: any[] = [];
	const driver = await createJudgeDriver({
		cwd: "E:/AII/ugk-core",
		runDir: "E:/AII/ugk-core/.judge/run-001",
		spec: "官方最新知乎热榜，禁止第三方聚合",
		sessionFactory: harness.sessionFactory,
		onWakeup: async ({ summary, tail }) => {
			wakeups.push({ summary, tail });
			return { action: "pass", keepWatching: true };
		},
	});

	harness.emit({
		type: "tool_execution_start",
		toolName: "chrome_cdp",
		input: { url: "https://tophub.today/n/mproPpoq6O" },
	});
	await harness.flush();
	harness.emit({
		type: "tool_execution_end",
		toolName: "chrome_cdp",
		result: { text: "200 OK from tophub.today" },
	});
	harness.emit({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "拿到了第三方聚合数据。" },
	});
	harness.emit({
		type: "tool_execution_start",
		toolName: "write",
		input: { path: "E:/AII/ugk-core/out/zhihu.md", content: "# result" },
	});
	await harness.flush();

	const summary = driver.getSummary();
	assert.deepEqual(summary.pathsTried, [
		{
			toolName: "chrome_cdp",
			argsSummary: "url=https://tophub.today/n/mproPpoq6O",
			resultSummary: "text=200 OK from tophub.today",
			failed: false,
		},
		{
			toolName: "write",
			argsSummary: "path=E:/AII/ugk-core/out/zhihu.md",
			resultSummary: "",
			failed: false,
		},
	]);
	assert.deepEqual(summary.artifacts, [{ path: "E:/AII/ugk-core/out/zhihu.md", kind: "file" }]);
	assert.equal(summary.runningTools.length, 1);
	assert.equal(summary.runningTools[0].toolName, "write");
	assert.equal(wakeups.at(-1).tail.assistantOutput, "拿到了第三方聚合数据。");
	assert.deepEqual(wakeups.at(-1).tail.toolCalls.map((call: any) => call.toolName), ["chrome_cdp", "write"]);
});

test("buildDecidePrompt includes spec, structured summary, and transcript tail", () => {
	const prompt = buildDecidePrompt(
		"禁止第三方聚合",
		{
			pathsTried: [
				{ toolName: "chrome_cdp", argsSummary: "url=https://tophub.today", resultSummary: "200 OK", failed: false },
			],
			artifacts: [{ path: "E:/out.md", kind: "file" }],
			runningTools: [{ toolName: "bash", argsSummary: "python transcribe.py", startedAtMs: 10, elapsedMs: 120000 }],
			turnCount: 1,
			completed: false,
		},
		{
			toolCalls: [
				{ toolName: "chrome_cdp", argsSummary: "url=https://tophub.today", resultSummary: "200 OK", failed: false },
			],
			assistantOutput: "第三方聚合数据看起来可用",
		},
	);

	assert.match(prompt, /RequirementsSpec/);
	assert.match(prompt, /DriverSummary/);
	assert.match(prompt, /TranscriptTail/);
	assert.match(prompt, /runningTools/);
	assert.match(prompt, /python transcribe\.py/);
	assert.match(prompt, /tophub\.today/);
	assert.match(prompt, /对照 acceptance/);
});
