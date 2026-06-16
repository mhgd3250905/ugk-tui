import type { TodoItem } from "./plan-mode-utils.ts";

export interface PlanModeState {
	planModeEnabled: boolean;
	executionMode: boolean;
	todoItems: TodoItem[];
}

export interface PersistedPlanModeState {
	enabled?: boolean;
	todos?: TodoItem[];
	executing?: boolean;
}

export function createPlanModeState(): PlanModeState {
	return {
		planModeEnabled: false,
		executionMode: false,
		todoItems: [],
	};
}

export function togglePlanMode(state: PlanModeState): PlanModeState {
	return {
		planModeEnabled: !state.planModeEnabled,
		executionMode: false,
		todoItems: [],
	};
}

export function startExecution(state: PlanModeState): PlanModeState {
	return {
		planModeEnabled: false,
		executionMode: state.todoItems.length > 0,
		todoItems: state.todoItems,
	};
}

export function completeExecution(_state: PlanModeState): PlanModeState {
	return createPlanModeState();
}

export function restorePlanModeState(state: PlanModeState, persisted?: PersistedPlanModeState): PlanModeState {
	if (!persisted) return state;
	return {
		planModeEnabled: persisted.enabled ?? state.planModeEnabled,
		todoItems: persisted.todos ?? state.todoItems,
		executionMode: persisted.executing ?? state.executionMode,
	};
}
