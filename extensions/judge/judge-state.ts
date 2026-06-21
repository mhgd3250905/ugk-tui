import { DEFAULT_MAX_STEER } from "./constants.ts";

export interface RequirementsSpec {
	goal: string;
	hardConstraints: string[];
	acceptance: string[];
	forbidden: string[];
	context: string;
}

export interface DriverPathTried {
	toolName: string;
	argsSummary: string;
	resultSummary: string;
	failed: boolean;
}

export interface DriverArtifact {
	path: string;
	kind: string;
}

export interface DriverRunningTool {
	toolName: string;
	argsSummary: string;
	startedAtMs: number;
	elapsedMs: number;
}

export interface SteerRecord {
	direction: string;
	reason: string;
	turnIndex: number;
}

export interface DriverSummary {
	pathsTried: DriverPathTried[];
	artifacts: DriverArtifact[];
	runningTools: DriverRunningTool[];
	lastError?: string;
	turnCount: number;
	steerCount: number;
	steerHistory: SteerRecord[];
	completed: boolean;
	aborted?: boolean;
	abortReason?: string;
}

export type JudgePhase = "aligning" | "driving" | "delivering" | "aborted" | "done";

/**
 * 待接受的 taskbook 沉淀数据。当 PASS 走 pendingAck 路径(无 confirm UI 或
 * 拒绝+无预算)时,把 finalVerdict 和 DriverSummary 暂存,等 /judge ack
 * 接受后由 ack handler 调 recordTaskbookRun 完成沉淀。
 * 对齐 docs/judge.md 的「PASS 且用户接受交付后追加 runs[] 并覆盖 experience.md」。
 */
export interface PendingTaskbookRun {
	name: string;
	spec: RequirementsSpec;
	summary: DriverSummary;
	finalVerdict: unknown; // JudgeFinalVerdict,但 judge-state 不依赖 judge-utils 的类型
}

export interface JudgeState {
	phase: JudgePhase;
	spec: RequirementsSpec | null;
	summary: string;
	steerCount: number;
	maxSteer: number;
	keepWatching: boolean;
	pendingAckStatus?: "pass" | "fail";
	pendingTaskbookRun?: PendingTaskbookRun;  // pendingAck=pass 时用于 ack handler 沉淀
	taskbookName?: string;
	aligningMode?: "new" | "edit";
	/**
	 * C-2 机制闸:aligning 阶段是否调过 questionnaire。
	 * 若为 false,Judge 产出 Spec 时禁止委派(防止 Judge 偷懒跳过假设确认)。
	 * enterAligning 复位为 false;questionnaire 工具被调用时置 true。
	 */
	aligningQuestionnaireUsed: boolean;
}

export function createJudgeState(): JudgeState {
	return {
		phase: "aborted",
		spec: null,
		summary: "",
		steerCount: 0,
		maxSteer: DEFAULT_MAX_STEER,
		keepWatching: false,
		pendingAckStatus: undefined,
		aligningMode: "new",
		aligningQuestionnaireUsed: false,
	};
}

export function enterAligning(state: JudgeState): JudgeState {
	return {
		...state,
		phase: "aligning",
		steerCount: 0,
		keepWatching: true,
		pendingAckStatus: undefined,
		aligningMode: "new",
		aligningQuestionnaireUsed: false,
	};
}

export function setAligningMode(state: JudgeState, mode: "new" | "edit"): JudgeState {
	return { ...state, aligningMode: mode };
}

export function markAligningQuestionnaireUsed(state: JudgeState): JudgeState {
	if (state.phase !== "aligning" || state.aligningQuestionnaireUsed) return state;
	return { ...state, aligningQuestionnaireUsed: true };
}

export function setRequirementsSpec(state: JudgeState, spec: RequirementsSpec): JudgeState {
	return {
		...state,
		spec,
	};
}

export function setTaskbookForRun(state: JudgeState, name: string): JudgeState {
	return {
		...state,
		taskbookName: name,
	};
}

export function startDriving(state: JudgeState): JudgeState {
	return {
		...state,
		phase: "driving",
		keepWatching: true,
		pendingAckStatus: undefined,
	};
}

export function enterDelivering(state: JudgeState): JudgeState {
	return {
		...state,
		phase: "delivering",
		keepWatching: false,
		pendingAckStatus: undefined,
	};
}

export function markPendingAck(state: JudgeState, status: "pass" | "fail"): JudgeState {
	return {
		...state,
		pendingAckStatus: status,
	};
}

/**
 * 暂存 pending ack 时的 taskbook 沉淀数据。/judge ack 接受时消费。
 * 只在 status="pass" 时有意义(fail 不沉淀到 experience.md)。
 */
export function setPendingTaskbookRun(state: JudgeState, run: PendingTaskbookRun): JudgeState {
	return {
		...state,
		pendingTaskbookRun: run,
	};
}

export function clearPendingTaskbookRun(state: JudgeState): JudgeState {
	if (state.pendingTaskbookRun === undefined) return state;
	const { pendingTaskbookRun: _omit, ...rest } = state;
	return rest;
}

export function recordJudgeSteer(state: JudgeState): JudgeState {
	return {
		...state,
		steerCount: state.steerCount + 1,
	};
}

export function recordJudgeEscalation(state: JudgeState, summary: string): JudgeState {
	return {
		...state,
		summary,
		keepWatching: false,
	};
}

export function abortJudge(state: JudgeState): JudgeState {
	return {
		...state,
		phase: "aborted",
		keepWatching: false,
		pendingAckStatus: undefined,
		pendingTaskbookRun: undefined,
	};
}

export function completeJudge(state: JudgeState): JudgeState {
	return {
		...state,
		phase: "done",
		keepWatching: false,
		pendingAckStatus: undefined,
		pendingTaskbookRun: undefined,
	};
}
