import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isRecord, readJsonStrict } from "./flow-fs.ts";
import { invalidFlowTaskIdMessage, isValidFlowTaskId } from "./parser.ts";
import { deriveProjectKey, getOrCreateMasterKey, signRecord, verifyRecord, TASK_SIGNED_FIELDS } from "./flow-signing.ts";

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
/**
 * 迁移标记文件位置:~/.flow-keys/<sha256(cwd)>.migrated。
 * 关键:不在 .flow/ 里——agent 能改/删 .flow/,若标记在那,agent 删除它即可
 * 让 runtime 回到"信任无签名旧记录"的迁移窗口,绕过签名链。放 home 目录下,
 * agent 工作区碰不到,与主密钥(~/.flow-master-key)同属一个隔离区。
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";

const MIGRATED_KEYS_DIR = path.join(homedir(), ".flow-keys");

function migratedMarkerPath(cwd: string): string {
	const hash = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 24);
	return path.join(MIGRATED_KEYS_DIR, `${hash}.migrated`);
}

export function isInMigrationWindow(cwd: string): boolean {
	return !existsSync(migratedMarkerPath(cwd));
}

/** 关闭迁移窗口:后续无 _sig 的记录不再被信任。runtime 首次签名写入后调用。 */
export function closeMigrationWindow(cwd: string): void {
	const markerPath = migratedMarkerPath(cwd);
	if (!existsSync(markerPath)) {
		mkdirSync(MIGRATED_KEYS_DIR, { recursive: true });
		writeFileSync(markerPath, new Date().toISOString());
	}
}

/** 派生项目签名密钥。 HKDF 轻量,但缓存一次避免重复派生。 */
const projectKeyCache = new Map<string, Buffer>();
export function getProjectKey(cwd: string): Buffer {
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

/**
 * 把磁盘上已有的 task.json 重签(原地)。
 *
 * 用途:`/flow task create` 是 prompt 驱动的——agent 按 prompts.ts 指示**手写**
 * task.json(它拿不到签名密钥,所以无 `_sig`)。runtime 在 agent_end 检测到新 task
 * 且资产校验通过后,调本函数把 agent 写的字段原样重发为签名版。这样:
 *  - 新建的 draft 立刻带合法签名,后续严格验签的读取路径(readTaskMetadata/
 *    readFlowTask)不会误报"记录不可用";
 *  - 首次签名即关闭迁移窗口(writeFlowTask 内部完成);
 *  - agent 面向的契约不变——它照样手写字段,runtime 透明签名。
 *
 * 读原始磁盘 JSON(不走 readFlowTask):draft 是 agent 刚写的,我们要的是它写
 * 的原始字段,不受签名状态影响。无 task.json 或字段非法时返回 false(调用方按
 * "task 没建好"处理,会落到 contract-repair 路径)。
 */
export function signFlowTaskOnDisk(cwd: string, taskId: string): boolean {
	const taskDir = resolveFlowTaskDir(cwd, taskId);
	const taskJsonPath = path.join(taskDir, "task.json");
	if (!existsSync(taskJsonPath)) {
		return false;
	}
	const parsed = readJsonStrict(taskJsonPath);
	if (!isRecord(parsed)) {
		return false;
	}
	// 保留 agent 写的所有业务字段,只剥离旧签名(若有)和 runtime-only 字段。
	const { _sig: _oldSig, taskDir: _td, _signatureBroken: _broken, ...fields } = parsed;
	writeFlowTask(cwd, taskId, fields);
	return true;
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
