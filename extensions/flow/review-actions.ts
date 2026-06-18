import { readFlowRunValidation } from "./run-validation.ts";
import {
	acceptFlowReview,
	readFlowReview,
	rejectFlowReview,
	startFlowReview,
	type FlowReviewRecord,
} from "./review-store.ts";
import { readTaskMetadata, type TaskGuardResult } from "./lifecycle-gates.ts";
import type { FlowDriverSummary } from "./types.ts";

/**
 * Review 生命周期的纯决策模块。
 *
 * 从 index.ts 抽出的第二块 deep module。startCompletedFlowReview /
 * acceptCompletedFlowReview / rejectCompletedFlowReview 三个函数原本把
 * "判断能不能做 + 改 review 记录 + 改 task 状态 + 通知用户 / 刷界面" 混在一起。
 * 这里只管前三步(纯领域逻辑,不碰 UI/进程表),返回一个决策结果;
 * index.ts 拿到结果后负责执行副作用(notify / focus 刷新 / stage gate 弹窗)。
 *
 * 入参里 driverLive 是布尔——"这个 run 的 driver 是否仍在运行"由 index.ts 的进程表
 * 判断后传入,本模块不持有任何运行时进程状态。
 */

export interface ReviewDriverContext {
	driver: FlowDriverSummary;
	driverLive: boolean;
}

/** task 状态变更意图:接受后 → verified,拒绝后 → needs-human。 */
export interface TaskStatusTransition {
	status: "verified" | "needs-human";
	fields: Record<string, unknown>;
}

export type ReviewActionOutcome =
	| { ok: false; reason: string; type: "warning" | "error" }
	| ({ ok: true; review: FlowReviewRecord } & (
			| { kind: "started"; taskNextStep: string }
			| { kind: "accepted"; taskTransition: TaskStatusTransition }
			| { kind: "rejected"; taskTransition: TaskStatusTransition }
	  ));

function fail(reason: string, type: "warning" | "error" = "warning"): ReviewActionOutcome {
	return { ok: false, reason, type };
}

/**
 * 校验 review 前置条件(driver 不在跑、validation 为 PASS、已有 review 记录)。
 * start 不要求已有 review;accept/reject 要求。
 *
 * liveWording/validationWording 保持与原 index.ts 内联实现一致的文案:
 * start 用 "cannot start"、accept/reject 用 "cannot change" / "cannot be accepted|rejected"。
 */
function checkReviewPrerequisites(
	ctx: ReviewDriverContext,
	wording: { liveVerb: "start" | "change"; validationPhase: "start" | "accepted" | "rejected" },
	requireExistingReview: boolean,
): ReviewActionOutcome | { ok: true; validation: ReturnType<typeof readFlowRunValidation> } {
	const { driver, driverLive } = ctx;
	if (driverLive) {
		return fail(`Flow task review cannot ${wording.liveVerb} while the Flow driver is still running.`);
	}
	const validation = readFlowRunValidation(driver.runDir);
	if (!validation || validation.result !== "PASS") {
		return fail(`Flow review cannot be ${wording.validationPhase} because validation is not PASS: ${driver.taskId}/${driver.runId}`);
	}
	if (requireExistingReview) {
		const existingReview = readFlowReview(driver.runDir);
		if (!existingReview) {
			return fail(`Flow review has not started for ${driver.taskId}/${driver.runId}. Run /flow task review ${driver.taskId}/${driver.runId} first.`);
		}
	}
	return { ok: true, validation };
}

export function startReview(ctx: ReviewDriverContext): ReviewActionOutcome {
	const guard = checkReviewPrerequisites(ctx, { liveVerb: "start", validationPhase: "start" }, false);
	if (!guard.ok) {
		return guard;
	}
	const { driver } = ctx;
	const review = startFlowReview({
		taskId: driver.taskId,
		runId: driver.runId,
		runDir: driver.runDir,
	});
	return {
		ok: true,
		kind: "started",
		review,
		taskNextStep: `main reviewing ${driver.taskId}/${driver.runId}`,
	};
}

export function acceptReview(ctx: ReviewDriverContext, cwd: string): ReviewActionOutcome {
	const guard = checkReviewPrerequisites(ctx, { liveVerb: "change", validationPhase: "accepted" }, true);
	if (!guard.ok) {
		return guard;
	}
	const { driver } = ctx;
	const task = readTaskMetadata(cwd, driver.taskId);
	if (!task.ok) {
		return fail(task.message, task.type);
	}
	const review = acceptFlowReview({
		taskId: driver.taskId,
		runId: driver.runId,
		runDir: driver.runDir,
		taskVersion: task.version,
	});
	return {
		ok: true,
		kind: "accepted",
		review,
		taskTransition: {
			status: "verified",
			fields: {
				latest_review_run: driver.runId,
				latest_review_status: review.status,
				latest_validation: guard.validation!.result,
				next_step: `/flow run ${driver.taskId}`,
			},
		},
	};
}

export function rejectReview(ctx: ReviewDriverContext, reason?: string): ReviewActionOutcome {
	const guard = checkReviewPrerequisites(ctx, { liveVerb: "change", validationPhase: "rejected" }, true);
	if (!guard.ok) {
		return guard;
	}
	const { driver } = ctx;
	const review = rejectFlowReview({
		taskId: driver.taskId,
		runId: driver.runId,
		runDir: driver.runDir,
		reason,
	});
	return {
		ok: true,
		kind: "rejected",
		review,
		taskTransition: {
			status: "needs-human",
			fields: {
				latest_review_run: driver.runId,
				latest_review_status: review.status,
				latest_validation: guard.validation!.result,
				next_step: `fix ${driver.taskId}/${driver.runId} and run /flow task prove ${driver.taskId}`,
			},
		},
	};
}
