import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isRecord, readJsonStrict } from "./flow-fs.ts";
import { invalidFlowTaskIdMessage, isValidFlowTaskId } from "./parser.ts";
import { deriveProjectKey, getOrCreateMasterKey, signRecord, verifyRecord, type RecordSignature } from "./flow-signing.ts";

/** task.json 状态机关键字段——这些字段的篡改会被签名检测到。 */
const TASK_SIGNED_FIELDS = ["id", "status", "version", "latest_review_run", "ready_origin"];

/** 迁移标记文件:存在 = 旧数据已重签,此后无 _sig 的记录不可信。 */
const MIGRATED_MARKER = ".migrated";

/**
 * task.json 可能出现的所有 status 值。
 *
 * 产品层状态机见 task-state.ts(draft/proving/proved/reviewing/ready/needs-work)。
 * 这里保留 verified/active/approved/needs-human 是为了**读取旧数据**——它们由
 * task-state.normalizeLegacyState 归一为 ready/needs-work。新代码不应再写入这些值。
 */
export type FlowTaskStatus =
	| "draft"
	| "proving"
	| "proved"
	| "reviewing"
	| "ready"
	| "needs-work"
	// 以下为已废弃的旧值,仅为读取旧数据保留;新写入一律用上面 6 个。
	| "verified"
	| "active"
	| "approved"
	| "needs-human";

export interface FlowTaskMetadata {
	id: string;
	version: number;
	status: FlowTaskStatus | string;
	taskDir: string;
	/**
	 * 签名校验结果。true = 记录的关键字段被篡改或无签名(迁移窗口外),调用方应
	 * 按损坏处理(用 CORRUPT_FEEDBACK 中性反馈,不提签名)。正常记录为 undefined。
	 */
	_signatureBroken?: boolean;
	[key: string]: unknown;
}

function flowTasksDir(cwd: string): string {
	return path.join(cwd, ".flow", "tasks");
}

/**
 * 是否在迁移窗口内(项目首次接入签名)。窗口内:无 _sig 的旧记录被信任。
 * 窗口外(.flow/.migrated 存在):无 _sig 或签名不符的记录当损坏。
 * 窗口在第一次签名写入时关闭(runtime 会创建 .migrated)。
 */
function isInMigrationWindow(cwd: string): boolean {
	return !existsSync(path.join(cwd, ".flow", MIGRATED_MARKER));
}

/** 关闭迁移窗口:后续无 _sig 的记录不再被信任。runtime 首次签名写入后调用。 */
function closeMigrationWindow(cwd: string): void {
	const markerPath = path.join(cwd, ".flow", MIGRATED_MARKER);
	if (!existsSync(markerPath)) {
		mkdirSync(path.dirname(markerPath), { recursive: true });
		writeFileSync(markerPath, new Date().toISOString());
	}
}

/** 派生项目签名密钥。 HKDF 轻量,但缓存一次避免重复派生。 */
const projectKeyCache = new Map<string, Buffer>();
function getProjectKey(cwd: string): Buffer {
	const resolved = path.resolve(cwd);
	let key = projectKeyCache.get(resolved);
	if (!key) {
		key = deriveProjectKey({ cwd: resolved }, getOrCreateMasterKey());
		projectKeyCache.set(resolved, key);
	}
	return key;
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

export function readFlowTask(cwd: string, taskId: string): FlowTaskMetadata | undefined {
	const taskDir = resolveFlowTaskDir(cwd, taskId);
	const taskJsonPath = path.join(taskDir, "task.json");
	if (!existsSync(taskJsonPath)) {
		return undefined;
	}
	const parsed = readJsonStrict(taskJsonPath);
	if (!isRecord(parsed)) {
		throw new Error(`Flow task metadata must be an object: ${taskJsonPath}`);
	}
	const id = typeof parsed.id === "string" ? parsed.id : taskId;
	const version = typeof parsed.version === "number" && Number.isFinite(parsed.version) ? parsed.version : 1;
	const status = typeof parsed.status === "string" ? parsed.status : "draft";

	// 签名校验:验证关键字段(status/version 等)未被 agent 篡改。
	// 迁移窗口内:无 _sig 的旧记录信任(兼容);窗口外:无 _sig 或签名不符 = 损坏。
	let signatureBroken = false;
	const inMigrationWindow = isInMigrationWindow(cwd);
	if (inMigrationWindow) {
		// 窗口内不强制验签,旧记录正常返回。
	} else {
		const check = verifyRecord(getProjectKey(cwd), parsed);
		if (!check.verified) {
			signatureBroken = true;
		}
	}

	return {
		...parsed,
		id,
		version,
		status,
		taskDir,
		_signatureBroken: signatureBroken || undefined,
	};
}

export function writeFlowTask(cwd: string, taskId: string, task: Record<string, unknown>): void {
	const taskDir = resolveFlowTaskDir(cwd, taskId);
	mkdirSync(taskDir, { recursive: true });
	const { taskDir: _taskDir, _signatureBroken: _broken, ...serializable } = task;
	// 为判定关键字段签名。runtime 独占签名能力(agent 拿不到密钥),篡改即被验出。
	const projectKey = getProjectKey(cwd);
	const sig = signRecord(projectKey, serializable, TASK_SIGNED_FIELDS);
	const withSig: Record<string, unknown> = { ...serializable, _sig: sig };
	writeFileSync(path.join(taskDir, "task.json"), `${JSON.stringify(withSig, null, "\t")}\n`);
	// 首次签名写入即关闭迁移窗口:此后无 _sig 的记录不再被信任。
	closeMigrationWindow(cwd);
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

export function deleteFlowTask(cwd: string, taskId: string): boolean {
	const taskDir = resolveFlowTaskDir(cwd, taskId);
	if (!existsSync(taskDir)) {
		return false;
	}
	rmSync(taskDir, { recursive: true, force: true });
	return true;
}
