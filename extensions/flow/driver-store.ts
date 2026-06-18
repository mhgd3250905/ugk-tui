import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { invalidFlowTaskIdMessage, isValidFlowTaskId } from "./parser.ts";
import type { FlowDriverStatus, FlowDriverSummary } from "./types.ts";

export interface FlowDriverStatusFile {
	taskId: string;
	runId: string;
	status: FlowDriverStatus;
	step?: string;
	summary?: string;
	updatedAt: string;
	sessionFile?: string;
}

export interface CreatedRunArtifacts {
	taskId: string;
	runId: string;
	taskDir: string;
	runDir: string;
}

type WritableDriverStatus = Omit<FlowDriverStatusFile, "updatedAt"> & { updatedAt?: string };

const DRIVER_STATUSES: FlowDriverStatus[] = [
	"starting",
	"running",
	"waiting",
	"waiting-for-user",
	"needs-human",
	"validating",
	"done",
	"failed",
	"paused",
];

const SUMMARY_STATUS_ORDER: FlowDriverStatus[] = [
	"starting",
	"running",
	"waiting",
	"waiting-for-user",
	"needs-human",
	"validating",
	"failed",
	"paused",
	"done",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDriverStatus(value: unknown): value is FlowDriverStatus {
	return typeof value === "string" && DRIVER_STATUSES.includes(value as FlowDriverStatus);
}

function normalizeDriverStatus(value: unknown): FlowDriverStatus {
	if (isDriverStatus(value)) {
		return value;
	}
	if (value === "completed") {
		return "done";
	}
	return "paused";
}

function inferTaskId(runDir: string): string | undefined {
	const parts = path.normalize(runDir).split(path.sep);
	const runsIndex = parts.lastIndexOf("runs");
	if (runsIndex >= 2 && parts[runsIndex - 2] === "tasks") {
		return parts[runsIndex - 1];
	}
	return undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function flowTasksDir(cwd: string): string {
	return path.join(cwd, ".flow", "tasks");
}

function resolveTaskDir(cwd: string, taskId: string): string {
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

export function readDriverStatus(runDir: string): FlowDriverStatusFile | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path.join(runDir, "status.json"), "utf8"));
	} catch {
		return undefined;
	}

	if (!isRecord(parsed)) {
		return undefined;
	}

	const taskId = optionalString(parsed.taskId) ?? inferTaskId(runDir);
	const runId = optionalString(parsed.runId) ?? path.basename(runDir);
	if (!taskId || !runId) {
		return undefined;
	}

	return {
		taskId,
		runId,
		status: normalizeDriverStatus(parsed.status),
		step: optionalString(parsed.step),
		summary: optionalString(parsed.summary),
		updatedAt: optionalString(parsed.updatedAt) ?? new Date(0).toISOString(),
		sessionFile: optionalString(parsed.sessionFile),
	};
}

export function writeDriverStatus(runDir: string, status: WritableDriverStatus): void {
	mkdirSync(runDir, { recursive: true });
	const statusFile: FlowDriverStatusFile = {
		...status,
		updatedAt: status.updatedAt ?? new Date().toISOString(),
	};
	writeFileSync(path.join(runDir, "status.json"), `${JSON.stringify(statusFile, null, "\t")}\n`);
}

export function createRunArtifacts(
	cwd: string,
	taskId: string,
	input: string | undefined,
	runId: string,
): CreatedRunArtifacts {
	const taskDir = resolveTaskDir(cwd, taskId);
	const runDir = path.join(taskDir, "runs", runId);
	mkdirSync(path.join(runDir, "output"), { recursive: true });
	mkdirSync(path.join(runDir, "evidence"), { recursive: true });

	writeFileSync(path.join(runDir, "input.json"), `${JSON.stringify({ input: input ?? "" }, null, "\t")}\n`);
	writeFileSync(
		path.join(runDir, "prompt.md"),
		["# Driver Prompt", "", `Task: ${taskId}`, `Run: ${runId}`, `Input: ${input ?? ""}`, ""].join("\n"),
	);

	if (existsSync(path.join(taskDir, "todo.template.md"))) {
		copyFileSync(path.join(taskDir, "todo.template.md"), path.join(runDir, "todo.md"));
	} else {
		writeFileSync(path.join(runDir, "todo.md"), "# Run Todo\n");
	}

	writeFileSync(path.join(runDir, "progress.md"), "# Progress\n\nStatus: starting\n\n## Timeline\n");
	writeFileSync(path.join(runDir, "feedback.md"), "# User Feedback\n\n");
	writeDriverStatus(runDir, {
		taskId,
		runId,
		status: "starting",
		step: "not started",
		summary: "driver created",
	});

	return { taskId, runId, taskDir, runDir };
}

export function appendDriverFeedback(
	runDir: string,
	feedback: { message: string; driverResponse: string; affectedStep?: string },
	now = new Date(),
): void {
	const entry = [
		`## ${now.toISOString()}`,
		"",
		"focus: driver",
		`user message: ${feedback.message}`,
		`driver response: ${feedback.driverResponse}`,
		`affected step: ${feedback.affectedStep ?? "unknown"}`,
		"should review for skill update: unknown",
		"",
	].join("\n");
	appendFileSync(path.join(runDir, "feedback.md"), entry);
}

export function listDriverSummaries(cwd: string): FlowDriverSummary[] {
	const tasksDir = path.join(cwd, ".flow", "tasks");
	if (!existsSync(tasksDir)) {
		return [];
	}

	const summaries: FlowDriverSummary[] = [];
	for (const taskEntry of readdirSync(tasksDir, { withFileTypes: true })) {
		if (!taskEntry.isDirectory()) {
			continue;
		}
		const runsDir = path.join(tasksDir, taskEntry.name, "runs");
		if (!existsSync(runsDir) || !statSync(runsDir).isDirectory()) {
			continue;
		}
		for (const runEntry of readdirSync(runsDir, { withFileTypes: true })) {
			if (!runEntry.isDirectory()) {
				continue;
			}
			const runDir = path.join(runsDir, runEntry.name);
			const status = readDriverStatus(runDir);
			if (!status) {
				continue;
			}
			summaries.push({ ...status, runDir });
		}
	}

	return summaries.sort((left, right) => {
		const statusOrder = SUMMARY_STATUS_ORDER.indexOf(left.status) - SUMMARY_STATUS_ORDER.indexOf(right.status);
		if (statusOrder !== 0) {
			return statusOrder;
		}
		return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
	});
}

export function findDriverSummary(cwd: string, runId: string): FlowDriverSummary | undefined {
	return listDriverSummaries(cwd).find((summary) => summary.runId === runId);
}

export function buildDriverInitialPrompt(args: { taskId: string; runId: string; taskDir: string; runDir: string }): string {
	return [
		"[FLOW INTERACTIVE DRIVER]",
		"",
		`Task: ${args.taskId}`,
		`Run: ${args.runId}`,
		`Task dir: ${args.taskDir}`,
		`Run dir: ${args.runDir}`,
		"",
		"你是本次 Flow Task run 的 driver。",
		"必须读取并遵守：",
		`- ${path.join(args.taskDir, "SKILL.md")}`,
		`- ${path.join(args.runDir, "input.json")}`,
		`- ${path.join(args.runDir, "todo.md")}`,
		`- ${path.join(args.taskDir, "validator.md")}`,
		"",
		"执行要求：",
		"- 按 SKILL.md 的最优路径逐步执行。",
		"- 如果任务需要控制本地登录态 Chrome，必须使用 chrome_cdp 工具；不要自己拼接或访问 CDP websocket/json 端点。",
		"- 每一步都填写 todo.md 的实际执行、偏离旧方案、解决过程和证据。",
		"- 输出写入 run/output/，证据写入 run/evidence/。",
		"- 进度写入 progress.md。",
		"- 不要写入或修改 status.json；run 生命周期状态由 Flow runtime 统一控制。",
		"- 你不能修改 SKILL.md、todo.template.md 或 validator.md。",
		"- 如果用户通过 driver focus 插嘴，先记录反馈，再调整执行。",
	].join("\n");
}

export function nextRunId(cwd: string, taskId: string): string {
	const runsDir = path.join(resolveTaskDir(cwd, taskId), "runs");
	if (!existsSync(runsDir)) return "run-001";
	const max = readdirSync(runsDir)
		.map((name) => name.match(/^run-(\d+)$/)?.[1])
		.filter((value): value is string => Boolean(value))
		.map((value) => Number(value))
		.reduce((current, value) => Math.max(current, value), 0);
	return `run-${String(max + 1).padStart(3, "0")}`;
}
