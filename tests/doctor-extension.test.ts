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
	assert.match(commands.get("doctor").description, /core UGK/);
});

test("/doctor reports check results without throwing", async () => {
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
	assert.match(notifications[0], /UGK Doctor/);
	assert.match(notifications[0], /\[pass\] Shell/);
	assert.match(notifications[0], /\[fail\] API/);
	assert.match(notifications[0], /Set DEEPSEEK_API_KEY or run \/login\./);
});

test("/doctor converts thrown checks into failure rows", async () => {
	const { pi, commands } = makePi();
	const { ctx, notifications } = makeCtx();
	registerDoctor(pi as any, {
		checks: [
			{
				id: "chrome.cdp",
				title: "Chrome",
				category: "chrome",
				run: async () => {
					throw new Error("boom");
				},
			},
		],
	});

	await commands.get("doctor").handler("", ctx);

	assert.match(notifications[0], /\[fail\] Chrome\s+chrome\.cdp check failed: boom/);
});
