import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getFlowCleanupPaths, runFlowCleanupOnce } from "../bin/flow-cleanup.js";

function tempHome() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ugk-flow-cleanup-"));
}

function stderrBuffer() {
	let text = "";
	return {
		write(chunk) {
			text += String(chunk);
		},
		get text() {
			return text;
		},
	};
}

test("marker skips cleanup", async () => {
	const homeDir = tempHome();
	const paths = getFlowCleanupPaths(homeDir);
	fs.writeFileSync(paths.marker, "done");
	fs.writeFileSync(paths.masterKey, "secret");
	fs.mkdirSync(paths.keysDir);
	const stderr = stderrBuffer();

	const result = await runFlowCleanupOnce({ homeDir, stderr });

	assert.deepEqual(result, { cleaned: false, reason: "already" });
	assert.equal(fs.existsSync(paths.masterKey), true);
	assert.equal(fs.existsSync(paths.keysDir), true);
	assert.equal(stderr.text, "");
});

test("cleanup removes home flow key data and writes marker", async () => {
	const homeDir = tempHome();
	const paths = getFlowCleanupPaths(homeDir);
	fs.writeFileSync(paths.masterKey, "secret");
	fs.mkdirSync(paths.keysDir);
	fs.writeFileSync(path.join(paths.keysDir, "a"), "1");
	const stderr = stderrBuffer();

	const result = await runFlowCleanupOnce({ homeDir, stderr });

	assert.equal(result.cleaned, true);
	assert.equal(fs.existsSync(paths.masterKey), false);
	assert.equal(fs.existsSync(paths.keysDir), false);
	assert.match(fs.readFileSync(paths.marker, "utf8"), /^\d{4}-\d{2}-\d{2}T/);
	assert.match(stderr.text, /cleaning up removed Flow module data/);
});

test("cleanup removes large keys directory recursively", async () => {
	const homeDir = tempHome();
	const paths = getFlowCleanupPaths(homeDir);
	for (let index = 0; index < 250; index += 1) {
		const dir = path.join(paths.keysDir, String(index % 10));
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `${index}.json`), "{}");
	}

	await runFlowCleanupOnce({ homeDir, stderr: stderrBuffer() });

	assert.equal(fs.existsSync(paths.keysDir), false);
	assert.equal(fs.existsSync(paths.marker), true);
});

test("cleanup failure does not throw and leaves marker absent for retry", async () => {
	const homeDir = tempHome();
	const paths = getFlowCleanupPaths(homeDir);
	const stderr = stderrBuffer();
	const fakeFs = {
		existsSync(filePath) {
			return filePath === paths.masterKey;
		},
		rmSync() {
			throw new Error("locked");
		},
		writeFileSync() {
			throw new Error("must not write marker");
		},
	};

	const result = await runFlowCleanupOnce({ homeDir, stderr, fs: fakeFs });

	assert.equal(result.cleaned, false);
	assert.equal(result.reason, "error");
	assert.match(stderr.text, /flow cleanup partial: locked/);
	assert.equal(fs.existsSync(paths.marker), false);
});

test("cleanup only targets home flow data, not project .flow", async () => {
	const homeDir = tempHome();
	const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-flow-project-"));
	const projectFlow = path.join(projectDir, ".flow");
	const paths = getFlowCleanupPaths(homeDir);
	fs.mkdirSync(projectFlow);
	fs.writeFileSync(path.join(projectFlow, "task.json"), "{}");
	fs.writeFileSync(paths.masterKey, "secret");

	await runFlowCleanupOnce({ homeDir, stderr: stderrBuffer() });

	assert.equal(fs.existsSync(path.join(projectFlow, "task.json")), true);
	assert.equal(fs.existsSync(paths.masterKey), false);
});
