import test from "node:test";
import assert from "node:assert/strict";
import registerUiTitlebar from "../extensions/ui-titlebar.ts";

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("titlebar spinner stops itself if the captured extension context becomes stale", async () => {
	const handlers = new Map<string, Function>();
	let stale = false;
	const errors: Error[] = [];
	const pi = {
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		getSessionName() {
			if (stale) {
				throw new Error("This extension ctx is stale after session replacement or reload.");
			}
			return "demo";
		},
	};
	const ctx = {
		ui: {
			setTitle() {
				if (stale) {
					throw new Error("This extension ctx is stale after session replacement or reload.");
				}
			},
		},
	};
	const onUncaught = (error: Error) => {
		errors.push(error);
	};

	process.prependListener("uncaughtException", onUncaught);
	try {
		registerUiTitlebar(pi as any);
		await handlers.get("agent_start")!({}, ctx);
		await wait(120);
		stale = true;
		await wait(220);
	} finally {
		process.removeListener("uncaughtException", onUncaught);
		await handlers.get("session_shutdown")?.({ reason: "test" }, ctx);
	}

	assert.deepEqual(errors.map((error) => error.message), []);
});
