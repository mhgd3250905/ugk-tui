import test from "node:test";
import assert from "node:assert/strict";
import {
	createDriverSession,
	createFlowDriverSession,
	type DriverSessionFactory,
	type DriverSessionOptions,
} from "../extensions/shared/driver-session.ts";

function createOptions(): DriverSessionOptions {
	return {
		cwd: "E:/AII/ugk-core",
		taskId: "task-a",
		runId: "run-001",
		runDir: "E:/AII/ugk-core/.flow/task-a/run-001",
		initialPrompt: "start driver",
		label: "Shared driver task-a/run-001",
	};
}

test("shared driver session exposes the base creator and Flow compatibility alias", async () => {
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

	assert.equal(createFlowDriverSession, createDriverSession);

	const driver = await createDriverSession(createOptions(), factory);
	await driver.start();

	assert.deepEqual(prompts, ["start driver"]);
	assert.equal(driver.getTranscriptText(), "hello");
	assert.deepEqual(driver.getWidgetLines(), ["Shared driver task-a/run-001", "hello"]);
	assert.equal(driver.sessionFile, "driver-session.jsonl");
	assert.equal(driver.visibleSession, sessionHandle);
});
