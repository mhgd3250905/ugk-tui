import { existsSync } from "node:fs";
import path from "node:path";
import { isRecord, readJsonStrict } from "./flow-fs.ts";
import { CORRUPT_FEEDBACK } from "./flow-signing.ts";
import { invalidFlowTaskIdMessage, isValidFlowTaskId } from "./parser.ts";
import { acceptFlowReview, isFlowReviewAccepted, readFlowReview } from "./review-store.ts";
import { getProjectKey } from "./task-store.ts";
import { isRunnable, normalizeLegacyState } from "./task-state.ts";
import { validateFlowTaskAssets } from "./task-validation.ts";
import type { FlowDriverStatus } from "./types.ts";
import { verifyRecord } from "./flow-signing.ts";
import { isInMigrationWindow } from "./task-store.ts";

/**
 * 纯生命周期 gate:只读 + 判断,零 UI/进程副作用。
 *
 * 这是从 index.ts 抽出的第一块 deep module 雏形。生命周期编排(状态能否推进、
 * run 能否启动、review 能否开始)的判断规则集中在此,driver 进程管理与 UI 副作用
 * 仍留在 index.ts。这样的拆分让 gate 可以被独立测试,不依赖任何 TUI/事件环境。
 */

export type TaskGuardResult =
	| { ok: true; taskDir: string; status: string | undefined; version: number; latestReviewRun?: string }
	| { ok: false; message: string; type: "warning" | "error" };

export const TRANSIENT_DRIVER_STATUSES: FlowDriverStatus[] = [
	"starting",
	"running",
	"waiting",
	"waiting-for-user",
	"validating",
];

export function isTransientDriverStatus(status: FlowDriverStatus): boolean {
	return TRANSIENT_DRIVER_STATUSES.includes(status);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function readTaskMetadata(cwd: string, taskId: string): TaskGuardResult {
	if (!isValidFlowTaskId(taskId)) {
		return { ok: false, message: invalidFlowTaskIdMessage(taskId), type: "error" };
	}
	const taskDir = path.join(cwd, ".flow", "tasks", taskId);
	const taskJsonPath = path.join(taskDir, "task.json");
	if (!existsSync(taskJsonPath)) {
		return { ok: false, message: `Flow task not found: ${taskId}`, type: "error" };
	}

	let parsed: unknown;
	try {
		parsed = readJsonStrict(taskJsonPath);
	} catch (error) {
		return {
			ok: false,
			message: `Flow task metadata is invalid: ${taskJsonPath}\n${errorMessage(error)}`,
			type: "error",
		};
	}

	// 签名校验:迁移窗口外,无 _sig 或签名不符 = 记录被篡改。
	// 反馈用中性措辞(CORRUPT_FEEDBACK),不提签名/密钥——见设计文档反馈安全要求。
	if (!isInMigrationWindow(cwd) && isRecord(parsed)) {
		const sigCheck = verifyRecord(getProjectKey(cwd), parsed);
		if (!sigCheck.verified) {
			return {
				ok: false,
				message: CORRUPT_FEEDBACK.taskStatus(taskId),
				type: "warning",
			};
		}
	}

	return {
		ok: true,
		taskDir,
		status: isRecord(parsed) && typeof parsed.status === "string" ? parsed.status : undefined,
		version: isRecord(parsed) && typeof parsed.version === "number" ? parsed.version : 1,
		latestReviewRun: isRecord(parsed) && typeof parsed.latest_review_run === "string" ? parsed.latest_review_run : undefined,
	};
}

export function validateTaskForDriver(kind: "prove" | "run", cwd: string, taskId: string): TaskGuardResult {
	const task = readTaskMetadata(cwd, taskId);
	if (!task.ok) {
		return task;
	}

	if (kind === "prove") {
		const assetValidation = validateFlowTaskAssets(cwd, taskId);
		if (!assetValidation.ok) {
			return {
				ok: false,
				message: `Flow task ${taskId} is incomplete. Runtime gate failed: ${assetValidation.issues.join(", ")}`,
				type: "error",
			};
		}
		return task;
	}

	const normalizedStatus = normalizeLegacyState(task.status);
	if (!isRunnable(normalizedStatus)) {
		return {
			ok: false,
			message: `Flow task ${taskId} status is ${task.status ?? "unknown"}; /flow run requires ready.`,
			type: "warning",
		};
	}
	if (!task.latestReviewRun) {
		return {
			ok: false,
			message: `Flow task ${taskId} is ${task.status} but has no accepted review. Run /flow task review <run-id> first.`,
			type: "warning",
		};
	}
	const reviewRunDir = path.join(task.taskDir, "runs", task.latestReviewRun);
	let review = readFlowReview(reviewRunDir, cwd);
	const expectedReview = { taskId, runId: task.latestReviewRun };
	if (
		!isFlowReviewAccepted(review, task.version, expectedReview) &&
		review?.status === "accepted" &&
		review.userConfirmed &&
		review.taskId === taskId &&
		review.runId === task.latestReviewRun &&
		review.taskVersion === undefined
	) {
		review = acceptFlowReview({
			cwd,
			taskId,
			runId: task.latestReviewRun,
			runDir: reviewRunDir,
			taskVersion: task.version,
		});
	}
	if (!isFlowReviewAccepted(review, task.version, expectedReview)) {
		return {
			ok: false,
			message: `Flow task ${taskId} is ${task.status} but accepted review ${task.latestReviewRun} is missing or not valid for version ${task.version}.`,
			type: "warning",
		};
	}
	return task;
}
