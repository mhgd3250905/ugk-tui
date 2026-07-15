import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

async function loadServerModule(): Promise<any> {
	return import("../mcp/server.js").catch(() => ({}));
}

function createManager() {
	const calls: any[] = [];
	let disposed = false;
	return {
		calls,
		get disposed() { return disposed; },
		async start(input: any) { calls.push(["start", input]); return { runId: "run-1", status: "busy" }; },
		status(runId: string) { calls.push(["status", runId]); return { runId, status: "task_failed", code: "VERIFY_FAILED" }; },
		async respond(input: any) { calls.push(["respond", input]); return { runId: input.runId, status: "needs_setup" }; },
		async cancel(runId: string) { calls.push(["cancel", runId]); return { runId, status: "no_match" }; },
		dispose() { disposed = true; },
	};
}

async function connectServer(jobManager: any, doctor = () => ({ status: "ready", code: "READY" })) {
	const { createUgkMcpServer } = await loadServerModule();
	assert.equal(typeof createUgkMcpServer, "function");
	const server = createUgkMcpServer({ jobManager, doctor });
	const client = new Client({ name: "ugk-test", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return { client, server };
}

test("lists exactly one ugk tool with an action union", async () => {
	const manager = createManager();
	const { client, server } = await connectServer(manager);
	try {
		const listed = await client.listTools();
		assert.deepEqual(listed.tools.map((tool) => tool.name), ["ugk"]);
		assert.deepEqual(listed.tools[0].inputSchema.properties.action.enum, ["start", "status", "respond", "cancel"]);
		assert.match(listed.tools[0].description ?? "", /已有 task/);
	} finally {
		await client.close();
		await server.close();
	}
});

test("delegates all actions and returns business outcomes as normal structured results", async () => {
	const manager = createManager();
	const { client, server } = await connectServer(manager, ({ cwd }: any) => ({ status: "needs_setup", code: "MODEL_AUTH_MISSING", workspaceRoot: cwd }));
	try {
		const cases = [
			[{ action: "status", cwd: "E:/project" }, "needs_setup"],
			[{ action: "start", cwd: "E:/project", request: "do it" }, "busy"],
			[{ action: "status", runId: "run-1" }, "task_failed"],
			[{ action: "respond", runId: "run-1", interactionId: "ui-1", value: "answer" }, "needs_setup"],
			[{ action: "cancel", runId: "run-1" }, "no_match"],
		] as const;
		for (const [args, expectedStatus] of cases) {
			const result: any = await client.callTool({ name: "ugk", arguments: args });
			assert.notEqual(result.isError, true);
			assert.equal(result.structuredContent.status, expectedStatus);
			assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
		}
		assert.deepEqual(manager.calls, [
			["start", { cwd: "E:/project", request: "do it" }],
			["status", "run-1"],
			["respond", { runId: "run-1", interactionId: "ui-1", value: "answer", confirmed: undefined, cancelled: undefined }],
			["cancel", "run-1"],
		]);
	} finally {
		await client.close();
		await server.close();
	}
});

test("marks invalid actions and missing fields as MCP errors", async () => {
	const manager = createManager();
	const { client, server } = await connectServer(manager);
	try {
		for (const args of [{ action: "unknown" }, { action: "start", cwd: "E:/project" }, { action: "status" }]) {
			const result: any = await client.callTool({ name: "ugk", arguments: args });
			assert.equal(result.isError, true);
		}
	} finally {
		await client.close();
		await server.close();
	}
});

test("disposes the job manager when the server closes", async () => {
	const manager = createManager();
	const { client, server } = await connectServer(manager);
	await client.close();
	await server.close();
	assert.equal(manager.disposed, true);
});
