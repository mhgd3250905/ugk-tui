import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "ugk-rpc-task-stub.mjs");

async function loadJobModule(): Promise<any> {
	return import("../mcp/rpc-job.js").catch(() => ({}));
}

function ready(workspaceRoot: string) {
	return { ok: true, status: "ready", code: "READY", version: "test", workspaceRoot, nextAction: "start" };
}

function fixtureSpawner(records: any[]) {
	return (command: string, args: string[], options: any) => {
		const child = spawn(process.execPath, [fixture], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
		records.push({ command, args, options, child });
		return child;
	};
}

async function waitFor(read: () => any, predicate: (value: any) => boolean, timeoutMs = 3000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const value = read();
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out waiting for RPC job state");
}

test("starts a trusted RPC child and maps run_task PASS and FAIL", async () => {
	const { createRpcJobManager } = await loadJobModule();
	assert.equal(typeof createRpcJobManager, "function");
	const cwd = mkdtempSync(path.join(os.tmpdir(), "ugk-rpc-job-"));
	const spawns: any[] = [];
	const manager = createRpcJobManager({ packageRoot: cwd, doctor: () => ready(cwd), spawnImpl: fixtureSpawner(spawns) });
	try {
		const started = await manager.start({ cwd, request: "pass" });
		assert.equal(started.status, "running");
		const passed = await waitFor(() => manager.status(started.runId), (value) => value.status === "pass");
		assert.equal(passed.task, "x-search");
		assert.equal(passed.results[0].artifacts[0], "report.json");
		assert.equal(spawns[0].options.cwd, cwd);
		assert.equal(spawns[0].options.env.UGK_TASK_GATEWAY, "1");
		assert.equal(spawns[0].options.env.UGK_SKIP_WORKSPACE_TRUST, undefined);
		assert.match(spawns[0].args.join(" "), /bin[\\/]ugk\.js --mode rpc --no-session/);

		const failedRun = await manager.start({ cwd, request: "fail" });
		const failed = await waitFor(() => manager.status(failedRun.runId), (value) => value.status === "task_failed");
		assert.equal(failed.code, "VERIFY_FAILED");
		assert.equal(failed.stage, "verify");
		assert.equal(failed.attempts, 4);
		assert.deepEqual(failed.verifyFailures, [{ assertion: "has results", expected: "items", actual: "empty" }]);

		const blockedRun = await manager.start({ cwd, request: "fail-then-blocked" });
		const preserved = await waitFor(() => manager.status(blockedRun.runId), (value) => value.status === "task_failed");
		assert.equal(preserved.code, "VERIFY_FAILED");
		assert.deepEqual(preserved.verifyFailures, [{ assertion: "has results", expected: "items", actual: "empty" }]);
	} finally {
		manager.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("reports routing and selected task stages while a run is active", async () => {
	const { createRpcJobManager } = await loadJobModule();
	const cwd = mkdtempSync(path.join(os.tmpdir(), "ugk-rpc-stage-"));
	const spawns: any[] = [];
	const manager = createRpcJobManager({ packageRoot: cwd, doctor: () => ready(cwd), spawnImpl: fixtureSpawner(spawns) });
	try {
		const started = await manager.start({ cwd, request: "task-start" });
		assert.equal(started.stage, "routing");
		const executing = await waitFor(() => manager.status(started.runId), (value) => value.task === "x-search");
		assert.equal(executing.stage, "task");
	} finally {
		manager.dispose();
		if (spawns[0]) await waitFor(() => spawns[0].child.exitCode, (value) => value !== null);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("holds an untrusted run for approval then starts after trust", async () => {
	const { createRpcJobManager } = await loadJobModule();
	assert.equal(typeof createRpcJobManager, "function");
	const cwd = mkdtempSync(path.join(os.tmpdir(), "ugk-rpc-trust-"));
	const spawns: any[] = [];
	let trusted = false;
	let trustedPath = "";
	const manager = createRpcJobManager({
		packageRoot: cwd,
		doctor: () => trusted ? ready(cwd) : { ok: false, status: "needs_approval", code: "WORKSPACE_UNTRUSTED", version: "test", workspaceRoot: cwd, nextAction: "trust_workspace" },
		trustWorkspaceImpl: (workspace: string) => { trusted = true; trustedPath = workspace; },
		spawnImpl: fixtureSpawner(spawns),
	});
	try {
		const pending = await manager.start({ cwd, request: "pass" });
		assert.equal(pending.status, "needs_approval");
		assert.equal(pending.interaction.type, "confirm");
		assert.equal(spawns.length, 0);

		await manager.respond({ runId: pending.runId, interactionId: pending.interaction.id, confirmed: true });
		assert.equal(trustedPath, cwd);
		assert.equal(spawns.length, 1);
		await waitFor(() => manager.status(pending.runId), (value) => value.status === "pass");
	} finally {
		manager.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("bridges RPC input and approval interactions back to the child", async () => {
	const { createRpcJobManager } = await loadJobModule();
	assert.equal(typeof createRpcJobManager, "function");
	const cwd = mkdtempSync(path.join(os.tmpdir(), "ugk-rpc-ui-"));
	try {
		for (const scenario of ["select", "input", "editor", "confirm"]) {
			const manager = createRpcJobManager({ packageRoot: cwd, doctor: () => ready(cwd), spawnImpl: fixtureSpawner([]) });
			const started = await manager.start({ cwd, request: scenario });
			const waiting = await waitFor(
				() => manager.status(started.runId),
				(value) => value.status === (scenario === "confirm" ? "needs_approval" : "needs_input"),
			);
			assert.equal(waiting.interaction.type, scenario);
			await manager.respond({
				runId: started.runId,
				interactionId: waiting.interaction.id,
				...(scenario === "confirm" ? { confirmed: true } : { value: "answer" }),
			});
			const passed = await waitFor(() => manager.status(started.runId), (value) => value.status === "pass");
			assert.match(JSON.stringify(passed.events), scenario === "confirm" ? /"confirmed":true/ : /"value":"answer"/);
			manager.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("maps no_match and child crashes without transport ambiguity", async () => {
	const { createRpcJobManager } = await loadJobModule();
	assert.equal(typeof createRpcJobManager, "function");
	const cwd = mkdtempSync(path.join(os.tmpdir(), "ugk-rpc-outcomes-"));
	const manager = createRpcJobManager({ packageRoot: cwd, doctor: () => ready(cwd), spawnImpl: fixtureSpawner([]) });
	try {
		const noMatchRun = await manager.start({ cwd, request: "no-match" });
		const noMatch = await waitFor(() => manager.status(noMatchRun.runId), (value) => value.status === "no_match");
		assert.equal(noMatch.reason, "none");

		const crashRun = await manager.start({ cwd, request: "crash" });
		const crashed = await waitFor(() => manager.status(crashRun.runId), (value) => value.status === "internal_error");
		assert.equal(crashed.code, "RPC_CRASHED");
	} finally {
		manager.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("allows one active run, cancels it, and disposes its child", async () => {
	const { createRpcJobManager } = await loadJobModule();
	assert.equal(typeof createRpcJobManager, "function");
	const cwd = mkdtempSync(path.join(os.tmpdir(), "ugk-rpc-cancel-"));
	const spawns: any[] = [];
	const manager = createRpcJobManager({ packageRoot: cwd, doctor: () => ready(cwd), spawnImpl: fixtureSpawner(spawns) });
	try {
		const started = await manager.start({ cwd, request: "hold" });
		const busy = await manager.start({ cwd, request: "pass" });
		assert.equal(busy.status, "busy");
		assert.equal(busy.runId, started.runId);

		const cancelled = await manager.cancel(started.runId);
		assert.equal(cancelled.status, "cancelled");
		await waitFor(() => spawns[0].child.exitCode, (value) => value !== null);

		const held = await manager.start({ cwd, request: "hold" });
		manager.dispose();
		await waitFor(() => spawns[1].child.exitCode, (value) => value !== null);
		assert.equal(manager.status(held.runId).status, "cancelled");
	} finally {
		manager.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("cancel does not overwrite a terminal outcome", async () => {
	const { createRpcJobManager } = await loadJobModule();
	const cwd = mkdtempSync(path.join(os.tmpdir(), "ugk-rpc-terminal-cancel-"));
	const manager = createRpcJobManager({ packageRoot: cwd, doctor: () => ready(cwd), spawnImpl: fixtureSpawner([]) });
	try {
		const started = await manager.start({ cwd, request: "pass" });
		await waitFor(() => manager.status(started.runId), (value) => value.status === "pass");
		assert.equal((await manager.cancel(started.runId)).status, "pass");
	} finally {
		manager.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("caps progress events", async () => {
	const { createRpcJobManager } = await loadJobModule();
	assert.equal(typeof createRpcJobManager, "function");
	const cwd = mkdtempSync(path.join(os.tmpdir(), "ugk-rpc-events-"));
	const manager = createRpcJobManager({ packageRoot: cwd, doctor: () => ready(cwd), spawnImpl: fixtureSpawner([]), maxEvents: 2 });
	try {
		const started = await manager.start({ cwd, request: "events" });
		const passed = await waitFor(() => manager.status(started.runId), (value) => value.status === "pass");
		assert.equal(passed.events.length, 2);
		assert.match(JSON.stringify(passed.events), /event-4/);
	} finally {
		manager.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});
