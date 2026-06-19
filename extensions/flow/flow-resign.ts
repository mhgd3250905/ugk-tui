import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isRecord, readJsonStrict } from "./flow-fs.ts";
import { signRecord, verifyRecord, TASK_SIGNED_FIELDS, REVIEW_SIGNED_FIELDS, VALIDATION_SIGNED_FIELDS, STATUS_SIGNED_FIELDS } from "./flow-signing.ts";
import { getProjectKey, isInMigrationWindow, closeMigrationWindow } from "./task-store.ts";

/**
 * 重签所有 Flow 判定记录(task.json / review.json / validation.json)。
 *
 * 两个入口共用本模块:
 * - /flow reset-signing(手动):用户密钥丢失/换机器后,主动重签。警告 + 留痕。
 * - 启动期自动扫描(首次):迁移窗口内,首次发现项目时一次性重签所有旧记录。
 *
 * 重签 = 信任记录当前内容 + 用当前 projectKey 签名。这等于"接受现状"——
 * 用于恢复(密钥丢失)或迁移(旧数据/换机器),不用于正常流程。
 */

const RESET_LOG = ".flow/.signing-reset-log";

export interface ResignResult {
	/** 重签的记录数(按类型)。 */
	tasks: number;
	reviews: number;
	validations: number;
	statuses: number;
	/** 跳过的记录(无法解析的)。 */
	skipped: number;
}

/**
 * 重签单个 task 的所有判定记录:task.json + 该 task 所有 runs 目录下的
 * review.json/validation.json/status.json。用当前 projectKey 签名(信任当前内容)。
 *
 * 用途:/flow repair-signing <task-id>——agent 把 task.json 写脏后,用户用它恢复,
 * 不用删 task 重建。区别于 resignAllRecords(重签所有 task,密钥丢失场景)。
 */
export function resignTaskRecords(cwd: string, taskId: string): ResignResult {
	const result: ResignResult = { tasks: 0, reviews: 0, validations: 0, statuses: 0, skipped: 0 };
	const projectKey = getProjectKey(cwd);
	const tasksDir = path.join(cwd, ".flow", "tasks");
	const taskDir = path.join(tasksDir, taskId);
	if (!existsSync(taskDir)) {
		return result;
	}

	// 用户显式确认 repair-signing:信任当前内容,无条件重签(含 mismatch 的)。
	resignOneTask(projectKey, taskDir, result, "all");
	return result;
}

/**
 * 扫描项目所有判定记录并用当前 projectKey 重签。
 * 写 reset log(留痕)。调用方负责在合适时机调用(手动命令 / 启动期)。
 */
export function resignAllRecords(cwd: string, reason: string): ResignResult {
	const result: ResignResult = { tasks: 0, reviews: 0, validations: 0, statuses: 0, skipped: 0 };
	const projectKey = getProjectKey(cwd);
	const tasksDir = path.join(cwd, ".flow", "tasks");
	if (!existsSync(tasksDir)) {
		writeResetLog(cwd, reason, result);
		return result;
	}

	for (const taskEntry of readdirSync(tasksDir, { withFileTypes: true })) {
		if (!taskEntry.isDirectory()) continue;
		resignOneTask(projectKey, path.join(tasksDir, taskEntry.name), result);
	}

	writeResetLog(cwd, reason, result);
	return result;
}

/** 重签单个 task 目录下的所有判定记录(task.json + 各 run 的 review/validation/status)。 */
/**
 * 重签单个 task 目录下的所有判定记录。
 * statusStrategy:
 * - "unsigned-only":status.json 只补 no-signature 的(mismatch/malformed 跳过)。
 *   用于 autoMigrate/resignAllRecords——自动跑,不洗白篡改。
 * - "all":status.json 无条件重签。用于 resignTaskRecords(/flow repair-signing)——
 *   用户显式确认"信任当前内容",可以恢复 mismatch 的记录。
 */
function resignOneTask(projectKey: Buffer, taskDir: string, result: ResignResult, statusStrategy: "unsigned-only" | "all" = "unsigned-only"): void {
	// task.json
	const taskJsonPath = path.join(taskDir, "task.json");
	if (existsSync(taskJsonPath)) {
		try {
			const parsed = readJsonStrict(taskJsonPath);
			if (isRecord(parsed)) {
				const sig = signRecord(projectKey, parsed, TASK_SIGNED_FIELDS);
				writeFileSync(taskJsonPath, `${JSON.stringify({ ...parsed, _sig: sig }, null, "\t")}\n`);
				result.tasks++;
			}
		} catch {
			result.skipped++;
		}
	}

	// runs/*/review.json + validation.json + status.json
	const runsDir = path.join(taskDir, "runs");
	if (!existsSync(runsDir)) return;
	for (const runEntry of readdirSync(runsDir, { withFileTypes: true })) {
		if (!runEntry.isDirectory()) continue;
		const runDir = path.join(runsDir, runEntry.name);

		const reviewPath = path.join(runDir, "review.json");
		if (existsSync(reviewPath)) {
			try {
				const parsed = readJsonStrict(reviewPath);
				if (isRecord(parsed)) {
					const sig = signRecord(projectKey, parsed, REVIEW_SIGNED_FIELDS);
					writeFileSync(reviewPath, `${JSON.stringify({ ...parsed, _sig: sig }, null, "\t")}\n`);
					result.reviews++;
				}
			} catch {
				result.skipped++;
			}
		}

		const validationPath = path.join(runDir, "validation.json");
		if (existsSync(validationPath)) {
			try {
				const parsed = readJsonStrict(validationPath);
				if (isRecord(parsed)) {
					const sig = signRecord(projectKey, parsed, VALIDATION_SIGNED_FIELDS);
					writeFileSync(validationPath, `${JSON.stringify({ ...parsed, _sig: sig }, null, "\t")}\n`);
					result.validations++;
				}
			} catch {
				result.skipped++;
			}
		}

		const statusPath = path.join(runDir, "status.json");
		if (existsSync(statusPath)) {
			try {
				const parsed = readJsonStrict(statusPath);
				if (isRecord(parsed)) {
					// status.json 是 PR #9 才加签名的。
					// unsigned-only(autoMigrate):只补 no-signature,mismatch/malformed 跳过(不洗白篡改)。
					// all(repair-signing,用户确认):无条件重签。
					const check = verifyRecord(projectKey, parsed, STATUS_SIGNED_FIELDS);
					const shouldResign = statusStrategy === "all" || check.reason === "no-signature";
					if (shouldResign) {
						const sig = signRecord(projectKey, parsed, STATUS_SIGNED_FIELDS);
						writeFileSync(statusPath, `${JSON.stringify({ ...parsed, _sig: sig }, null, "\t")}\n`);
						result.statuses++;
					}
				}
			} catch {
				result.skipped++;
			}
		}
	}
}

/** 写 reset log(留痕)。记录时间、原因、重签数量。 */
function writeResetLog(cwd: string, reason: string, result: ResignResult): void {
	const logPath = path.join(cwd, RESET_LOG);
	const entry = [
		`## ${new Date().toISOString()}`,
		`reason: ${reason}`,
		`tasks: ${result.tasks}  reviews: ${result.reviews}  validations: ${result.validations}  statuses: ${result.statuses}  skipped: ${result.skipped}`,
		"",
	].join("\n");
	mkdirSync(path.dirname(logPath), { recursive: true });
	writeFileSync(logPath, entry, { flag: "a" });
}

/**
 * 启动期自动迁移:如果仍在迁移窗口(无 marker),扫描并重签所有记录,然后关窗口。
 * 在 registerFlow 初始化时调用一次。幂等(窗口已关则什么都不做)。
 */
export function autoMigrateIfNeeded(cwd: string): ResignResult | undefined {
	if (!isInMigrationWindow(cwd)) {
		return undefined;
	}
	// 只有存在 .flow/tasks 才需要迁移(空项目不迁)
	const tasksDir = path.join(cwd, ".flow", "tasks");
	if (!existsSync(tasksDir)) {
		return undefined;
	}
	const result = resignAllRecords(cwd, "auto-migrate on first run");
	closeMigrationWindow(cwd);
	return result;
}

/**
 * 扫描所有 run 的 status.json,只重签**无签名或签名不符**的(已签的跳过,不重复写)。
 *
 * 升级兼容:PR #9 之前 status.json 从不签名,PR #9 引入签名后,历史 run 的 unsigned
 * status.json 会在窗口外被 readDriverStatus 拒绝,导致 run 从菜单/review 入口消失。
 * 本函数在启动期(无论窗口状态)一次性补签这些旧记录,让升级不破坏现有数据。
 *
 * 区别于 resignAllRecords(重签所有记录,含已签的);本函数只补漏 status,不动
 * task/review/validation(它们在 PR #9 之前就已签名,无升级兼容问题)。
 */
export function resignUnsignedStatusRecords(cwd: string): number {
	const tasksDir = path.join(cwd, ".flow", "tasks");
	if (!existsSync(tasksDir)) {
		return 0;
	}
	const projectKey = getProjectKey(cwd);
	let resigned = 0;

	for (const taskEntry of readdirSync(tasksDir, { withFileTypes: true })) {
		if (!taskEntry.isDirectory()) continue;
		const runsDir = path.join(tasksDir, taskEntry.name, "runs");
		if (!existsSync(runsDir)) continue;
		for (const runEntry of readdirSync(runsDir, { withFileTypes: true })) {
			if (!runEntry.isDirectory()) continue;
			const statusPath = path.join(runsDir, runEntry.name, "status.json");
			if (!existsSync(statusPath)) continue;
			try {
				const parsed = readJsonStrict(statusPath);
				if (!isRecord(parsed)) continue;
				// 只补"完全没有 _sig"的旧版 status(PR #9 之前从不签名)。
				// 对已有 _sig 但 mismatch/malformed 的记录(被篡改/损坏)**绝不自动补签**——
				// 那会把检测到的篡改洗白成可信。交给显式 /flow repair-signing(用户确认)。
				const check = verifyRecord(projectKey, parsed, STATUS_SIGNED_FIELDS);
				if (check.verified) continue; // 已验过 → 跳过
				if (check.reason !== "no-signature") continue; // mismatch/malformed → 保持拒读
				const sig = signRecord(projectKey, parsed, STATUS_SIGNED_FIELDS);
				writeFileSync(statusPath, `${JSON.stringify({ ...parsed, _sig: sig }, null, "\t")}\n`);
				resigned++;
			} catch {
				// 解析/写入失败:跳过该文件,不阻断其他 run 的恢复。
			}
		}
	}
	return resigned;
}
