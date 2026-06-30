import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultAgentDir } from "./paths.js";

export const OFFICIAL_MANIFEST_URL = "https://ugk-task-share.pages.dev/manifest.json";

const REQUIRED_FILES = ["taskbook.json", "spec.json", "skill.md", "verify.mjs", "contract.json"];
const NAME_RE = /^[A-Za-z0-9_-]+$/;

function isStringArray(value) {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isVerifyFailure(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return (
		typeof value.assertion === "string" &&
		typeof value.expected === "string" &&
		typeof value.actual === "string" &&
		(value.hint === undefined || typeof value.hint === "string")
	);
}

function isTaskRun(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return (
		typeof value.timestamp === "string" &&
		(value.status === "pass" || value.status === "fail") &&
		typeof value.exitCode === "number" &&
		Array.isArray(value.verifyFailures) &&
		value.verifyFailures.every(isVerifyFailure) &&
		typeof value.duration === "number" &&
		Object.hasOwn(value, "input")
	);
}

function isTaskbook(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return (
		typeof value.name === "string" &&
		typeof value.description === "string" &&
		(value.scope === "user" || value.scope === "project") &&
		typeof value.createdAt === "string" &&
		typeof value.updatedAt === "string" &&
		(value.tags === undefined || isStringArray(value.tags)) &&
		Array.isArray(value.runs) &&
		value.runs.every(isTaskRun)
	);
}

function isRequirementsSpec(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return (
		typeof value.goal === "string" &&
		value.goal.trim().length > 0 &&
		isStringArray(value.hardConstraints) &&
		value.hardConstraints.length > 0 &&
		isStringArray(value.acceptance) &&
		value.acceptance.length > 0 &&
		(value.forbidden === undefined || isStringArray(value.forbidden)) &&
		(value.context === undefined || typeof value.context === "string")
	);
}

function assertValidContract(contract) {
	if (!contract || typeof contract !== "object" || Array.isArray(contract)) throw new Error("Invalid contract.json");
	if (contract.runtimeInput !== undefined && !isStringArray(contract.runtimeInput)) throw new Error("Invalid contract.runtimeInput");
	if (contract.runtimeInputMeta === undefined) return;
	if (!contract.runtimeInputMeta || typeof contract.runtimeInputMeta !== "object" || Array.isArray(contract.runtimeInputMeta)) {
		throw new Error("Invalid contract.runtimeInputMeta");
	}
	const fields = new Set(isStringArray(contract.runtimeInput) ? contract.runtimeInput : []);
	for (const [field, meta] of Object.entries(contract.runtimeInputMeta)) {
		if (!fields.has(field)) throw new Error(`Invalid contract.runtimeInputMeta: "${field}" is not declared in runtimeInput`);
		if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error(`Invalid contract.runtimeInputMeta.${field}`);
	}
}

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

function assertSafeManifestPath(file) {
	if (
		typeof file !== "string" ||
		file.length === 0 ||
		path.isAbsolute(file) ||
		file.includes("\\") ||
		file.split("/").some((part) => part === "" || part === "." || part === "..")
	) {
		throw new Error(`Unsafe file path in manifest: ${String(file)}`);
	}
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
	for (const file of Object.keys(files)) {
		assertSafeManifestPath(file);
		if (typeof files[file] !== "string") throw new Error(`Invalid manifest entry for ${name}: invalid ${file}`);
	}
	return task;
}

function validateTaskbook(name, texts) {
	const taskbook = parseJson(texts["taskbook.json"], "taskbook.json");
	const spec = parseJson(texts["spec.json"], "spec.json");
	const contract = parseJson(texts["contract.json"], "contract.json");
	if (!isTaskbook(taskbook)) throw new Error("Invalid taskbook.json");
	if (!isRequirementsSpec(spec)) throw new Error("Invalid spec.json");
	assertValidContract(contract);
	if (taskbook?.name !== name) throw new Error(`taskbook.json name mismatch: expected ${name}, got ${String(taskbook?.name)}`);
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
	for (const file of Object.keys(task.files)) {
		texts[file] = await fetchText(fetchFn, task.files[file]);
	}
	validateTaskbook(name, texts);

	const tasksRoot = path.join(agentDir, "tasks");
	const tempDir = path.join(tasksRoot, `.install-${name}-${Date.now()}`);
	await mkdir(tempDir, { recursive: true });
	try {
		for (const file of Object.keys(task.files)) {
			await mkdir(path.dirname(path.join(tempDir, file)), { recursive: true });
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
