import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { OFFICIAL_MANIFEST_URL, isTaskInstallCommand, runTaskInstall } from "../bin/task-install.js";

const execFileAsync = promisify(execFile);

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

test("runTaskInstall rejects malformed taskbook metadata before writing files", async () => {
	const agentDir = tempDir();
	try {
		const badTaskbook = JSON.stringify({ ...JSON.parse(files["taskbook.json"]), description: undefined });
		const fetch = fakeFetch({
			"https://example.test/manifest.json": manifestFor("grapheme-count"),
			...Object.fromEntries(Object.entries({ ...files, "taskbook.json": badTaskbook }).map(([file, text]) => [`https://example.test/${file}`, text])),
		});

		await assert.rejects(() => runTaskInstall("grapheme-count", {
			agentDir,
			fetch,
			manifestUrl: "https://example.test/manifest.json",
		}), /Invalid taskbook\.json/);

		assert.equal(existsSync(path.join(agentDir, "tasks", "grapheme-count")), false);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("runTaskInstall rejects malformed specs before writing files", async () => {
	const agentDir = tempDir();
	try {
		const badSpec = JSON.stringify({ ...spec, hardConstraints: [] });
		const fetch = fakeFetch({
			"https://example.test/manifest.json": manifestFor("grapheme-count"),
			...Object.fromEntries(Object.entries({ ...files, "spec.json": badSpec }).map(([file, text]) => [`https://example.test/${file}`, text])),
		});

		await assert.rejects(() => runTaskInstall("grapheme-count", {
			agentDir,
			fetch,
			manifestUrl: "https://example.test/manifest.json",
		}), /Invalid spec\.json/);

		assert.equal(existsSync(path.join(agentDir, "tasks", "grapheme-count")), false);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("runTaskInstall installs every safe file listed by the manifest", async () => {
	const agentDir = tempDir();
	try {
		const fetch = fakeFetch({
			"https://example.test/manifest.json": JSON.stringify({
				tasks: [{
					name: "grapheme-count",
					files: {
						...Object.fromEntries(Object.keys(files).map((file) => [file, `https://example.test/${file}`])),
						"scripts/helper.mjs": "https://example.test/scripts/helper.mjs",
					},
				}],
			}),
			...Object.fromEntries(Object.entries(files).map(([file, text]) => [`https://example.test/${file}`, text])),
			"https://example.test/scripts/helper.mjs": "export const ok = true;\n",
		});

		await runTaskInstall("grapheme-count", {
			agentDir,
			fetch,
			manifestUrl: "https://example.test/manifest.json",
		});

		assert.equal(await readFile(path.join(agentDir, "tasks", "grapheme-count", "scripts", "helper.mjs"), "utf8"), "export const ok = true;\n");
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("runTaskInstall rejects unsafe manifest file paths", async () => {
	const agentDir = tempDir();
	try {
		const fetch = fakeFetch({
			"https://example.test/manifest.json": JSON.stringify({
				tasks: [{
					name: "grapheme-count",
					files: {
						...Object.fromEntries(Object.keys(files).map((file) => [file, `https://example.test/${file}`])),
						"../escape.mjs": "https://example.test/escape.mjs",
					},
				}],
			}),
			...Object.fromEntries(Object.entries(files).map(([file, text]) => [`https://example.test/${file}`, text])),
		});

		await assert.rejects(() => runTaskInstall("grapheme-count", {
			agentDir,
			fetch,
			manifestUrl: "https://example.test/manifest.json",
		}), /unsafe file path/i);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("bin/ugk.js handles task install before starting the interactive CLI", async () => {
	const agentDir = tempDir();
	try {
		const preloadPath = path.join(agentDir, "mock-fetch.mjs");
		await writeFile(preloadPath, `
const fixture = JSON.parse(process.env.UGK_TEST_TASK_FIXTURE);
globalThis.fetch = async (url) => {
	const u = String(url);
	// manifest endpoint → manifest.json key; file URL → last path segment as key
	const key = u.endsWith('/api/manifest') ? 'manifest.json' : decodeURIComponent(u.split('/').pop() ?? '');
	const text = fixture[key];
	return text === undefined
		? { ok: false, status: 404, text: async () => 'missing' }
		: { ok: true, status: 200, text: async () => text };
};
`, "utf8");
		const { stdout } = await execFileAsync(process.execPath, ["--import", pathToFileURL(preloadPath).href, "bin/ugk.js", "task", "install", "grapheme-count"], {
			cwd: path.resolve("."),
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				UGK_TEST_TASK_FIXTURE: JSON.stringify({
					"manifest.json": manifestFor(),
					...files,
				}),
			},
			timeout: 10000,
		});

		assert.match(stdout, /taskbook "grapheme-count"/);
		assert.equal(existsSync(path.join(agentDir, "tasks", "grapheme-count", "taskbook.json")), true);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("official task install manifest is served from the dynamic API endpoint", () => {
	assert.equal(OFFICIAL_MANIFEST_URL, "https://ugk-task-share.pages.dev/api/manifest");
});

test("isTaskInstallCommand recognizes only the shell install form", () => {
	assert.equal(isTaskInstallCommand(["task", "install", "grapheme-count"]), true);
	assert.equal(isTaskInstallCommand(["task", "run", "grapheme-count"]), false);
	assert.equal(isTaskInstallCommand(["--print", "task install grapheme-count"]), false);
});
