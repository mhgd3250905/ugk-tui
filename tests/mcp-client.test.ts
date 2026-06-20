import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	callTool,
	closeClient,
	connectStdio,
	createMcpClient,
	listTools,
} from "../extensions/mcp/client.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stubServerPath = path.join(__dirname, "fixtures", "mcp-stub-server.mjs");
const hangingServerPath = path.join(__dirname, "fixtures", "mcp-hanging-server.mjs");

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

test("connects to a stdio stub server and lists tools", async () => {
	const client = createMcpClient({ name: "ugk-test-client", version: "1.0.0" });

	await connectStdio(client, { command: process.execPath, args: [stubServerPath] }, { timeoutMs: 1000 });
	const tools = await listTools(client, { timeoutMs: 1000 });
	await closeClient(client);

	assert.equal(Array.isArray(tools), true);
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["echo", "sum"],
	);
});

test("calls a tool and returns its content", async () => {
	const client = createMcpClient({ name: "ugk-test-client", version: "1.0.0" });

	await connectStdio(client, { command: process.execPath, args: [stubServerPath] }, { timeoutMs: 1000 });
	const result = await callTool(client, "echo", { message: "hello" }, { timeoutMs: 1000 });
	await closeClient(client);

	assert.deepEqual(result.content, [{ type: "text", text: "echo:hello" }]);
});

test("closeClient terminates the stdio child process", async () => {
	const client = createMcpClient({ name: "ugk-test-client", version: "1.0.0" });

	await connectStdio(client, { command: process.execPath, args: [stubServerPath] }, { timeoutMs: 1000 });
	assert.match(listNodeCommandLines(), /mcp-stub-server\.mjs/);

	await closeClient(client);

	await waitForNoProcess(/mcp-stub-server\.mjs/);
});

test("closeClient is idempotent", async () => {
	const client = createMcpClient({ name: "ugk-test-client", version: "1.0.0" });

	await connectStdio(client, { command: process.execPath, args: [stubServerPath] }, { timeoutMs: 1000 });

	await closeClient(client);
	await closeClient(client);
});

test("connectStdio fails with timeout when a server never responds", async () => {
	const client = createMcpClient({ name: "ugk-test-client", version: "1.0.0" });

	await assert.rejects(
		connectStdio(client, { command: process.execPath, args: [hangingServerPath] }, { timeoutMs: 100 }),
		/timeout|timed out|Request timed out/i,
	);
	await closeClient(client);
	await waitForNoProcess(/mcp-hanging-server\.mjs/);
});

test("connectStdio abort signal interrupts a pending connection", async () => {
	const client = createMcpClient({ name: "ugk-test-client", version: "1.0.0" });
	const controller = new AbortController();
	const promise = connectStdio(
		client,
		{ command: process.execPath, args: [hangingServerPath] },
		{ timeoutMs: 5000, signal: controller.signal },
	);

	controller.abort();

	await assert.rejects(promise, /abort|aborted/i);
	await closeClient(client);
	await waitForNoProcess(/mcp-hanging-server\.mjs/);
});
