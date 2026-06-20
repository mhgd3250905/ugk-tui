import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpRegistry } from "../extensions/mcp/registry.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stubServerPath = path.join(__dirname, "fixtures", "mcp-stub-server.mjs");
const hangingServerPath = path.join(__dirname, "fixtures", "mcp-hanging-server.mjs");

const connectOpts = {
	connectTimeoutMs: 1000,
	listToolsTimeoutMs: 1000,
};

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

test("connect caches tools for a server", async () => {
	const registry = new McpRegistry();

	const connection = await registry.connect(
		"alpha",
		{ command: process.execPath, args: [stubServerPath] },
		connectOpts,
	);

	try {
		assert.equal(connection.name, "alpha");
		assert.equal(connection.status, "connected");
		assert.deepEqual(
			connection.tools.map((tool) => tool.name),
			["echo", "sum"],
		);
		assert.equal(registry.get("alpha"), connection);
	} finally {
		await registry.disconnectAll();
	}
});

test("multiple servers are stored independently and get routes by name", async () => {
	const registry = new McpRegistry();

	const alpha = await registry.connect("alpha", { command: process.execPath, args: [stubServerPath] }, connectOpts);
	const beta = await registry.connect("beta", { command: process.execPath, args: [stubServerPath] }, connectOpts);

	try {
		assert.equal(registry.get("alpha"), alpha);
		assert.equal(registry.get("beta"), beta);
		assert.notEqual(registry.get("alpha"), registry.get("beta"));
	} finally {
		await registry.disconnectAll();
	}
});

test("callTool routes to the selected server connection", async () => {
	const registry = new McpRegistry();

	await registry.connect("alpha", { command: process.execPath, args: [stubServerPath] }, connectOpts);
	await registry.connect("beta", { command: process.execPath, args: [stubServerPath] }, connectOpts);

	try {
		const alphaResult = await registry.get("alpha")?.callTool("echo", { message: "from-alpha" }, { timeoutMs: 1000 });
		const betaResult = await registry.get("beta")?.callTool("sum", { a: 2, b: 3 }, { timeoutMs: 1000 });

		assert.deepEqual(alphaResult?.content, [{ type: "text", text: "echo:from-alpha" }]);
		assert.deepEqual(betaResult?.content, [{ type: "text", text: "5" }]);
	} finally {
		await registry.disconnectAll();
	}
});

test("disconnect closes a server child process and marks it disconnected", async () => {
	const registry = new McpRegistry();

	const connection = await registry.connect(
		"alpha",
		{ command: process.execPath, args: [stubServerPath] },
		connectOpts,
	);
	assert.match(listNodeCommandLines(), /mcp-stub-server\.mjs/);

	await registry.disconnect("alpha");

	assert.equal(connection.status, "disconnected");
	await waitForNoProcess(/mcp-stub-server\.mjs/);
});

test("disconnectAll closes every server child process", async () => {
	const registry = new McpRegistry();

	await registry.connect("alpha", { command: process.execPath, args: [stubServerPath] }, connectOpts);
	await registry.connect("beta", { command: process.execPath, args: [stubServerPath] }, connectOpts);
	assert.match(listNodeCommandLines(), /mcp-stub-server\.mjs/);

	await registry.disconnectAll();

	assert.equal(registry.get("alpha")?.status, "disconnected");
	assert.equal(registry.get("beta")?.status, "disconnected");
	await waitForNoProcess(/mcp-stub-server\.mjs/);
});

test("killAllProcesses synchronously terminates server child processes", async () => {
	const registry = new McpRegistry();

	await registry.connect("alpha", { command: process.execPath, args: [stubServerPath] }, connectOpts);
	assert.match(listNodeCommandLines(), /mcp-stub-server\.mjs/);

	registry.killAllProcesses();

	assert.equal(registry.get("alpha")?.status, "disconnected");
	await waitForNoProcess(/mcp-stub-server\.mjs/);
});

test("disconnect and disconnectAll are idempotent", async () => {
	const registry = new McpRegistry();

	await registry.connect("alpha", { command: process.execPath, args: [stubServerPath] }, connectOpts);

	await registry.disconnect("alpha");
	await registry.disconnect("alpha");
	await registry.disconnectAll();
	await registry.disconnectAll();
});

test("blocked same-name reconnect disconnects the existing connection", async () => {
	const registry = new McpRegistry();
	const connection = await registry.connect(
		"alpha",
		{ command: process.execPath, args: [stubServerPath] },
		connectOpts,
	);
	try {
		assert.equal(connection.status, "connected");

		await assert.rejects(
			registry.connect(
				"alpha",
				{ command: process.execPath, args: [stubServerPath] },
				{ ...connectOpts, canConnect: () => false },
			),
			/blocked by spawn policy/i,
		);

		assert.equal(connection.status, "disconnected");
		assert.equal(registry.get("alpha")?.status, "failed");
	} finally {
		await connection.disconnect();
		await registry.disconnectAll();
		await waitForNoProcess(/mcp-stub-server\.mjs/);
	}
});

test("connect failure rejects with a clear error and does not leave stub processes running", async () => {
	const registry = new McpRegistry();

	await assert.rejects(
		registry.connect(
			"missing",
			{ command: "ugk-missing-mcp-command-for-test", args: [] },
			{ connectTimeoutMs: 200, listToolsTimeoutMs: 200 },
		),
		/MCP server "missing" failed to connect/i,
	);

	const connection = registry.get("missing");
	assert.equal(connection?.status, "failed");
	assert.match(String(connection?.error?.message), /ugk-missing-mcp-command-for-test|ENOENT|spawn/i);
	await registry.disconnectAll();
	await waitForNoProcess(/mcp-stub-server\.mjs/);
});

test("connect timeout rejects clearly and does not leave hanging processes running", async () => {
	const registry = new McpRegistry();

	await assert.rejects(
		registry.connect(
			"hanging",
			{ command: process.execPath, args: [hangingServerPath] },
			{ connectTimeoutMs: 100, listToolsTimeoutMs: 100 },
		),
		/MCP server "hanging" failed to connect/i,
	);

	assert.equal(registry.get("hanging")?.status, "failed");
	await registry.disconnectAll();
	await waitForNoProcess(/mcp-hanging-server\.mjs/);
});

test("callTool rejects clearly after a connection has disconnected", async () => {
	const registry = new McpRegistry();
	const connection = await registry.connect(
		"alpha",
		{ command: process.execPath, args: [stubServerPath] },
		connectOpts,
	);

	await connection.disconnect();

	await assert.rejects(
		connection.callTool("echo", { message: "after-close" }, { timeoutMs: 1000 }),
		/MCP server "alpha" is disconnected/i,
	);
});
