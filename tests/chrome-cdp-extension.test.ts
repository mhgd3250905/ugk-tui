import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerChromeCdp } from "../extensions/chrome-cdp/index.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousCdpPort = process.env.UGK_CDP_PORT;
const testAgentDir = mkdtempSync(path.join(os.tmpdir(), "ugk-cdp-extension-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
process.on("exit", () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousCdpPort === undefined) delete process.env.UGK_CDP_PORT;
	else process.env.UGK_CDP_PORT = previousCdpPort;
	rmSync(testAgentDir, { recursive: true, force: true });
});

function makePi() {
	delete process.env.UGK_CDP_PORT;
	rmSync(path.join(testAgentDir, "settings.json"), { force: true });
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

function makeCtx(confirmResult: boolean | string = true) {
	const notifications: string[] = [];
	const selections: Array<{ title: string; options: string[] }> = [];
	const confirms: Array<{ title: string; message: string }> = [];
	return {
		notifications,
		selections,
		confirms,
		ctx: {
			hasUI: true,
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
				confirm: async (title: string, message: string) => {
					confirms.push({ title, message });
					return confirmResult === true;
				},
				select: async (title: string, options: string[]) => {
					selections.push({ title, options });
					return typeof confirmResult === "string" ? confirmResult : confirmResult ? options[0] : options.at(-1);
				},
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

test("/cdp with no args opens an action menu", async () => {
	const { pi, commands } = makePi();
	const { ctx, notifications, selections } = makeCtx("Tabs");
	registerChromeCdp(pi as any, {
		getStatus: async () => ({ online: false, port: 9222, error: "offline" }),
		listTabs: async () => [{ id: "tab-1", type: "page", title: "Private", url: "https://private.example.com" }],
	});

	await commands.get("cdp").handler("", ctx);

	assert.equal(selections.length, 1);
	assert.equal(selections[0].title, "Chrome CDP");
	assert.deepEqual(selections[0].options, [
		"Status",
		"Tabs",
		"Launch Chrome",
		"Mode: ask",
		"Mode: on",
		"Mode: off",
		"Set port",
		"Exit",
	]);
	assert.match(notifications.join("\n"), /tab-1/);
});

test("/cdp port reports invalid values without throwing", async () => {
	const { pi, commands } = makePi();
	const { ctx, notifications } = makeCtx();
	const statusPorts: number[] = [];
	registerChromeCdp(pi as any, {
		getStatus: async (port) => {
			statusPorts.push(port);
			return { online: false, port, error: "offline" };
		},
		listTabs: async () => [],
	});

	const command = commands.get("cdp");
	await assert.doesNotReject(() => command.handler("port nope", ctx));
	await command.handler("status", ctx);

	assert.match(notifications.join("\n"), /Invalid CDP port/);
	assert.deepEqual(statusPorts, [9222]);
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

test("chrome_cdp can be allowed for the current session without prompting again", async () => {
	const allowForSession = "Allow for this session";
	const { pi, tools } = makePi();
	const { ctx, selections } = makeCtx(allowForSession);
	let tabsCalled = 0;
	registerChromeCdp(pi as any, {
		listTabs: async () => {
			tabsCalled += 1;
			return [{ id: "tab-1", type: "page", title: "Private", url: "https://private.example.com" }];
		},
	});

	await tools.get("chrome_cdp").execute(
		"tool-1",
		{ action: "tabs", reason: "Requires logged-in Chrome session", normalAccessAttempted: true },
		undefined,
		undefined,
		ctx,
	);
	await tools.get("chrome_cdp").execute(
		"tool-2",
		{ action: "tabs", reason: "Requires logged-in Chrome session", normalAccessAttempted: true },
		undefined,
		undefined,
		ctx,
	);

	assert.equal(tabsCalled, 2);
	assert.equal(selections.length, 1);
	assert.deepEqual(selections[0].options, ["Allow once", "Allow for this session", "Deny"]);
});
