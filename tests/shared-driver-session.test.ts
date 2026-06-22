import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
	createDriverSession,
	createDriverResourceLoaderOptions,
	type DriverSessionFactory,
	type DriverSessionOptions,
} from "../extensions/shared/driver-session.ts";

function createOptions(): DriverSessionOptions {
	return {
		cwd: "E:/AII/ugk-core",
		taskId: "task-a",
		runId: "run-001",
		runDir: "E:/AII/ugk-core/.judge/task-a/run-001",
		initialPrompt: "start driver",
		label: "Shared driver task-a/run-001",
	};
}

test("shared driver session exposes the base creator", async () => {
	const prompts: string[] = [];
	const sessionHandle = {
		sessionFile: "driver-session.jsonl",
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
	const factory: DriverSessionFactory = async () => ({ session: sessionHandle });

	const driver = await createDriverSession(createOptions(), factory);
	await driver.start();

	assert.deepEqual(prompts, ["start driver"]);
	assert.equal(driver.getTranscriptText(), "hello");
	assert.deepEqual(driver.getWidgetLines(), ["Shared driver task-a/run-001", "hello"]);
	assert.equal(driver.sessionFile, "driver-session.jsonl");
	assert.equal(driver.visibleSession, sessionHandle);
});

test("driver session can collect assistant text for a single prompt without transcript diffing", async () => {
	let listener: ((event: any) => void) | undefined;
	const prompts: string[] = [];
	const promptOptions: any[] = [];
	const sessionHandle = {
		isStreaming: false,
		subscribe(callback: (event: any) => void) {
			listener = callback;
			listener({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "old verdict" },
			});
			return () => {};
		},
		async prompt(text: string, options?: any) {
			prompts.push(text);
			promptOptions.push(options);
			listener?.({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: `response for ${text}` },
			});
		},
		async steer() {},
		async followUp() {},
		dispose() {},
	};
	const factory: DriverSessionFactory = async () => ({ session: sessionHandle });
	const driver = await createDriverSession(createOptions(), factory);

	await driver.start();
	const first = await driver.ask("first");
	await driver.sendUserInput("third");
	const second = await driver.ask("second");

	assert.deepEqual(prompts, ["start driver", "first", "third", "second"]);
	assert.deepEqual(promptOptions, [
		{ source: "extension" },
		{ source: "extension" },
		{ source: "extension" },
		{ source: "extension" },
	]);
	assert.equal(first, "response for first");
	assert.equal(second, "response for second");
	assert.equal(driver.getTranscriptText(), "old verdictresponse for start driverresponse for firstresponse for thirdresponse for second");
});

test("driver resource loader can inject an explicit agent definition", () => {
	const agentDefinitionPath = path.resolve("agents/driver.md");
	const options = createDriverResourceLoaderOptions({
		cwd: "E:/workspace",
		agentDir: "C:/Users/demo/.pi/agent",
		agentDefinitionPath,
	});

	assert.equal(typeof options.agentsFilesOverride, "function");
	const overridden = options.agentsFilesOverride!({
		agentsFiles: [{ path: "E:/workspace/AGENTS.md", content: "project context" }],
	});

	assert.equal(overridden.agentsFiles.at(-1)?.path, agentDefinitionPath);
	assert.match(overridden.agentsFiles.at(-1)?.content ?? "", /^---\nname: driver/m);
	assert.match(overridden.agentsFiles.at(-1)?.content ?? "", /model: deepseek\/deepseek-v4-pro/);
});

test("driver resource loader can inject isolated Driver and Judge definitions", () => {
	const cases = [
		{
			name: "driver",
			agentDefinitionPath: path.resolve("agents/driver.md"),
			expectedPromptText: "你是 Judge 模式里的 Driver",
		},
		{
			name: "judge",
			agentDefinitionPath: path.resolve("agents/judge.md"),
			expectedPromptText: "你是 Judge 模式里的 Judge",
		},
	];

	for (const entry of cases) {
		const options = createDriverResourceLoaderOptions({
			cwd: path.resolve("."),
			agentDir: path.join(os.tmpdir(), "ugk-agent-test"),
			agentDefinitionPath: entry.agentDefinitionPath,
		});
		const overridden = options.agentsFilesOverride!({ agentsFiles: [] });

		assert.equal(overridden.agentsFiles.at(-1)?.path, entry.agentDefinitionPath);
		assert.match(overridden.agentsFiles.at(-1)?.content ?? "", new RegExp(entry.expectedPromptText));
	}
});
