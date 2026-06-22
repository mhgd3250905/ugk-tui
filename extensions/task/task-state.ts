import type { RequirementsSpec } from "../judge/judge-state.ts";

export type TaskPhase = "planning" | "executing" | "reviewing" | "landed" | "aborted" | "done";

export interface TaskReviewResult {
	description: string;
	skill: string;
	verify: string;
	contract: unknown;
	tags?: string[];
}

export interface TaskState {
	phase: TaskPhase;
	spec: RequirementsSpec | null;
	taskbookName?: string;
	summary: string;
	retryCount: number;
	maxRetry: number;
	planQuestionnaireUsed: boolean;
	reviewQuestionnaireUsed: boolean;
	executeRunDir?: string;
	reviewResult?: TaskReviewResult;
}

export function createTaskState(): TaskState {
	return {
		phase: "aborted",
		spec: null,
		summary: "",
		retryCount: 0,
		maxRetry: 3,
		planQuestionnaireUsed: false,
		reviewQuestionnaireUsed: false,
		executeRunDir: undefined,
	};
}

export function enterPlanning(state: TaskState): TaskState {
	return {
		...state,
		phase: "planning",
		spec: null,
		summary: "",
		retryCount: 0,
		planQuestionnaireUsed: false,
		reviewQuestionnaireUsed: false,
		executeRunDir: undefined,
		reviewResult: undefined,
	};
}

export function setTaskSpec(state: TaskState, spec: RequirementsSpec): TaskState {
	return { ...state, spec };
}

export function setTaskbookName(state: TaskState, taskbookName: string | undefined): TaskState {
	return { ...state, taskbookName };
}

export function markPlanQuestionnaireUsed(state: TaskState): TaskState {
	if (state.phase !== "planning" || state.planQuestionnaireUsed) return state;
	return { ...state, planQuestionnaireUsed: true };
}

export function startExecuting(state: TaskState, executeRunDir?: string): TaskState {
	if (!state.planQuestionnaireUsed) throw new Error("Task planning questionnaire was not used");
	return {
		...state,
		phase: "executing",
		retryCount: 0,
		reviewQuestionnaireUsed: false,
		executeRunDir,
	};
}

export function enterReviewing(state: TaskState, summary: string): TaskState {
	return {
		...state,
		phase: "reviewing",
		summary,
		reviewQuestionnaireUsed: false,
		reviewResult: undefined,
	};
}

export function markReviewQuestionnaireUsed(state: TaskState): TaskState {
	if (state.phase !== "reviewing" || state.reviewQuestionnaireUsed) return state;
	return { ...state, reviewQuestionnaireUsed: true };
}

export function setTaskReviewResult(state: TaskState, reviewResult: TaskReviewResult): TaskState {
	return { ...state, reviewResult };
}

export function landTask(state: TaskState): TaskState {
	return { ...state, phase: "landed" };
}

export function abortTask(state: TaskState): TaskState {
	return {
		...state,
		phase: "aborted",
		retryCount: 0,
		planQuestionnaireUsed: false,
		reviewQuestionnaireUsed: false,
		executeRunDir: undefined,
	};
}

export function completeTask(state: TaskState): TaskState {
	return {
		...state,
		phase: "done",
		retryCount: 0,
		planQuestionnaireUsed: false,
		reviewQuestionnaireUsed: false,
		executeRunDir: undefined,
	};
}
