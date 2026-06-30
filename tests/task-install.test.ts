import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isTaskInstallCommand, runTaskInstall } from "../bin/task-install.js";

const spec = {
	goal: "统计文本字素数量",
	hardConstraints: ["只写输出目录"],
	acceptance: ["result.json 包含 graphemes"],
	forbidden: [],
	context: "",
};

const contract = {
	outputDir: "<runtime>",
	artifacts: [{ name: "result.json", type: "file", required: true }],
	runtimeInput: ["text"],
};

const files = {
	"taskbook.json": JSON.stringify({
		name: "grapheme-count",
		description: "统计文本中的 Unicode 字素数量",
		scope: "user",
		createdAt: "2026-06-30T00:00:00.000Z",
		updatedAt: "2026-06-30T00:00:00.000Z",
		tags: ["text"],
		runs: [],
	}),
	"spec.json": JSON.stringify(spec),
	"skill.md": "# Grapheme Count\nWrite result.json.\n",
	"verify.mjs": "process.exit(0);\n",
	"contract.json": JSON.stringify(contract),
};

function tempDir() {
	return mkdtempSync(path.join(os.tmpdir(), "ugk-task-install-"));
}

function fakeFetch(map: Record<string, string>) {
	return async (url: string) => {
		const text = map[url];
		if (text === undefined) return { ok: false, status: 404, text: async () => "missing" };
		return { ok: true, status: 200, text: async () => text };
	};
}

function manifestFor(name = "grapheme-count") {
	return JSON.stringify({
		tasks: [{
			name,
			description: "统计文本中的 Unicode 字素数量",
			files: Object.fromEntries(Object.keys(files).map((file) => [file, `https://example.test/${file}`])),
		}],
	});
}

test("runTaskInstall installs a manifest-listed taskbook into user task root", async () => {
	const agentDir = tempDir();
	try {
		const fetch = fakeFetch({
			"https://example.test/manifest.json": manifestFor(),
			...Object.fromEntries(Object.entries(files).map(([file, text]) => [`https://example.test/${file}`, text])),
		});

		const result = await runTaskInstall("grapheme-count", {
			agentDir,
			fetch,
			manifestUrl: "https://example.test/manifest.json",
		});

		const installDir = path.join(agentDir, "tasks", "grapheme-count");
		assert.equal(result.name, "grapheme-count");
		assert.equal(result.dir, installDir);
		assert.equal(existsSync(path.join(installDir, "taskbook.json")), true);
		assert.equal(JSON.parse(await readFile(path.join(installDir, "contract.json"), "utf8")).runtimeInput[0], "text");
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("runTaskInstall refuses to overwrite an existing taskbook", async () => {
	const agentDir = tempDir();
	try {
		const installDir = path.join(agentDir, "tasks", "grapheme-count");
		await mkdir(installDir, { recursive: true });
		await writeFile(path.join(installDir, "marker.txt"), "existing", "utf8");
		const fetch = fakeFetch({
			"https://example.test/manifest.json": manifestFor(),
			...Object.fromEntries(Object.entries(files).map(([file, text]) => [`https://example.test/${file}`, text])),
		});

		await assert.rejects(() => runTaskInstall("grapheme-count", {
			agentDir,
			fetch,
			manifestUrl: "https://example.test/manifest.json",
		}), /已存在|already exists/);

		assert.equal(await readFile(path.join(installDir, "marker.txt"), "utf8"), "existing");
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("runTaskInstall rejects taskbook files whose name differs from the manifest", async () => {
	const agentDir = tempDir();
	try {
		const badTaskbook = JSON.stringify({ ...JSON.parse(files["taskbook.json"]), name: "other" });
		const fetch = fakeFetch({
			"https://example.test/manifest.json": manifestFor("grapheme-count"),
			...Object.fromEntries(Object.entries({ ...files, "taskbook.json": badTaskbook }).map(([file, text]) => [`https://example.test/${file}`, text])),
		});

		await assert.rejects(() => runTaskInstall("grapheme-count", {
			agentDir,
			fetch,
			manifestUrl: "https://example.test/manifest.json",
		}), /name/i);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("isTaskInstallCommand recognizes only the shell install form", () => {
	assert.equal(isTaskInstallCommand(["task", "install", "grapheme-count"]), true);
	assert.equal(isTaskInstallCommand(["task", "run", "grapheme-count"]), false);
	assert.equal(isTaskInstallCommand(["--print", "task install grapheme-count"]), false);
});
