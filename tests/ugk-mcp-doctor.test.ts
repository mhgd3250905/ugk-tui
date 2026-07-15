import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { trustWorkspace } from "../bin/workspace-trust.js";

async function loadDoctor(): Promise<any> {
	return import("../mcp/doctor.js").catch(() => ({}));
}

test("doctor reports a missing workspace before other blockers", async () => {
	const { diagnoseUgk } = await loadDoctor();
	assert.equal(typeof diagnoseUgk, "function");
	const result = diagnoseUgk({ cwd: path.join(os.tmpdir(), "ugk-does-not-exist"), version: "test" });

	assert.deepEqual(result, {
		ok: false,
		status: "needs_setup",
		code: "WORKSPACE_NOT_FOUND",
		version: "test",
		workspaceRoot: null,
		nextAction: "choose_existing_workspace",
	});
});

test("doctor reports workspace trust before model auth", async () => {
	const { diagnoseUgk } = await loadDoctor();
	assert.equal(typeof diagnoseUgk, "function");
	const workspace = mkdtempSync(path.join(os.tmpdir(), "ugk-doctor-workspace-"));
	const agentDir = mkdtempSync(path.join(os.tmpdir(), "ugk-doctor-agent-"));
	try {
		writeFileSync(path.join(workspace, "package.json"), "{}", "utf8");
		const result = diagnoseUgk({ cwd: workspace, agentDir, env: {}, version: "test" });

		assert.equal(result.ok, false);
		assert.equal(result.status, "needs_approval");
		assert.equal(result.code, "WORKSPACE_UNTRUSTED");
		assert.equal(result.workspaceRoot, workspace);
		assert.equal(result.nextAction, "trust_workspace");
	} finally {
		rmSync(workspace, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("doctor reports missing model auth after workspace trust", async () => {
	const { diagnoseUgk } = await loadDoctor();
	assert.equal(typeof diagnoseUgk, "function");
	const workspace = mkdtempSync(path.join(os.tmpdir(), "ugk-doctor-workspace-"));
	const agentDir = mkdtempSync(path.join(os.tmpdir(), "ugk-doctor-agent-"));
	try {
		writeFileSync(path.join(workspace, "package.json"), "{}", "utf8");
		trustWorkspace(workspace, agentDir);
		const result = diagnoseUgk({ cwd: workspace, agentDir, env: {}, version: "test" });

		assert.equal(result.status, "needs_setup");
		assert.equal(result.code, "MODEL_AUTH_MISSING");
		assert.equal(result.nextAction, "configure_model_auth");
	} finally {
		rmSync(workspace, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("doctor returns ready when trust and auth are configured", async () => {
	const { diagnoseUgk } = await loadDoctor();
	assert.equal(typeof diagnoseUgk, "function");
	const workspace = mkdtempSync(path.join(os.tmpdir(), "ugk-doctor-workspace-"));
	const agentDir = mkdtempSync(path.join(os.tmpdir(), "ugk-doctor-agent-"));
	try {
		writeFileSync(path.join(workspace, "package.json"), "{}", "utf8");
		trustWorkspace(workspace, agentDir);
		const result = diagnoseUgk({ cwd: workspace, agentDir, env: { DEEPSEEK_API_KEY: "sk-test" }, version: "test" });

		assert.deepEqual(result, {
			ok: true,
			status: "ready",
			code: "READY",
			version: "test",
			workspaceRoot: workspace,
			nextAction: "start",
		});
	} finally {
		rmSync(workspace, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});
