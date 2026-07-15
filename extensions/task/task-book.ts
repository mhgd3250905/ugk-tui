import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { RequirementsSpec } from "./task-spec.ts";
import { stripBom } from "../shared/settings-io.ts";
import {
	assertValidContract as assertValidContractSchema,
	isRequirementsSpec as isRequirementsSpecSchema,
	isTaskbook as isTaskbookSchema,
} from "../../shared/taskbook-schema.js";

export function isRequirementsSpec(value: unknown): value is RequirementsSpec {
	return isRequirementsSpecSchema(value);
}

export interface VerifyFailure {
	assertion: string;
	expected: string;
	actual: string;
	hint?: string;
}

export interface TaskRun {
	timestamp: string;
	status: "pass" | "fail";
	input: unknown;
	exitCode: number;
	verifyFailures: VerifyFailure[];
	duration: number;
	// ponytail: 纯诊断字段,不改执行逻辑。各阶段累计耗时(ms),调试"到底慢在哪"用。
	// 例如 workerFirstOutput = worker 子进程启动+首轮 LLM 的延迟;worker = worker 整体;verify = 校验。
	phases?: Record<string, number>;
}

export interface Taskbook {
	name: string;
	description: string;
	scope: "user" | "project";
	createdAt: string;
	updatedAt: string;
	tags?: string[];
	runs: TaskRun[];
}

export interface LoadedTaskbook {
	taskbook: Taskbook;
	spec: RequirementsSpec;
	skill: string;
	verify: string;
	contract: unknown;
	scope: "user" | "project";
	dir: string;
}

export function tasksRootUser(): string {
	return path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "tasks");
}

export function tasksRootProject(cwd: string): string {
	return path.join(cwd, ".tasks");
}

export function taskDir(scope: "user" | "project", cwd: string, name: string): string {
	return path.join(scope === "project" ? tasksRootProject(cwd) : tasksRootUser(), name);
}

export function isValidTaskbookName(name: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(name);
}

export function isTaskbook(value: unknown): value is Taskbook {
	return isTaskbookSchema(value);
}

function normalizeTaskbook(value: unknown): Taskbook {
	if (!isTaskbook(value)) throw new Error("Invalid taskbook.json");
	return value;
}

export function assertValidContract(contract: unknown): void {
	assertValidContractSchema(contract);
}

export function sortAndTrimRuns(runs: TaskRun[]): TaskRun[] {
	return [...runs]
		.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
		.slice(-10);
}

async function readJson(filePath: string): Promise<unknown> {
	// BOM-safe:spec.json/contract.json 是用户手编,PowerShell 保存会带 UTF-8 BOM,
	// 裸 parse 会抛错导致整个 taskbook 在 loadFromDir 静默返回 null(不可用)。
	return JSON.parse(stripBom(await readFile(filePath, "utf8")));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await writeFile(filePath, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

async function loadFromDir(scope: "user" | "project", dir: string): Promise<LoadedTaskbook | null> {
	const taskbookPath = path.join(dir, "taskbook.json");
	const specPath = path.join(dir, "spec.json");
	const skillPath = path.join(dir, "skill.md");
	const verifyPath = path.join(dir, "verify.mjs");
	const contractPath = path.join(dir, "contract.json");
	try {
		const [taskbookData, specData, skill, verify, contract] = await Promise.all([
			readJson(taskbookPath),
			readJson(specPath),
			readFile(skillPath, "utf8"),
			readFile(verifyPath, "utf8"),
			readJson(contractPath),
		]);
		const taskbook = normalizeTaskbook(taskbookData);
		if (!isRequirementsSpec(specData)) throw new Error("Invalid spec.json");
		return { taskbook, spec: specData, skill, verify, contract, scope, dir };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" && !existsSync(taskbookPath) && !existsSync(specPath)) return null;
		throw error;
	}
}

export async function saveTaskbook(scope: "user" | "project", cwd: string, name: string, data: {
	description: string;
	spec: RequirementsSpec;
	skill: string;
	verify: string;
	contract: unknown;
	tags?: string[];
	tests?: Record<string, string>;
}): Promise<Taskbook> {
	if (!isValidTaskbookName(name)) throw new Error(`Invalid taskbook name: ${name}`);
	assertValidContract(data.contract);
	const testEntries = Object.entries(data.tests ?? {});
	for (const [fname] of testEntries) {
		if (fname.includes("..") || path.isAbsolute(fname) || path.win32.isAbsolute(fname) || path.posix.isAbsolute(fname)) {
			throw new Error(`Invalid tests filename: ${fname}`);
		}
	}
	const dir = taskDir(scope, cwd, name);
	const existing = await loadFromDir(scope, dir).catch(() => null);
	const now = new Date().toISOString();
	const taskbook: Taskbook = {
		name,
		description: data.description,
		scope,
		createdAt: existing?.taskbook.createdAt ?? now,
		updatedAt: now,
		tags: data.tags,
		runs: existing?.taskbook.runs ?? [],
	};
	await mkdir(dir, { recursive: true });
	await Promise.all([
		writeJson(path.join(dir, "taskbook.json"), taskbook),
		writeJson(path.join(dir, "spec.json"), data.spec),
		writeFile(path.join(dir, "skill.md"), data.skill, "utf8"),
		writeFile(path.join(dir, "verify.mjs"), data.verify, "utf8"),
		writeJson(path.join(dir, "contract.json"), data.contract),
	]);
	if (testEntries.length > 0) {
		const testsDir = path.join(dir, "tests");
		await mkdir(testsDir, { recursive: true });
		await Promise.all(testEntries.map(([fname, content]) =>
			writeFile(path.join(testsDir, fname), content, "utf8")
		));
	}
	return taskbook;
}

export async function loadTaskbook(cwd: string, name: string): Promise<LoadedTaskbook | null> {
	if (!isValidTaskbookName(name)) throw new Error(`Invalid taskbook name: ${name}`);
	return (
		await loadFromDir("project", taskDir("project", cwd, name)) ??
		await loadFromDir("user", taskDir("user", cwd, name))
	);
}

export async function listTaskbooks(cwd: string, tag?: string): Promise<Array<{ name: string; scope: "user" | "project"; description: string; tags?: string[]; lastRun?: TaskRun; contract: unknown }>> {
	const byName = new Map<string, { name: string; scope: "user" | "project"; description: string; tags?: string[]; lastRun?: TaskRun; contract: unknown }>();
	for (const scope of ["user", "project"] as const) {
		const root = scope === "user" ? tasksRootUser() : tasksRootProject(cwd);
		let entries: Awaited<ReturnType<typeof readdir>>;
		try {
			entries = await readdir(root, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || !isValidTaskbookName(entry.name)) continue;
			try {
				const loaded = await loadFromDir(scope, path.join(root, entry.name));
				if (!loaded || (tag && !loaded.taskbook.tags?.includes(tag))) continue;
				byName.set(loaded.taskbook.name, {
					name: loaded.taskbook.name,
					scope,
					description: loaded.taskbook.description,
					tags: loaded.taskbook.tags,
					lastRun: loaded.taskbook.runs.at(-1),
					contract: loaded.contract,
				});
			} catch {
				// ponytail: list skips broken taskbooks; show/load reports the actual corruption.
			}
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function appendRunToTaskbook(scope: "user" | "project", cwd: string, name: string, run: TaskRun): Promise<Taskbook> {
	// ponytail: 进程内文件锁串行化同一 taskbook 的 read-modify-write。
	// run_task parallel 的多 worker 都在 main 进程并发调这里,不加锁会互相覆盖(run 丢失)
	// 甚至把 taskbook.json 写坏成 `{...}\n{...}` 导致 loadTaskbook 抛 JSON parse error、
	// taskbook 从清单消失(见 tests/task-book.test.ts 并发回归测试)。
	// 用 withFileMutationQueue 按 realpath 串行同一文件,不同 taskbook 仍并行。
	// 进程内锁在这里有效:append 调用都在 main 进程,不跨 worker 子进程。
	const filePath = path.join(taskDir(scope, cwd, name), "taskbook.json");
	return withFileMutationQueue(filePath, async () => {
		const loaded = await loadFromDir(scope, taskDir(scope, cwd, name));
		if (!loaded) throw new Error(`Taskbook not found: ${name}`);
		const taskbook: Taskbook = {
			...loaded.taskbook,
			updatedAt: new Date().toISOString(),
			runs: sortAndTrimRuns([...loaded.taskbook.runs, run]),
		};
		await writeJson(path.join(loaded.dir, "taskbook.json"), taskbook);
		return taskbook;
	});
}

export async function renameTaskbook(scope: "user" | "project", cwd: string, oldName: string, newName: string): Promise<Taskbook> {
	if (!isValidTaskbookName(oldName)) throw new Error(`Invalid taskbook name: ${oldName}`);
	if (!isValidTaskbookName(newName)) throw new Error(`Invalid taskbook name: ${newName}`);
	if (oldName === newName) throw new Error("新名字与旧名字相同");
	const oldDir = taskDir(scope, cwd, oldName);
	const newDir = taskDir(scope, cwd, newName);
	const loaded = await loadFromDir(scope, oldDir);
	if (!loaded) throw new Error(`Taskbook not found: ${oldName}`);
	if (await loadFromDir(scope, newDir).catch(() => null)) throw new Error(`名字 "${newName}" 已存在,拒绝覆盖`);
	await mkdir(path.dirname(newDir), { recursive: true });
	await rename(oldDir, newDir);
	const taskbook = {
		...loaded.taskbook,
		name: newName,
		updatedAt: new Date().toISOString(),
	};
	await writeJson(path.join(newDir, "taskbook.json"), taskbook);
	return taskbook;
}

export async function deleteTaskbook(scope: "user" | "project", cwd: string, name: string): Promise<void> {
	if (!isValidTaskbookName(name)) throw new Error(`Invalid taskbook name: ${name}`);
	await rm(taskDir(scope, cwd, name), { recursive: true, force: true });
}
