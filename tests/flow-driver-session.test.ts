import test from "node:test";
import assert from "node:assert/strict";
import {
	createFlowDriverSession,
	createFlowDriverResourceLoaderOptions,
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
	const sessionHandle = {
		isStreaming: false,
		subscribe(callback: (event: any) => void) {
			callback({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "hello" },
			});
			return () => {};
		},
		async prompt(text: string) {
			prompts.push(text);
		},
		async steer() {},
		async followUp() {},
		dispose() {},
	};
	const factory: DriverSessionFactory = async () => ({
		session: sessionHandle,
	});

	const driver = await createFlowDriverSession(createOptions(), factory);
	await driver.start();

	assert.deepEqual(prompts, ["start driver"]);
	assert.equal(driver.getTranscriptText(), "hello");
	assert.equal(driver.visibleSession, sessionHandle);
});

test("driver session fails when an expected tool is missing from the driver environment", async () => {
	const factory: DriverSessionFactory = async () => ({
		session: {
			isStreaming: false,
			getAllTools() {
				return [{ name: "read" }, { name: "bash" }];
			},
			subscribe() {
				return () => {};
			},
			async prompt() {},
			async steer() {},
			async followUp() {},
			dispose() {},
		},
	});

	await assert.rejects(
		() => createFlowDriverSession({ ...createOptions(), expectedToolNames: ["chrome_cdp"] }, factory),
		/Flow driver environment initialization failed\. Missing required capabilities: chrome_cdp\. Please update or restart UGK, then retry\./,
	);
});

test("driver resource loader explicitly includes the bundled UGK extension", () => {
	const options = createFlowDriverResourceLoaderOptions({
		cwd: "E:/workspace",
		agentDir: "C:/Users/demo/.pi/agent",
	});

	assert.equal(options.cwd, "E:/workspace");
	assert.equal(options.agentDir, "C:/Users/demo/.pi/agent");
	assert.ok(options.additionalExtensionPaths?.some((extensionPath) => extensionPath.endsWith("extensions\\index.ts") || extensionPath.endsWith("extensions/index.ts")));
});

test("driver session notifies when transcript receives text deltas", async () => {
	let listener: ((event: any) => void) | undefined;
	let updates = 0;
	const factory: DriverSessionFactory = async () => ({
		session: {
			isStreaming: false,
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

	const driver = await createFlowDriverSession({ ...createOptions(), onTranscriptUpdate: () => updates += 1 }, factory);
	listener!({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "hello" },
	});

	assert.equal(driver.getTranscriptText(), "hello");
	assert.equal(updates, 1);
});

test("driver session ignores non-text transcript events for update callback", async () => {
	let listener: ((event: any) => void) | undefined;
	let updates = 0;
	const factory: DriverSessionFactory = async () => ({
		session: {
			isStreaming: false,
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

	await createFlowDriverSession({ ...createOptions(), onTranscriptUpdate: () => updates += 1 }, factory);
	listener!({ type: "message_update", assistantMessageEvent: { type: "tool_call_delta", delta: "ignored" } });

	assert.equal(updates, 0);
});

test("driver session appends runtime tool execution events to transcript", async () => {
	let listener: ((event: any) => void) | undefined;
	let updates = 0;
	const factory: DriverSessionFactory = async () => ({
		session: {
			isStreaming: false,
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

	const driver = await createFlowDriverSession({ ...createOptions(), onTranscriptUpdate: () => updates += 1 }, factory);
	listener!({ type: "agent_start" });
	listener!({ type: "tool_execution_start", toolName: "chrome_cdp" });
	listener!({ type: "tool_execution_end", toolName: "chrome_cdp", isError: false });
	listener!({ type: "agent_end" });

	assert.equal(
		driver.getTranscriptText(),
		[
			"[runtime] driver turn started",
			"[tool] chrome_cdp started",
			"[tool] chrome_cdp completed",
			"[runtime] driver turn ended",
		].join("\n"),
	);
	assert.equal(updates, 4);
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
