import test from "node:test";
import assert from "node:assert/strict";
import {
	createFlowDriverSession,
	type DriverSessionFactory,
	type FlowDriverSessionOptions,
} from "../extensions/flow/driver-session.ts";
import { DriverTranscriptTail } from "../extensions/flow/driver-view.ts";

function createOptions(): FlowDriverSessionOptions {
	return {
		cwd: "E:/AII/ugk-core",
		taskId: "task-a",
		runId: "run-001",
		runDir: "E:/AII/ugk-core/.flow/task-a/run-001",
		initialPrompt: "start driver",
	};
}

test("driver session starts with the generated prompt and records transcript tail", async () => {
	const prompts: string[] = [];
	const factory: DriverSessionFactory = async () => ({
		session: {
			isStreaming: false,
			subscribe(callback) {
				callback({
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: "hello" },
				});
				return () => {};
			},
			async prompt(text) {
				prompts.push(text);
			},
			async steer() {},
			async followUp() {},
			dispose() {},
		},
	});

	const driver = await createFlowDriverSession(createOptions(), factory);
	await driver.start();

	assert.deepEqual(prompts, ["start driver"]);
	assert.equal(driver.getTranscriptText(), "hello");
});

test("driver session sends steer while streaming and prompt while idle", async () => {
	const calls: string[] = [];
	let streaming = true;
	const factory: DriverSessionFactory = async () => ({
		session: {
			get isStreaming() {
				return streaming;
			},
			subscribe() {
				return () => {};
			},
			async prompt(text) {
				calls.push(`prompt:${text}`);
			},
			async steer(text) {
				calls.push(`steer:${text}`);
			},
			async followUp(text) {
				calls.push(`followUp:${text}`);
			},
			dispose() {},
		},
	});
	const driver = await createFlowDriverSession(createOptions(), factory);

	await driver.sendUserInput("stop now");
	streaming = false;
	await driver.sendUserInput("continue");

	assert.deepEqual(calls, ["steer:stop now", "prompt:continue"]);
});

test("driver session returns empty widget fallback", async () => {
	const factory: DriverSessionFactory = async () => ({
		session: {
			isStreaming: false,
			subscribe() {
				return () => {};
			},
			async prompt() {},
			async steer() {},
			async followUp() {},
			dispose() {},
		},
	});
	const driver = await createFlowDriverSession(createOptions(), factory);

	assert.deepEqual(driver.getWidgetLines(), ["Flow driver task-a/run-001", "(no driver output yet)"]);
});

test("driver session dispose unsubscribes before disposing session", async () => {
	const calls: string[] = [];
	const factory: DriverSessionFactory = async () => ({
		session: {
			isStreaming: false,
			subscribe() {
				return () => {
					calls.push("unsubscribe");
				};
			},
			async prompt() {},
			async steer() {},
			async followUp() {},
			dispose() {
				calls.push("dispose");
			},
		},
	});
	const driver = await createFlowDriverSession(createOptions(), factory);

	driver.dispose();

	assert.deepEqual(calls, ["unsubscribe", "dispose"]);
});

test("driver transcript tail appends deltas and keeps the last thirty lines", () => {
	const transcript = new DriverTranscriptTail();

	transcript.appendText("hello");
	transcript.appendText(" world\nline 2");
	for (let index = 3; index <= 35; index += 1) {
		transcript.appendText(`\nline ${index}`);
	}

	const lines = transcript.toText().split("\n");
	assert.equal(lines.length, 30);
	assert.equal(lines[0], "line 6");
	assert.equal(lines[29], "line 35");
});
