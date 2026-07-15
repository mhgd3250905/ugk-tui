import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRpcJobManager } from "../../mcp/rpc-job.js";
import { createUgkMcpServer } from "../../mcp/server.js";

const file = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(file), "../..");
const rpcFixture = path.join(root, "tests", "fixtures", "ugk-rpc-task-stub.mjs");
const fixtureMode = process.env.UGK_MCP_GATEWAY_FIXTURE === "1";

function diagnosis(cwd: string, trusted: boolean) {
	return trusted
		? { ok: true, status: "ready", code: "READY", version: "test", workspaceRoot: cwd, nextAction: "start" }
		: { ok: false, status: "needs_approval", code: "WORKSPACE_UNTRUSTED", version: "test", workspaceRoot: cwd, nextAction: "trust_workspace" };
}

async function serveFixture() {
	let trusted = false;
	const doctor = ({ cwd }: { cwd: string }) => diagnosis(cwd, trusted);
	const jobManager = createRpcJobManager({
		packageRoot: root,
		doctor,
		trustWorkspaceImpl: () => { trusted = true; },
		spawnImpl: (_command: string, _args: string[], options: any) => spawn(process.execPath, [rpcFixture], options),
	});
	await createUgkMcpServer({ jobManager, doctor }).connect(new StdioServerTransport());
}

if (fixtureMode) {
	await serveFixture();
} else {
	async function connectFixture() {
		const client = new Client({ name: "ugk-gateway-integration", version: "1.0.0" });
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [file],
			env: { ...process.env, UGK_MCP_GATEWAY_FIXTURE: "1" },
		});
		await client.connect(transport);
		return client;
	}

	async function call(client: Client, args: Record<string, unknown>) {
		const result: any = await client.callTool({ name: "ugk", arguments: args });
		assert.notEqual(result.isError, true);
		return result.structuredContent;
	}

	async function waitForStatus(client: Client, runId: string, expected: string) {
		const started = Date.now();
		while (Date.now() - started < 5000) {
			const current = await call(client, { action: "status", runId });
			if (current.status === expected) return current;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error(`timed out waiting for ${expected}`);
	}

	test("bridges trust and questionnaire interactions through real STDIO", async () => {
		const cwd = mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-e2e-"));
		const client = await connectFixture();
		try {
			const pending = await call(client, { action: "start", cwd, request: "select" });
			assert.equal(pending.status, "needs_approval");
			assert.equal(pending.interaction.type, "confirm");

			await call(client, { action: "respond", runId: pending.runId, interactionId: pending.interaction.id, confirmed: true });
			const question = await waitForStatus(client, pending.runId, "needs_input");
			assert.equal(question.interaction.type, "select");
			await call(client, { action: "respond", runId: pending.runId, interactionId: question.interaction.id, value: "a" });

			const passed = await waitForStatus(client, pending.runId, "pass");
			assert.equal(passed.task, "x-search");
			assert.equal(passed.results[0].artifacts[0], "report.json");
		} finally {
			await client.close();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("returns no_match and task_failed as normal MCP outcomes", async () => {
		const cwd = mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-outcomes-"));
		const client = await connectFixture();
		try {
			const trust = await call(client, { action: "start", cwd, request: "no-match" });
			await call(client, { action: "respond", runId: trust.runId, interactionId: trust.interaction.id, confirmed: true });
			const noMatch = await waitForStatus(client, trust.runId, "no_match");
			assert.equal(noMatch.reason, "none");

			const failedRun = await call(client, { action: "start", cwd, request: "fail" });
			const failed = await waitForStatus(client, failedRun.runId, "task_failed");
			assert.equal(failed.code, "VERIFY_FAILED");
			assert.equal(failed.stage, "verify");
		} finally {
			await client.close();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("smoke arguments are explicit and reports redact API keys", async () => {
		const smoke: any = await import("../../scripts/smoke-ugk-mcp.mjs").catch(() => ({}));
		assert.equal(typeof smoke.parseSmokeArgs, "function");
		assert.equal(typeof smoke.buildSmokeReport, "function");
		const cwd = path.resolve(".");
		assert.deepEqual(smoke.parseSmokeArgs(["--cwd", cwd, "--request", "run x-search"]), { cwd, request: "run x-search" });
		assert.throws(() => smoke.parseSmokeArgs(["--cwd", "relative", "--request", "x"]), /absolute|绝对/i);
		const report = smoke.buildSmokeReport({ status: "pass", request: "sk-secret-value", artifacts: ["report.json"] });
		assert.doesNotMatch(report, /sk-secret-value/);
		assert.match(report, /REDACTED/);
	});
}
