import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readJsonRecord } from "./flow-fs.ts";
import { signRecord, verifyRecord } from "./flow-signing.ts";
import { getProjectKey } from "./task-store.ts";

/** review.json 签名覆盖的关键字段:防 agent 把 rejected 改 accepted,或伪造 acceptedAt。 */
const REVIEW_SIGNED_FIELDS = ["taskId", "runId", "status", "taskVersion", "acceptedAt"];

export type FlowReviewStatus = "in-review" | "accepted" | "rejected" | "needs-changes";
export type FlowTaskDesignDecision = "updated" | "no-change";

export interface FlowReviewRecord {
	taskId: string;
	runId: string;
	status: FlowReviewStatus;
	userConfirmed: boolean;
	taskDesignUpdated: boolean;
	taskDesignDecision?: FlowTaskDesignDecision;
	taskVersion?: number;
	startedAt: string;
	acceptedAt?: string;
	decisions: string[];
	updatedFiles: string[];
}

interface StartFlowReviewArgs {
	cwd: string;
	taskId: string;
	runId: string;
	runDir: string;
	now?: Date;
}

interface AcceptFlowReviewArgs {
	cwd: string;
	taskId: string;
	runId: string;
	runDir: string;
	taskVersion: number;
	now?: Date;
}

interface RejectFlowReviewArgs {
	cwd: string;
	taskId: string;
	runId: string;
	runDir: string;
	reason?: string;
	now?: Date;
}

function normalizeReview(value: Record<string, unknown>, runDir: string): FlowReviewRecord | undefined {
	const taskId = typeof value.taskId === "string" ? value.taskId : undefined;
	const runId = typeof value.runId === "string" ? value.runId : path.basename(runDir);
	const status = typeof value.status === "string" ? value.status : undefined;
	if (!taskId || !runId || !["in-review", "accepted", "rejected", "needs-changes"].includes(status ?? "")) {
		return undefined;
	}
	return {
		taskId,
		runId,
		status: status as FlowReviewStatus,
		userConfirmed: value.userConfirmed === true,
		taskDesignUpdated: value.taskDesignUpdated === true,
		taskDesignDecision: value.taskDesignDecision === "updated" || value.taskDesignDecision === "no-change"
			? value.taskDesignDecision
			: undefined,
		taskVersion: typeof value.taskVersion === "number" ? value.taskVersion : undefined,
		startedAt: typeof value.startedAt === "string" ? value.startedAt : new Date(0).toISOString(),
		acceptedAt: typeof value.acceptedAt === "string" ? value.acceptedAt : undefined,
		decisions: Array.isArray(value.decisions) ? value.decisions.filter((item): item is string => typeof item === "string") : [],
		updatedFiles: Array.isArray(value.updatedFiles) ? value.updatedFiles.filter((item): item is string => typeof item === "string") : [],
	};
}

function renderReviewMarkdown(review: FlowReviewRecord): string {
	const userConfirmation = review.userConfirmed ? "confirmed" : "pending";
	const taskDesignDecision = review.taskDesignDecision ?? (review.taskDesignUpdated ? "updated" : "pending");
	const decisions = review.decisions.length > 0 ? review.decisions.map((decision) => `- ${decision}`) : ["- pending"];
	const updatedFiles = review.updatedFiles.length > 0 ? review.updatedFiles.map((file) => `- ${file}`) : ["- pending"];
	return [
		`# Flow Task Review - ${review.taskId}/${review.runId}`,
		"",
		`Status: ${review.status}`,
		`User confirmation: ${userConfirmation}`,
		`Task design decision: ${taskDesignDecision}`,
		review.taskVersion ? `Task version: ${review.taskVersion}` : undefined,
		review.acceptedAt ? `Accepted at: ${review.acceptedAt}` : undefined,
		"",
		"## User Checks",
		`- Operation path reasonable: ${review.status === "accepted" ? "confirmed" : "pending"}`,
		`- Output format acceptable: ${review.status === "accepted" ? "confirmed" : "pending"}`,
		`- Evidence sufficient: ${review.status === "accepted" ? "confirmed" : "pending"}`,
		`- Changes to persist: ${review.taskDesignDecision === "no-change" ? "not needed" : review.taskDesignUpdated ? "done" : "pending"}`,
		"",
		"## Decisions",
		...decisions,
		"",
		"## Updated Files",
		...updatedFiles,
		"",
	].filter((line): line is string => line !== undefined).join("\n");
}

/** 写 review.json(带签名)+ review.md。签名由 runtime 独占(agent 拿不到密钥)。 */
function writeSignedReview(cwd: string, runDir: string, review: FlowReviewRecord): void {
	mkdirSync(runDir, { recursive: true });
	const projectKey = getProjectKey(cwd);
	const reviewRecord = review as unknown as Record<string, unknown>;
	const sig = signRecord(projectKey, reviewRecord, REVIEW_SIGNED_FIELDS);
	const withSig = { ...reviewRecord, _sig: sig };
	writeFileSync(path.join(runDir, "review.json"), `${JSON.stringify(withSig, null, "\t")}\n`);
	writeFileSync(path.join(runDir, "review.md"), renderReviewMarkdown(review));
}

export function startFlowReview(args: StartFlowReviewArgs): FlowReviewRecord {
	mkdirSync(args.runDir, { recursive: true });
	const existing = readFlowReview(args.runDir);
	if (existing?.status === "accepted") {
		return existing;
	}
	const review: FlowReviewRecord = {
		taskId: args.taskId,
		runId: args.runId,
		status: "in-review",
		userConfirmed: false,
		taskDesignUpdated: false,
		startedAt: (args.now ?? new Date()).toISOString(),
		decisions: [],
		updatedFiles: [],
	};
	writeSignedReview(args.cwd, args.runDir, review);
	if (!existsSync(path.join(args.runDir, "review.md"))) {
		writeFileSync(path.join(args.runDir, "review.md"), renderReviewMarkdown(review));
	}
	return review;
}

export function acceptFlowReview(args: AcceptFlowReviewArgs): FlowReviewRecord {
	mkdirSync(args.runDir, { recursive: true });
	const existing = readFlowReview(args.runDir);
	const taskDesignDecision: FlowTaskDesignDecision =
		existing?.taskDesignDecision ??
		(existing?.taskDesignUpdated || (existing?.updatedFiles.length ?? 0) > 0 ? "updated" : "no-change");
	const review: FlowReviewRecord = {
		taskId: args.taskId,
		runId: args.runId,
		status: "accepted",
		userConfirmed: true,
		taskDesignUpdated: taskDesignDecision === "updated",
		taskDesignDecision,
		taskVersion: args.taskVersion,
		startedAt: existing?.startedAt ?? (args.now ?? new Date()).toISOString(),
		acceptedAt: (args.now ?? new Date()).toISOString(),
		decisions: existing?.decisions.length
			? existing.decisions
			: [taskDesignDecision === "updated"
					? "用户已确认本次 prove 输出、证据和任务设计沉淀可以进入 verified。"
					: "用户已确认本次 prove 输出和证据可接受，Task 设计无需修改。"],
		updatedFiles: existing?.updatedFiles.length ? existing.updatedFiles : [],
	};
	writeSignedReview(args.cwd, args.runDir, review);
	return review;
}

export function rejectFlowReview(args: RejectFlowReviewArgs): FlowReviewRecord {
	mkdirSync(args.runDir, { recursive: true });
	const existing = readFlowReview(args.runDir);
	const review: FlowReviewRecord = {
		taskId: args.taskId,
		runId: args.runId,
		status: "needs-changes",
		userConfirmed: false,
		taskDesignUpdated: false,
		taskDesignDecision: undefined,
		taskVersion: existing?.taskVersion,
		startedAt: existing?.startedAt ?? (args.now ?? new Date()).toISOString(),
		decisions: [args.reason?.trim() || "本次 review 未通过，需要修正后重新 prove。"],
		updatedFiles: existing?.updatedFiles ?? [],
	};
	writeSignedReview(args.cwd, args.runDir, review);
	return review;
}

export function readFlowReview(runDir: string): FlowReviewRecord | undefined {
	const parsed = readJsonRecord(path.join(runDir, "review.json"));
	return parsed ? normalizeReview(parsed, runDir) : undefined;
}

export function isFlowReviewAccepted(
	review: FlowReviewRecord | undefined,
	taskVersion: number,
	expected?: { taskId: string; runId: string },
): boolean {
	const hasSettledTaskDesign =
		review?.taskDesignUpdated === true ||
		review?.taskDesignDecision === "updated" ||
		review?.taskDesignDecision === "no-change";
	return Boolean(
		review &&
			(!expected || (review.taskId === expected.taskId && review.runId === expected.runId)) &&
			review.status === "accepted" &&
			review.userConfirmed &&
			hasSettledTaskDesign &&
			typeof review.taskVersion === "number" &&
			review.taskVersion >= taskVersion,
	);
}
