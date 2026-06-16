import test from "node:test";
import assert from "node:assert/strict";
import { registerChromeCdp } from "../extensions/chrome-cdp/index.ts";

function makePi() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	return {
		tools,
		commands,
		pi: {
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand(name: string, options: any) {
				commands.set(name, options);
			},
		},
	};
}

function makeCtx(confirmResult = true) {
	const notifications: string[] = [];
	return {
		notifications,
		ctx: {
			hasUI: true,
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
				confirm: async () => confirmResult,
			},
		},
	};
}

test("registerChromeCdp registers chrome_cdp tool and /cdp command", () => {
	const { pi, tools, commands } = makePi();

	registerChromeCdp(pi as any);

	assert.ok(tools.has("chrome_cdp"));
	assert.ok(commands.has("cdp"));
	assert.match(tools.get("chrome_cdp").description, /Do not use for public web search/);
});

test("/cdp command manages ask on off modes and port", async () => {
	const { pi, commands } = makePi();
	const { ctx, notifications } = makeCtx();
	registerChromeCdp(pi as any, {
		getStatus: async () => ({ online: false, port: 9222, error: "offline" }),
		listTabs: async () => [],
	});

	const command = commands.get("cdp");
	await command.handler("off", ctx);
	await command.handler("on", ctx);
	await command.handler("ask", ctx);
	await command.handler("port 9444", ctx);
	await command.handler("status", ctx);

	assert.match(notifications.join("\n"), /off/);
	assert.match(notifications.join("\n"), /on/);
	assert.match(notifications.join("\n"), /ask/);
	assert.match(notifications.join("\n"), /9444/);
});

test("chrome_cdp tool blocks browser operations when mode is off", async () => {
	const { pi, tools, commands } = makePi();
	const { ctx } = makeCtx();
	registerChromeCdp(pi as any, { listTabs: async () => [] });
	await commands.get("cdp").handler("off", ctx);

	const result = await tools.get("chrome_cdp").execute(
		"tool-1",
		{ action: "tabs", reason: "Needs logged-in Chrome", normalAccessAttempted: true },
		undefined,
		undefined,
		ctx,
	);

	assert.match(result.content[0].text, /CDP is off/);
});

test("chrome_cdp tool asks for confirmation in ask mode before browser operations", async () => {
	const { pi, tools } = makePi();
	const { ctx } = makeCtx(true);
	let tabsCalled = false;
	registerChromeCdp(pi as any, {
		listTabs: async () => {
			tabsCalled = true;
			return [{ id: "tab-1", type: "page", title: "Private", url: "https://private.example.com" }];
		},
	});

	const result = await tools.get("chrome_cdp").execute(
		"tool-1",
		{ action: "tabs", reason: "Requires logged-in Chrome session", normalAccessAttempted: true },
		undefined,
		undefined,
		ctx,
	);

	assert.equal(tabsCalled, true);
	assert.match(result.content[0].text, /tab-1/);
});

test("chrome_cdp tool refuses non-status actions when normal access was not attempted", async () => {
	const { pi, tools } = makePi();
	const { ctx } = makeCtx(true);
	let tabsCalled = false;
	registerChromeCdp(pi as any, {
		listTabs: async () => {
			tabsCalled = true;
			return [];
		},
	});

	const result = await tools.get("chrome_cdp").execute(
		"tool-1",
		{ action: "tabs", reason: "Open a public page", normalAccessAttempted: false },
		undefined,
		undefined,
		ctx,
	);

	assert.equal(tabsCalled, false);
	assert.match(result.content[0].text, /ordinary access/i);
});
