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

export interface DriverSummary {
	pathsTried: DriverPathTried[];
	artifacts: DriverArtifact[];
	lastError?: string;
	turnCount: number;
	steerCount: number;
	completed: boolean;
	aborted?: boolean;
	abortReason?: string;
}

export type JudgePhase = "aligning" | "driving" | "delivering" | "aborted" | "done";

export interface JudgeState {
	phase: JudgePhase;
	spec: RequirementsSpec | null;
	summary: string;
	steerCount: number;
	maxSteer: number;
	keepWatching: boolean;
}

export function createJudgeState(): JudgeState {
	return {
		phase: "aborted",
		spec: null,
		summary: "",
		steerCount: 0,
		maxSteer: 5,
		keepWatching: false,
	};
}

export function enterAligning(state: JudgeState): JudgeState {
	return {
		...state,
		phase: "aligning",
		steerCount: 0,
		keepWatching: true,
	};
}

export function setRequirementsSpec(state: JudgeState, spec: RequirementsSpec): JudgeState {
	return {
		...state,
		spec,
	};
}

export function startDriving(state: JudgeState): JudgeState {
	return {
		...state,
		phase: "driving",
		keepWatching: true,
	};
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
	};
}

export function completeJudge(state: JudgeState): JudgeState {
	return {
		...state,
		phase: "done",
		keepWatching: false,
	};
}
