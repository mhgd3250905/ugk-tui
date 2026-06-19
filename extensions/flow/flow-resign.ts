import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isRecord, readJsonStrict } from "./flow-fs.ts";
import { signRecord, TASK_SIGNED_FIELDS, REVIEW_SIGNED_FIELDS, VALIDATION_SIGNED_FIELDS, STATUS_SIGNED_FIELDS } from "./flow-signing.ts";
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
		const taskDir = path.join(tasksDir, taskEntry.name);

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

		// runs/*/review.json + validation.json
		const runsDir = path.join(taskDir, "runs");
		if (!existsSync(runsDir)) continue;
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
						const sig = signRecord(projectKey, parsed, STATUS_SIGNED_FIELDS);
						writeFileSync(statusPath, `${JSON.stringify({ ...parsed, _sig: sig }, null, "\t")}\n`);
						result.statuses++;
					}
				} catch {
					result.skipped++;
				}
			}
		}
	}

	writeResetLog(cwd, reason, result);
	return result;
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
