import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { DriverSummary, RequirementsSpec, SteerRecord } from "./judge-state.ts";

export interface RunSummary {
	timestamp: string;
	status: "pass" | "fail";
	steerCount: number;
	failReason?: string;
	evidence?: string[];
}

export interface Taskbook {
	name: string;
	description: string;
	createdAt: string;
	updatedAt: string;
	runs: RunSummary[];
}

export function taskbooksRoot(cwd: string): string {
	return path.join(cwd, ".judge", "taskbooks");
}

export function taskbookDir(cwd: string, name: string): string {
	return path.join(taskbooksRoot(cwd), name);
}

export function isValidTaskbookName(name: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(name);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRequirementsSpec(value: unknown): value is RequirementsSpec {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.goal === "string" &&
		isStringArray(record.hardConstraints) &&
		isStringArray(record.acceptance) &&
		isStringArray(record.forbidden) &&
		typeof record.context === "string"
	);
}

function isRunSummary(value: unknown): value is RunSummary {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.timestamp === "string" &&
		(record.status === "pass" || record.status === "fail") &&
		typeof record.steerCount === "number" &&
		(record.failReason === undefined || typeof record.failReason === "string") &&
		(record.evidence === undefined || isStringArray(record.evidence))
	);
}

export function isTaskbook(value: unknown): value is Taskbook {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.name === "string" &&
		typeof record.description === "string" &&
		typeof record.createdAt === "string" &&
		typeof record.updatedAt === "string" &&
		Array.isArray(record.runs) &&
		record.runs.every(isRunSummary)
	);
}

function normalizeTaskbook(value: unknown): Taskbook {
	if (!isTaskbook(value)) throw new Error("Invalid taskbook.json");
	return value;
}

function sortAndTrimRuns(runs: RunSummary[]): RunSummary[] {
	return [...runs]
		.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
		.slice(-10);
}

async function readJson(filePath: string): Promise<unknown> {
	return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await writeFile(filePath, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

export async function saveTaskbook(cwd: string, name: string, data: {
	description: string;
	spec: RequirementsSpec;
	summary: DriverSummary;
}): Promise<Taskbook> {
	if (!isValidTaskbookName(name)) throw new Error(`Invalid taskbook name: ${name}`);
	const dir = taskbookDir(cwd, name);
	await mkdir(dir, { recursive: true });
	const now = new Date().toISOString();
	const taskbook: Taskbook = {
		name,
		description: data.description,
		createdAt: now,
		updatedAt: now,
		runs: [],
	};
	await writeJson(path.join(dir, "spec.json"), data.spec);
	await writeFile(path.join(dir, "experience.md"), draftExperienceMd(name, data.spec, data.summary.steerHistory ?? [], taskbook), "utf8");
	await writeJson(path.join(dir, "taskbook.json"), taskbook);
	return taskbook;
}

export async function loadTaskbook(cwd: string, name: string): Promise<{ taskbook: Taskbook; spec: RequirementsSpec } | null> {
	if (!isValidTaskbookName(name)) throw new Error(`Invalid taskbook name: ${name}`);
	const dir = taskbookDir(cwd, name);
	const taskbookPath = path.join(dir, "taskbook.json");
	const specPath = path.join(dir, "spec.json");
	let taskbookData: unknown;
	let specData: unknown;
	try {
		[taskbookData, specData] = await Promise.all([
			readJson(taskbookPath),
			readJson(specPath),
		]);
	} catch (error) {
		// 两个文件都缺失才算「任务书不存在」;只缺一个 = 任务书损坏,显式抛错便于排障(reviewer Minor 2)
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			const taskbookMissing = !existsSync(taskbookPath);
			const specMissing = !existsSync(specPath);
			if (taskbookMissing && specMissing) return null;
			throw new Error(
				`Taskbook "${name}" is corrupt: missing ${taskbookMissing ? "taskbook.json" : "spec.json"} ` +
				`(run /judge save ${name} to recreate, or delete .judge/taskbooks/${name}/)`,
			);
		}
		throw error;
	}
	const taskbook = normalizeTaskbook(taskbookData);
	if (!isRequirementsSpec(specData)) throw new Error("Invalid spec.json");
	return { taskbook, spec: specData };
}

export async function listTaskbooks(cwd: string): Promise<Array<{ name: string; description: string; lastRun?: RunSummary }>> {
	let entries: Awaited<ReturnType<typeof readdir>>;
	try {
		entries = await readdir(taskbooksRoot(cwd), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const results: Array<{ name: string; description: string; lastRun?: RunSummary }> = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !isValidTaskbookName(entry.name)) continue;
		try {
			const taskbook = normalizeTaskbook(await readJson(path.join(taskbooksRoot(cwd), entry.name, "taskbook.json")));
			results.push({
				name: taskbook.name,
				description: taskbook.description,
				lastRun: taskbook.runs.at(-1),
			});
		} catch {
			// ponytail: listing skips corrupt taskbooks; explicit load reports the real error.
		}
	}
	return results.sort((a, b) => a.name.localeCompare(b.name));
}

export async function appendRunToTaskbook(
	cwd: string,
	name: string,
	run: RunSummary,
): Promise<Taskbook> {
	const loaded = await loadTaskbook(cwd, name);
	if (!loaded) throw new Error(`Taskbook not found: ${name}`);
	const taskbook: Taskbook = {
		...loaded.taskbook,
		updatedAt: new Date().toISOString(),
		runs: sortAndTrimRuns([...loaded.taskbook.runs, run]),
	};
	await writeJson(path.join(taskbookDir(cwd, name), "taskbook.json"), taskbook);
	return taskbook;
}

export async function updateTaskbookSpec(cwd: string, name: string, spec: RequirementsSpec): Promise<void> {
	const loaded = await loadTaskbook(cwd, name);
	if (!loaded) throw new Error(`Taskbook not found: ${name}`);
	await writeJson(path.join(taskbookDir(cwd, name), "spec.json"), spec);
}

export async function writeExperienceMd(cwd: string, name: string, content: string): Promise<void> {
	await writeFile(path.join(taskbookDir(cwd, name), "experience.md"), content, "utf8");
}

export async function readExperienceMd(cwd: string, name: string): Promise<string> {
	return readFile(path.join(taskbookDir(cwd, name), "experience.md"), "utf8");
}

export function draftExperienceMd(name: string, spec: RequirementsSpec, steerHistory: SteerRecord[], taskbook: Taskbook): string {
	const acceptance = spec.acceptance.map((item) => `- ${item}`);
	const steers = steerHistory.length
		? steerHistory.map((steer, index) =>
			`- steer #${index + 1} (turn ${steer.turnIndex}): ${steer.direction} —— 原因: ${steer.reason || "未记录"}`)
		: ["- 暂无"];
	const failures = taskbook.runs
		.filter((run) => run.status === "fail" && run.failReason)
		.map((run) => `- ${run.failReason}`);

	return [
		`# ${name} 经验`,
		"",
		"## 目标",
		spec.goal,
		"",
		"## 验收标准",
		...(acceptance.length ? acceptance : ["- 暂无"]),
		"",
		"## 关键避坑点(来自历史 steer)",
		...steers,
		"",
		"## 已知失败模式(来自 fail 历史)",
		...(failures.length ? failures : ["- 暂无"]),
		"",
	].join("\n");
}
