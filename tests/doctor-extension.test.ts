import test from "node:test";
import assert from "node:assert/strict";
import { registerDoctor } from "../extensions/doctor/index.ts";

function makePi() {
	const commands = new Map<string, any>();
	return {
		commands,
		pi: {
			registerCommand(name: string, options: any) {
				commands.set(name, options);
			},
		},
	};
}

function makeCtx() {
	const notifications: string[] = [];
	return {
		notifications,
		ctx: {
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
			},
		},
	};
}

test("registerDoctor registers /doctor command", () => {
	const { pi, commands } = makePi();
	registerDoctor(pi as any, { checks: [] });
	assert.ok(commands.has("doctor"));
	assert.match(commands.get("doctor").description, /environment/i);
});

test("/doctor points users to the guided environment skill", async () => {
	const { pi, commands } = makePi();
	const { ctx, notifications } = makeCtx();
	registerDoctor(pi as any, {
		checks: [
			{
				id: "shell.bash",
				title: "Shell",
				category: "shell",
				run: async () => ({ status: "pass", summary: "bash available" }),
			},
			{
				id: "api.deepseek",
				title: "API",
				category: "api",
				run: async () => ({
					status: "fail",
					summary: "DeepSeek missing",
					nextSteps: ["Set DEEPSEEK_API_KEY or run /login."],
				}),
			},
		],
	});

	await assert.doesNotReject(() => commands.get("doctor").handler("", ctx));

	assert.equal(notifications.length, 1);
	assert.match(notifications[0], /UGK Environment Doctor/);
	assert.match(notifications[0], /ask the agent/i);
	assert.match(notifications[0], /bash unavailable/i);
	assert.match(notifications[0], /Chrome CDP/i);
	assert.doesNotMatch(notifications[0], /DeepSeek missing/);
});

test("/doctor migration notice does not run legacy checks", async () => {
	const { pi, commands } = makePi();
	const { ctx, notifications } = makeCtx();
	let ran = false;
	registerDoctor(pi as any, {
		checks: [
			{
				id: "chrome.cdp",
				title: "Chrome",
				category: "chrome",
				run: async () => {
					ran = true;
					throw new Error("boom");
				},
			},
		],
	});

	await commands.get("doctor").handler("", ctx);

	assert.equal(ran, false);
	assert.match(notifications[0], /UGK Environment Doctor/);
	assert.doesNotMatch(notifications[0], /boom/);
});
