import { existsSync } from "node:fs";
import path from "node:path";
import { readFlowRunValidation } from "./run-validation.ts";
import {
	acceptFlowReview,
	readFlowReview,
	rejectFlowReview,
	startFlowReview,
	type FlowReviewRecord,
} from "./review-store.ts";
import { CORRUPT_FEEDBACK } from "./flow-signing.ts";
import { normalizeLegacyState, transition } from "./task-state.ts";
import { readFlowTask, writeFlowTask } from "./task-store.ts";
import type { FlowDriverSummary } from "./types.ts";

/**
 * Review 生命周期的决策模块(状态机版)。
 *
 * 从 index.ts 抽出的 deep module。startReview / acceptReview / rejectReview 三个
 * 动作校验前置条件(driver 不在跑、validation 为 PASS、已有 review 记录)后,
 * 通过中心状态机 transition() 推进 task 状态。task.json 的 status 写权独占在
 * task-state;本模块只发起合法转换事件。
 *
 * 副作用分工:本模块负责改 review 记录 + 推进 task 状态(纯文件操作);
 * index.ts 负责按返回的 outcome 决定 UI(notify / focus / stage gate)。
 * driverLive 由 index.ts 的进程表判断后传入——本模块不持有运行时进程状态。
 */

export interface ReviewDriverContext {
	driver: FlowDriverSummary;
	driverLive: boolean;
}

export type ReviewActionOutcome =
	| { ok: false; reason: string; type: "warning" | "error" }
	| ({ ok: true; review: FlowReviewRecord } & (
			| { kind: "started" }
			| { kind: "accepted" }
			| { kind: "rejected" }
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
	cwd: string,
	wording: { liveVerb: "start" | "change"; validationPhase: "start" | "accepted" | "rejected" },
	requireExistingReview: boolean,
): ReviewActionOutcome | { ok: true; validation: ReturnType<typeof readFlowRunValidation> } {
	const { driver, driverLive } = ctx;
	if (driverLive) {
		return fail(`Flow task review cannot ${wording.liveVerb} while the Flow driver is still running.`);
	}
	const validation = readFlowRunValidation(driver.runDir, cwd);
	if (!validation) {
		// 读不出 validation:区分"没跑过"vs"记录损坏"。文件存在但读不出 = 损坏,引导 repair。
		if (existsSync(path.join(driver.runDir, "validation.json"))) {
			return fail(CORRUPT_FEEDBACK.validation(driver.runId));
		}
		return fail(`Flow review cannot be ${wording.validationPhase} because validation is not PASS: ${driver.taskId}/${driver.runId}`);
	}
	if (validation.result !== "PASS") {
		return fail(`Flow review cannot be ${wording.validationPhase} because validation is not PASS: ${driver.taskId}/${driver.runId}`);
	}
	if (requireExistingReview) {
		const existingReview = readFlowReview(driver.runDir, cwd);
		if (!existingReview) {
			// 区分"没开始 review"vs"review 记录损坏":文件存在但读不出 = 损坏,引导 repair。
			if (existsSync(path.join(driver.runDir, "review.json"))) {
				return fail(CORRUPT_FEEDBACK.review(driver.taskId, driver.runId));
			}
			return fail(`Flow review has not started for ${driver.taskId}/${driver.runId}. Run /flow task review ${driver.taskId}/${driver.runId} first.`);
		}
	}
	return { ok: true, validation };
}

export function startReview(ctx: ReviewDriverContext, cwd: string): ReviewActionOutcome {
	const guard = checkReviewPrerequisites(ctx, cwd, { liveVerb: "start", validationPhase: "start" }, false);
	if (!guard.ok) {
		return guard;
	}
	const { driver } = ctx;
	// 先推进 task 状态(状态机独占写权);成功后才写 review 记录,避免半提交。
	const transitionResult = transition(cwd, driver.taskId, {
		kind: "review-start",
		runId: driver.runId,
		nextStep: `main reviewing ${driver.taskId}/${driver.runId}`,
	});
	if (!transitionResult.ok) {
		return fail(transitionResult.reason, "error");
	}
	const review = startFlowReview({
		cwd,
		taskId: driver.taskId,
		runId: driver.runId,
		runDir: driver.runDir,
	});
	return { ok: true, kind: "started", review };
}

export function acceptReview(ctx: ReviewDriverContext, cwd: string): ReviewActionOutcome {
	const guard = checkReviewPrerequisites(ctx, cwd, { liveVerb: "change", validationPhase: "accepted" }, true);
	if (!guard.ok) {
		return guard;
	}
	const { driver } = ctx;
	const task = readFlowTask(cwd, driver.taskId);
	if (!task) {
		return fail(`Flow task not found: ${driver.taskId}`, "error");
	}
	// 先推进 task 状态(reviewing -> ready);成功后才写 accepted review,避免半提交。
	const transitionResult = transition(cwd, driver.taskId, {
		kind: "review-accept",
		runId: driver.runId,
		origin: "local-proved",
		nextStep: `/flow run ${driver.taskId}`,
	});
	if (!transitionResult.ok) {
		return fail(transitionResult.reason, "error");
	}
	// acceptFlowReview 内部扫描设计资产 mtime 变化,决定 taskDesignUpdated/updatedFiles。
	// 先用当前 version 写 review;若检测到设计更新,再 bump version 并回写 task.json +
	// review.json 的 taskVersion(均带签名)。agent 永不手改 task.json(那会破坏签名)。
	const review = acceptFlowReview({
		cwd,
		taskId: driver.taskId,
		runId: driver.runId,
		runDir: driver.runDir,
		taskVersion: task.version,
	});
	if (review.taskDesignUpdated) {
		const nextVersion = task.version + 1;
		const currentTask = readFlowTask(cwd, driver.taskId);
		if (currentTask) {
			const { taskDir: _td, _signatureBroken: _broken, ...fields } = currentTask;
			writeFlowTask(cwd, driver.taskId, { ...fields, version: nextVersion });
		}
		// 回写 review 的 taskVersion 为 bump 后的值(重签)。
		return { ok: true, kind: "accepted", review: acceptFlowReview({
			cwd,
			taskId: driver.taskId,
			runId: driver.runId,
			runDir: driver.runDir,
			taskVersion: nextVersion,
		}) };
	}
	return { ok: true, kind: "accepted", review };
}

export function rejectReview(ctx: ReviewDriverContext, cwd: string, reason?: string): ReviewActionOutcome {
	const guard = checkReviewPrerequisites(ctx, cwd, { liveVerb: "change", validationPhase: "rejected" }, true);
	if (!guard.ok) {
		return guard;
	}
	const { driver } = ctx;
	// 先推进 task 状态(reviewing -> needs-work);成功后才写 rejected review,避免半提交。
	const transitionResult = transition(cwd, driver.taskId, {
		kind: "review-reject",
		runId: driver.runId,
		nextStep: `fix ${driver.taskId}/${driver.runId} and run /flow task prove ${driver.taskId}`,
	});
	if (!transitionResult.ok) {
		return fail(transitionResult.reason, "error");
	}
	const review = rejectFlowReview({
		cwd,
		taskId: driver.taskId,
		runId: driver.runId,
		runDir: driver.runDir,
		reason,
	});
	return { ok: true, kind: "rejected", review };
}

/** 供 index.ts 读取当前归一状态(legacy verified/active/approved → ready)。 */
export function getNormalizedState(rawStatus: string | undefined): string {
	return normalizeLegacyState(rawStatus);
}
