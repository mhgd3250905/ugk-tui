import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const OFFICIAL_MANIFEST_URL = "https://raw.githubusercontent.com/mhgd3250905/ugk-tui/main/docs/task-share/manifest.json";

const REQUIRED_FILES = ["taskbook.json", "spec.json", "skill.md", "verify.mjs", "contract.json"];
const NAME_RE = /^[A-Za-z0-9_-]+$/;

function stripBom(text) {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseJson(text, label) {
	try {
		return JSON.parse(stripBom(text));
	} catch (error) {
		throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function assertValidName(name) {
	if (!NAME_RE.test(name)) throw new Error(`Invalid taskbook name: ${name}`);
}

function defaultAgentDir() {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

async function fetchText(fetchFn, url) {
	const response = await fetchFn(url);
	if (!response?.ok) throw new Error(`Failed to download ${url}: HTTP ${response?.status ?? "unknown"}`);
	return await response.text();
}

function findManifestTask(manifest, name) {
	const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : [];
	const task = tasks.find((item) => item?.name === name);
	if (!task) throw new Error(`Official taskbook not found: ${name}`);
	const files = task.files;
	if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error(`Invalid manifest entry for ${name}`);
	for (const file of REQUIRED_FILES) {
		if (typeof files[file] !== "string") throw new Error(`Invalid manifest entry for ${name}: missing ${file}`);
	}
	return task;
}

function validateTaskbook(name, texts) {
	const taskbook = parseJson(texts["taskbook.json"], "taskbook.json");
	parseJson(texts["spec.json"], "spec.json");
	parseJson(texts["contract.json"], "contract.json");
	if (taskbook?.name !== name) throw new Error(`taskbook.json name mismatch: expected ${name}, got ${String(taskbook?.name)}`);
	if (taskbook.scope !== "user" && taskbook.scope !== "project") throw new Error("Invalid taskbook.json scope");
	if (!Array.isArray(taskbook.runs)) throw new Error("Invalid taskbook.json runs");
	return taskbook;
}

export function isTaskInstallCommand(argv) {
	return argv[0] === "task" && argv[1] === "install";
}

export async function runTaskInstall(name, deps = {}) {
	assertValidName(name);
	const fetchFn = deps.fetch ?? globalThis.fetch;
	if (typeof fetchFn !== "function") throw new Error("fetch is not available in this Node.js runtime");
	const manifestUrl = deps.manifestUrl ?? OFFICIAL_MANIFEST_URL;
	const agentDir = deps.agentDir ?? defaultAgentDir();
	const manifest = parseJson(await fetchText(fetchFn, manifestUrl), "manifest.json");
	const task = findManifestTask(manifest, name);
	const targetDir = path.join(agentDir, "tasks", name);
	if (existsSync(targetDir)) throw new Error(`taskbook "${name}" already exists: ${targetDir}`);

	const texts = {};
	for (const file of REQUIRED_FILES) {
		texts[file] = await fetchText(fetchFn, task.files[file]);
	}
	validateTaskbook(name, texts);

	const tasksRoot = path.join(agentDir, "tasks");
	const tempDir = path.join(tasksRoot, `.install-${name}-${Date.now()}`);
	await mkdir(tempDir, { recursive: true });
	try {
		for (const file of REQUIRED_FILES) {
			await writeFile(path.join(tempDir, file), texts[file], "utf8");
		}
		await rename(tempDir, targetDir);
	} catch (error) {
		await rm(tempDir, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
	return { name, dir: targetDir };
}

export async function runTaskInstallCli(argv, deps = {}) {
	const name = argv[2];
	if (!name) {
		deps.stderr?.write?.("Usage: ugk task install <name>\n");
		return 1;
	}
	try {
		const result = await runTaskInstall(name, deps);
		deps.stdout?.write?.(`已安装 taskbook "${result.name}"\n下一步: /task run ${result.name} <你的输入>\n`);
		return 0;
	} catch (error) {
		deps.stderr?.write?.(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}
