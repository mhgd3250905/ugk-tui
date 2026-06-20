import test from "node:test";
import assert from "node:assert/strict";
import { registerMcpCommand, type McpCommandState } from "../extensions/mcp/commands.ts";
import { formatMcpStatus } from "../extensions/mcp/formatter.ts";
import { createMcpPermissionState } from "../extensions/mcp/permissions.ts";
import { createMcpToolDefinition } from "../extensions/mcp/tools.ts";

function makePi(initialTools: string[] = []) {
	const commands = new Map<string, { handler: Function }>();
	const registeredTools = new Map<string, any>();
	let activeTools = [...initialTools];
	const setActiveToolsCalls: string[][] = [];

	const pi = {
		commands,
		registeredTools,
		setActiveToolsCalls,
		registerCommand(name: string, options: { handler: Function }) {
			commands.set(name, options);
		},
		registerTool(tool: any) {
			registeredTools.set(tool.name, tool);
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
			setActiveToolsCalls.push([...names]);
		},
	};

	return pi;
}

function makeState(overrides: Partial<McpCommandState> = {}): McpCommandState {
	return {
		registry: {
			connections: new Map(),
			async disconnectAll() {},
		},
		permissionState: createMcpPermissionState("ask"),
		serverTools: new Map(),
		failedServers: new Map(),
		warnings: [],
		staleServerTools: new Map(),
		...overrides,
	};
}

async function runMcp(
	pi: ReturnType<typeof makePi>,
	args: string,
): Promise<{ notifications: string[] }> {
	const notifications: string[] = [];
	await pi.commands.get("mcp")!.handler(args, {
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
	});
	return { notifications };
}

test("/mcp status renders connected servers, tool count, mode, and failed servers", async () => {
	const state = makeState({
		registry: {
			connections: new Map([
				["alpha", { name: "alpha", status: "connected", tools: [{ name: "echo" }] }],
			]) as any,
			async disconnectAll() {},
		},
		serverTools: new Map([["alpha", ["alpha__echo"]]]),
		failedServers: new Map([["beta", "spawn failed"]]),
	});
	const pi = makePi();
	registerMcpCommand(pi as any, state);

	const directText = formatMcpStatus(state);
	assert.match(directText, /connected/i);
	assert.match(directText, /tool/i);
	assert.match(directText, /mode/i);
	assert.match(directText, /failed/i);
	assert.match(directText, /alpha/);
	assert.match(directText, /beta/);

	const { notifications } = await runMcp(pi, "status");
	assert.equal(notifications.length, 1);
	assert.match(notifications[0], /connected/i);
	assert.match(notifications[0], /tool/i);
	assert.match(notifications[0], /mode/i);
	assert.match(notifications[0], /failed/i);
});

test("/mcp on off ask switches permission mode", async () => {
	const state = makeState();
	const pi = makePi();
	registerMcpCommand(pi as any, state);

	await runMcp(pi, "on");
	assert.equal(state.permissionState.mode, "on");

	await runMcp(pi, "off");
	assert.equal(state.permissionState.mode, "off");

	await runMcp(pi, "ask");
	assert.equal(state.permissionState.mode, "ask");
});

test("/mcp disable removes only that server's tools and preserves non-MCP tools", async () => {
	const state = makeState({
		serverTools: new Map([
			["alpha", ["alpha__echo", "alpha__sum"]],
			["beta", ["beta__read"]],
		]),
	});
	const pi = makePi(["greet", "alpha__echo", "beta__read", "alpha__sum"]);
	registerMcpCommand(pi as any, state);

	await runMcp(pi, "disable alpha");

	assert.deepEqual(pi.setActiveToolsCalls.at(-1), ["greet", "beta__read"]);
});

test("/mcp enable adds that server's tools without duplicates", async () => {
	const state = makeState({
		serverTools: new Map([["alpha", ["alpha__echo", "alpha__sum"]]]),
	});
	const pi = makePi(["greet", "alpha__echo"]);
	registerMcpCommand(pi as any, state);

	await runMcp(pi, "enable alpha");

	assert.deepEqual(pi.setActiveToolsCalls.at(-1), ["greet", "alpha__echo", "alpha__sum"]);
});

test("/mcp reload disconnects, invokes reload, registers new tools, and updates state", async () => {
	let disconnected = false;
	let reloadCalled = 0;
	const state = makeState({
		registry: {
			connections: new Map([["alpha", { name: "alpha", status: "connected", tools: [] }]]) as any,
			async disconnectAll() {
				disconnected = true;
			},
		},
		serverTools: new Map([["alpha", ["alpha__old"]]]),
	});
	const pi = makePi(["alpha__old"]);
	registerMcpCommand(pi as any, state, {
		async reload() {
			reloadCalled += 1;
			return {
				connections: [
					{ name: "alpha", status: "connected", tools: [{ name: "echo", inputSchema: { type: "object" } }] },
				] as any[],
			};
		},
	});

	await runMcp(pi, "reload");

	assert.equal(disconnected, true);
	assert.equal(reloadCalled, 1);
	assert.deepEqual(state.serverTools.get("alpha"), ["alpha__echo"]);
	assert.equal(pi.registeredTools.has("alpha__echo"), true);
});

test("/mcp reload uses pre-registered startup tools without duplicate registration warnings", async () => {
	let registerCalls = 0;
	const state = makeState({
		serverTools: new Map([["alpha", ["alpha__echo"]]]),
		warnings: [],
	});
	const pi = makePi(["alpha__echo"]);
	registerMcpCommand(pi as any, state, {
		async reload() {
			return {
				connections: [
					{ name: "alpha", status: "connected", tools: [{ name: "echo", inputSchema: { type: "object" } }] },
				] as any[],
				registered: new Map([["alpha", ["alpha__echo"]]]),
				warnings: [],
			};
		},
		registerMcpTools() {
			registerCalls += 1;
			return { registered: [], registeredByServer: new Map(), skipped: [], warnings: ["duplicate"] };
		},
	});

	await runMcp(pi, "reload");

	assert.equal(registerCalls, 0);
	assert.deepEqual(state.serverTools.get("alpha"), ["alpha__echo"]);
	assert.deepEqual(state.warnings, []);
});

test("/mcp reload removes vanished server tools from active set and never calls unregisterTool", async () => {
	const state = makeState({
		registry: {
			connections: new Map([["alpha", { name: "alpha", status: "connected", tools: [] }]]) as any,
			async disconnectAll() {},
		},
		serverTools: new Map([
			["alpha", ["alpha__echo"]],
			["beta", ["beta__read"]],
		]),
	});
	const pi = {
		...makePi(["greet", "alpha__echo", "beta__read"]),
		unregisterTool() {
			throw new Error("unregisterTool must not be called");
		},
	};
	registerMcpCommand(pi as any, state, {
		async reload() {
			return {
				connections: [
					{ name: "alpha", status: "connected", tools: [{ name: "new", inputSchema: { type: "object" } }] },
				] as any[],
			};
		},
	});

	await runMcp(pi as any, "reload");

	assert.deepEqual(pi.setActiveToolsCalls.at(-1), ["greet"]);
	assert.deepEqual(state.serverTools.get("alpha"), ["alpha__new"]);
	assert.equal(state.serverTools.has("beta"), false);
	assert.deepEqual(state.staleServerTools.get("beta"), ["beta__read"]);
});

test("/mcp reload clears stale marker when a vanished server returns", async () => {
	const state = makeState({
		registry: {
			connections: new Map([["alpha", { name: "alpha", status: "connected", tools: [] }]]) as any,
			async disconnectAll() {},
		},
		serverTools: new Map([["alpha", ["alpha__echo"]]]),
		staleServerTools: new Map([["beta", ["beta__read"]]]),
	});
	const pi = makePi(["greet", "alpha__echo"]);
	registerMcpCommand(pi as any, state, {
		async reload() {
			return {
				connections: [
					{ name: "alpha", status: "connected", tools: [{ name: "echo", inputSchema: { type: "object" } }] },
					{ name: "beta", status: "connected", tools: [{ name: "read", inputSchema: { type: "object" } }] },
				] as any[],
			};
		},
	});

	await runMcp(pi, "reload");

	assert.equal(state.staleServerTools.has("beta"), false);
	assert.doesNotMatch(formatMcpStatus(state), /stale servers:.*beta/i);
});

test("stale tool execution returns disconnected without reconnecting", async () => {
	let callAttempts = 0;
	let reconnectAttempts = 0;
	const connection = {
		name: "beta",
		status: "connected",
		tools: [{ name: "read", inputSchema: { type: "object" } }],
		async callTool() {
			callAttempts += 1;
			if (this.status !== "connected") {
				throw new Error('MCP server "beta" is disconnected; cannot call tool "read"');
			}
			return { content: [{ type: "text", text: "ok" }] };
		},
		async disconnect() {
			this.status = "disconnected";
		},
		async connect() {
			reconnectAttempts += 1;
		},
	};
	const definition = createMcpToolDefinition(connection as any, connection.tools[0] as any);
	const state = makeState({
		registry: {
			connections: new Map([["beta", connection]]) as any,
			async disconnectAll() {
				await connection.disconnect();
			},
		},
		serverTools: new Map([["beta", ["beta__read"]]]),
	});
	const pi = makePi(["beta__read"]);
	registerMcpCommand(pi as any, state, {
		async reload() {
			return { connections: [] };
		},
	});

	await runMcp(pi, "reload");
	await assert.rejects(
		() => definition.execute("call-1", {}, undefined, undefined, {}),
		/disconnected/i,
	);

	assert.equal(callAttempts, 1);
	assert.equal(reconnectAttempts, 0);
});

test("unknown command and missing server notify clearly without throwing", async () => {
	const state = makeState();
	const pi = makePi();
	registerMcpCommand(pi as any, state);

	const unknown = await runMcp(pi, "wat");
	assert.match(unknown.notifications.join("\n"), /unknown|未知/i);

	const missingDisable = await runMcp(pi, "disable missing");
	assert.match(missingDisable.notifications.join("\n"), /missing|not found|未找到|不存在/i);

	const missingEnable = await runMcp(pi, "enable");
	assert.match(missingEnable.notifications.join("\n"), /server|usage|用法|缺少/i);
});
