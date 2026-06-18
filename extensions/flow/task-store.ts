import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { invalidFlowTaskIdMessage, isValidFlowTaskId } from "./parser.ts";

export type FlowTaskStatus =
	| "draft"
	| "proving"
	| "proved"
	| "reviewing"
	| "verified"
	| "active"
	| "needs-human";

export interface FlowTaskMetadata {
	id: string;
	version: number;
	status: FlowTaskStatus | string;
	taskDir: string;
	[key: string]: unknown;
}

function flowTasksDir(cwd: string): string {
	return path.join(cwd, ".flow", "tasks");
}

export function resolveFlowTaskDir(cwd: string, taskId: string): string {
	if (!isValidFlowTaskId(taskId)) {
		throw new Error(invalidFlowTaskIdMessage(taskId));
	}
	const tasksDir = path.resolve(flowTasksDir(cwd));
	const taskDir = path.resolve(tasksDir, taskId);
	const relative = path.relative(tasksDir, taskDir);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(invalidFlowTaskIdMessage(taskId));
	}
	return taskDir;
}

function readJsonFile(filePath: string): unknown {
	return JSON.parse(readFileSync(filePath, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readFlowTask(cwd: string, taskId: string): FlowTaskMetadata | undefined {
	const taskDir = resolveFlowTaskDir(cwd, taskId);
	const taskJsonPath = path.join(taskDir, "task.json");
	if (!existsSync(taskJsonPath)) {
		return undefined;
	}
	const parsed = readJsonFile(taskJsonPath);
	if (!isRecord(parsed)) {
		throw new Error(`Flow task metadata must be an object: ${taskJsonPath}`);
	}
	const id = typeof parsed.id === "string" ? parsed.id : taskId;
	const version = typeof parsed.version === "number" && Number.isFinite(parsed.version) ? parsed.version : 1;
	const status = typeof parsed.status === "string" ? parsed.status : "draft";
	return {
		...parsed,
		id,
		version,
		status,
		taskDir,
	};
}

export function writeFlowTask(cwd: string, taskId: string, task: Record<string, unknown>): void {
	const taskDir = resolveFlowTaskDir(cwd, taskId);
	mkdirSync(taskDir, { recursive: true });
	const { taskDir: _taskDir, ...serializable } = task;
	writeFileSync(path.join(taskDir, "task.json"), `${JSON.stringify(serializable, null, "\t")}\n`);
}

export function updateFlowTaskStatus(
	cwd: string,
	taskId: string,
	status: FlowTaskStatus,
	updates: Record<string, unknown> = {},
): FlowTaskMetadata {
	const existing = readFlowTask(cwd, taskId);
	if (!existing) {
		throw new Error(`Flow task not found: ${taskId}`);
	}
	const next: FlowTaskMetadata = {
		...existing,
		...updates,
		id: existing.id,
		version: existing.version,
		status,
		taskDir: existing.taskDir,
		updated_at: updates.updated_at ?? new Date().toISOString(),
	};
	writeFlowTask(cwd, taskId, next);
	return next;
}
