import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { isRecord, readJsonOptional } from "./flow-fs.ts";
import { signRecord, verifyRecord, STATUS_SIGNED_FIELDS } from "./flow-signing.ts";
import { closeMigrationWindow, getProjectKey, isInMigrationWindow, resolveFlowTaskDir } from "./task-store.ts";
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

/**
 * 读 status.json 并验签。迁移窗口外,签名不符(被篡改/无 _sig)返回 undefined。
 *
 * status.json 是 driver 生命周期的判定记录:driverLive 判定、session_shutdown 的
 * paused 改写、driver picker 排序都读它。agent 可手写(driver 工作区够得着),所以
 * 必须验签——见 docs/handoff/2026-06-19-unsigned-read-paths.md 的铁律。cwd 必填。
 */
export function readDriverStatus(runDir: string, cwd: string): FlowDriverStatusFile | undefined {
	const parsed = readJsonOptional(path.join(runDir, "status.json"));
	if (!isRecord(parsed)) {
		return undefined;
	}
	if (!isInMigrationWindow(cwd)) {
		const check = verifyRecord(getProjectKey(cwd), parsed, STATUS_SIGNED_FIELDS);
		if (!check.verified) {
			return undefined;
		}
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

/**
 * 写 status.json(带签名)。签名由 runtime 独占(agent 拿不到密钥)。
 * 首次签名即关闭迁移窗口(经由 writeFlowTask 同款 closeMigrationWindow)。
 */
export function writeDriverStatus(runDir: string, status: WritableDriverStatus, cwd: string): void {
	mkdirSync(runDir, { recursive: true });
	const statusFile: FlowDriverStatusFile = {
		...status,
		updatedAt: status.updatedAt ?? new Date().toISOString(),
	};
	const record = statusFile as unknown as Record<string, unknown>;
	const sig = signRecord(getProjectKey(cwd), record, STATUS_SIGNED_FIELDS);
	const withSig = { ...record, _sig: sig };
	writeFileSync(path.join(runDir, "status.json"), `${JSON.stringify(withSig, null, "\t")}\n`);
	closeMigrationWindow(cwd);
}

export function createRunArtifacts(
	cwd: string,
	taskId: string,
	input: string | undefined,
	runId: string,
): CreatedRunArtifacts {
	const taskDir = resolveFlowTaskDir(cwd, taskId);
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
	}, cwd);

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
			const status = readDriverStatus(runDir, cwd);
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
		"- 每一步都填写 todo.md 的实际执行、偏离旧方案、解决过程和证据。",
		"- 输出写入 run/output/，证据写入 run/evidence/。",
		"- 进度写入 progress.md。",
		"- 不要写入或修改 status.json；run 生命周期状态由 Flow runtime 统一控制。",
		"- 你不能修改 SKILL.md、todo.template.md 或 validator.md。",
		"- 如果用户通过 driver focus 插嘴，先记录反馈，再调整执行。",
	].join("\n");
}

export function nextRunId(cwd: string, taskId: string): string {
	const runsDir = path.join(resolveFlowTaskDir(cwd, taskId), "runs");
	if (!existsSync(runsDir)) return "run-001";
	const max = readdirSync(runsDir)
		.map((name) => name.match(/^run-(\d+)$/)?.[1])
		.filter((value): value is string => Boolean(value))
		.map((value) => Number(value))
		.reduce((current, value) => Math.max(current, value), 0);
	return `run-${String(max + 1).padStart(3, "0")}`;
}
