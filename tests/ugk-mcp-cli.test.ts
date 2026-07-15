import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCliModule(): Promise<any> {
	return import("../bin/ugk-mcp-cli.js").catch(() => ({}));
}

test("mcp CLI recognizes only its own commands and emits doctor JSON only", async () => {
	const { isMcpCliCommand, runMcpCli } = await loadCliModule();
	assert.equal(typeof runMcpCli, "function");
	assert.equal(isMcpCliCommand(["mcp", "serve"]), true);
	assert.equal(isMcpCliCommand(["hello"]), false);
	const writes: string[] = [];
	const exitCode = await runMcpCli(["mcp", "doctor", "--json"], {
		cwd: "E:/project",
		doctor: () => ({ ok: false, status: "needs_setup", code: "MODEL_AUTH_MISSING", nextAction: "configure_model_auth" }),
		stdout: { write: (text: string) => writes.push(text) },
	});
	assert.equal(exitCode, 0);
	assert.equal(writes.length, 1);
	assert.deepEqual(JSON.parse(writes[0]), { ok: false, status: "needs_setup", code: "MODEL_AUTH_MISSING", nextAction: "configure_model_auth" });
});

test("mcp serve connects the injected server without starting on import", async () => {
	const { runMcpCli } = await loadCliModule();
	const calls: string[] = [];
	const exitCode = await runMcpCli(["mcp", "serve"], {
		createJobManager: () => ({ dispose: () => calls.push("dispose") }),
		createServer: () => ({ connect: async (transport: any) => calls.push(`connect:${transport.name}`) }),
		createTransport: () => ({ name: "stdio" }),
	});
	assert.equal(exitCode, 0);
	assert.deepEqual(calls, ["connect:stdio"]);
});

test("mcp process waits for stdin to close", async () => {
	const { waitForMcpInputClose } = await loadCliModule();
	const input: any = new EventEmitter();
	input.readableEnded = false;
	input.destroyed = false;
	let settled = false;
	const waiting = waitForMcpInputClose(input).then(() => { settled = true; });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false);
	input.emit("end");
	await waiting;
	assert.equal(settled, true);
});

test("bin dispatches mcp and auth before update and workspace trust", async () => {
	const source = readFileSync(path.join(root, "bin", "ugk.js"), "utf8");
	for (const command of ["isMcpCliCommand", "isAuthCliCommand"]) {
		assert.ok(source.indexOf(`${command}(userArgs)`) > 0);
		assert.ok(source.indexOf(`${command}(userArgs)`) < source.indexOf("const update = await runUgkUpdatePreflight"));
		assert.ok(source.indexOf(`${command}(userArgs)`) < source.indexOf("ensureWorkspaceTrusted()"));
	}
});

test("real mcp doctor bypasses the trust TUI and prints valid JSON", async () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-doctor-"));
	const agentDir = mkdtempSync(path.join(os.tmpdir(), "ugk-mcp-agent-"));
	try {
		const result = await execFileAsync(process.execPath, [path.join(root, "bin", "ugk.js"), "mcp", "doctor", "--json"], {
			cwd,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, UGK_SKIP_UPDATE_CHECK: "1" },
		});
		const diagnosis = JSON.parse(result.stdout);
		assert.equal(diagnosis.code, "WORKSPACE_UNTRUSTED");
		assert.doesNotMatch(result.stdout, /快速安全确认/);
		assert.equal(result.stderr, "");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});
