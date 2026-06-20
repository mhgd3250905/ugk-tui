import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import registerUgkExtension from "../extensions/index.ts";
import { registerMcp, createMcpDoctorCheck } from "../extensions/mcp/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stubServerPath = path.join(__dirname, "fixtures", "mcp-stub-server.mjs");

function makePi(initialTools: string[] = []) {
	const handlers = new Map<string, Function[]>();
	const commands = new Map<string, { handler: Function }>();
	const registeredTools = new Map<string, any>();
	let activeTools = [...initialTools];

	const pi = {
		handlers,
		commands,
		registeredTools,
		registerCommand(name: string, options: { handler: Function }) {
			commands.set(name, options);
		},
		registerTool(tool: any) {
			registeredTools.set(tool.name, tool);
			if (!activeTools.includes(tool.name)) {
				activeTools.push(tool.name);
			}
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
		on(eventName: string, handler: Function) {
			const existing = handlers.get(eventName) ?? [];
			existing.push(handler);
			handlers.set(eventName, existing);
		},
	};

	return pi;
}

async function emit(pi: ReturnType<typeof makePi>, eventName: string, event: any = {}, ctx: any = {}) {
	const results = [];
	for (const handler of pi.handlers.get(eventName) ?? []) {
		results.push(await handler(event, ctx));
	}
	return results;
}

function makeCtx(cwd: string, overrides: Record<string, unknown> = {}) {
	const notifications: string[] = [];
	const confirmations: string[] = [];
	return {
		cwd,
		hasUI: true,
		notifications,
		confirmations,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			async confirm(title: string, body?: string) {
				confirmations.push([title, body].filter(Boolean).join("\n"));
				return true;
			},
		},
		...overrides,
	};
}

function writeProjectConfig(cwd: string, servers: Record<string, unknown>) {
	fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
}

function listNodeCommandLines() {
	if (process.platform !== "win32") {
		return execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
	}

	return execFileSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-Command",
			"Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Select-Object -ExpandProperty CommandLine",
		],
		{ encoding: "utf8" },
	);
}

async function waitForNoProcess(commandLinePattern: RegExp) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (!commandLinePattern.test(listNodeCommandLines())) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.doesNotMatch(listNodeCommandLines(), commandLinePattern);
}

test("session_start connects configured MCP servers and registers tools", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-start-"));
	writeProjectConfig(cwd, {
		alpha: { command: process.execPath, args: [stubServerPath] },
	});
	const pi = makePi(["greet"]);
	const ctx = makeCtx(cwd);

	const state = registerMcp(pi as any);
	await emit(pi, "session_start", { reason: "startup" }, ctx);

	assert.equal(pi.registeredTools.has("alpha__echo"), true);
	assert.equal(pi.registeredTools.has("alpha__sum"), true);
	assert.deepEqual(state.serverTools.get("alpha"), ["alpha__echo", "alpha__sum"]);
	assert.equal(state.failedServers?.size, 0);

	await emit(pi, "session_shutdown", { reason: "quit" }, ctx);
	await waitForNoProcess(/mcp-stub-server\.mjs/);
});

test("no MCP config has zero side effects", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-empty-"));
	const pi = makePi(["greet"]);
	const ctx = makeCtx(cwd);

	registerMcp(pi as any);
	await emit(pi, "session_start", { reason: "startup" }, ctx);

	assert.equal(pi.registeredTools.size, 0);
	assert.deepEqual(pi.getActiveTools(), ["greet"]);
});

test("session_shutdown disconnects all registry connections", async () => {
	let disconnects = 0;
	const registry = {
		connections: new Map(),
		async connect() {
			return { name: "alpha", status: "connected", tools: [] };
		},
		async disconnectAll() {
			disconnects += 1;
		},
	};
	const pi = makePi();
	const ctx = makeCtx(process.cwd());
	registerMcp(pi as any, {
		registry: registry as any,
		loadConfig: () => ({
			servers: new Map([["alpha", { name: "alpha", scope: "user", config: { command: "node" } }]]),
			errors: [],
		}),
	});

	await emit(pi, "session_start", { reason: "startup" }, ctx);
	await emit(pi, "session_shutdown", { reason: "quit" }, ctx);
	await emit(pi, "session_shutdown", { reason: "quit" }, ctx);

	assert.equal(disconnects, 2);
});

test("before_agent_start appends MCP server instructions", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-instructions-"));
	writeProjectConfig(cwd, {
		alpha: { command: process.execPath, args: [stubServerPath] },
	});
	const pi = makePi();
	const ctx = makeCtx(cwd);

	registerMcp(pi as any);
	await emit(pi, "session_start", { reason: "startup" }, ctx);
	const injected = (await emit(pi, "before_agent_start", { systemPrompt: "Base prompt" }, ctx)).at(-1);

	assert.match(injected.systemPrompt, /Base prompt/);
	assert.match(injected.systemPrompt, /MCP server instructions/);
	assert.match(injected.systemPrompt, /alpha/);
	assert.match(injected.systemPrompt, /Use echo for test messages/);

	await emit(pi, "session_shutdown", { reason: "quit" }, ctx);
});

test("doctor MCP check validates config and reads registry without spawning", async () => {
	let connectCalled = 0;
	const check = createMcpDoctorCheck({
		registry: {
			connections: new Map([
				["alpha", { status: "connected" }],
				["beta", { status: "failed" }],
			]),
			async connect() {
				connectCalled += 1;
			},
		} as any,
		loadConfig: () => ({
			servers: new Map([
				["alpha", { name: "alpha", scope: "project", config: { command: "node" } }],
				["beta", { name: "beta", scope: "local", config: { command: "node" } }],
			]),
			errors: [{ scope: "project", filePath: ".mcp.json", message: "bad", serverName: "broken" }],
		}),
		cwd: () => process.cwd(),
	});

	const result = await check.run();

	assert.equal(connectCalled, 0);
	assert.equal(result.status, "warn");
	assert.match(result.summary, /configured: 2/);
	assert.match(result.summary, /connected: 1/);
	assert.match(result.summary, /failed: 1/);
	assert.match(result.details!.join("\n"), /project: alpha/);
	assert.match(result.details!.join("\n"), /local: beta/);
	assert.match(result.details!.join("\n"), /bad/);
});

test("end-to-end registered MCP tool calls the stub server", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-e2e-"));
	writeProjectConfig(cwd, {
		alpha: { command: process.execPath, args: [stubServerPath] },
	});
	const pi = makePi();
	const ctx = makeCtx(cwd);

	registerMcp(pi as any);
	await emit(pi, "session_start", { reason: "startup" }, ctx);

	const echo = pi.registeredTools.get("alpha__echo");
	const result = await echo.execute("call-1", { message: "hello" }, undefined, undefined, ctx);

	assert.deepEqual(result.content, [{ type: "text", text: "echo:hello" }]);

	await emit(pi, "session_shutdown", { reason: "quit" }, ctx);
	await waitForNoProcess(/mcp-stub-server\.mjs/);
});

test("root extension wires MCP command, hooks, and doctor check", async () => {
	const pi = {
		...makePi(),
		registerFlag() {},
		registerShortcut() {},
		getFlag() {
			return undefined;
		},
		getSessionName() {
			return "demo";
		},
	};

	registerUgkExtension(pi as any);

	assert.equal(pi.commands.has("mcp"), true);
	assert.ok((pi.handlers.get("session_start") ?? []).length >= 1);
	assert.ok((pi.handlers.get("session_shutdown") ?? []).length >= 1);
	assert.ok((pi.handlers.get("before_agent_start") ?? []).length >= 1);

	const notifications: string[] = [];
	await pi.commands.get("doctor")!.handler("", {
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
	});
	assert.match(notifications.join("\n"), /MCP/);
});
