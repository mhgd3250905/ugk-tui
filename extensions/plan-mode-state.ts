export interface PlanModeState {
	planModeEnabled: boolean;
	executionMode: boolean;
	/**
	 * Snapshot of active tool names captured when entering plan mode.
	 * Restored on exit so dynamically registered tools (e.g. MCP tools)
	 * are not lost. Undefined before first entry or after restore.
	 */
	savedTools: string[] | undefined;
}

export interface PersistedPlanModeState {
	enabled?: boolean;
	executing?: boolean;
}

export function createPlanModeState(): PlanModeState {
	return {
		planModeEnabled: false,
		executionMode: false,
		savedTools: undefined,
	};
}

export function togglePlanMode(state: PlanModeState): PlanModeState {
	return {
		planModeEnabled: !state.planModeEnabled,
		executionMode: false,
		savedTools: state.savedTools,
	};
}

export function startExecution(state: PlanModeState, hasTodos: boolean): PlanModeState {
	return {
		planModeEnabled: false,
		executionMode: hasTodos,
		savedTools: state.savedTools,
	};
}

export function completeExecution(state: PlanModeState): PlanModeState {
	// Keep savedTools so the caller can restore the pre-plan tool set (incl. MCP/dynamic).
	// Without this, the S1 fix is incomplete: completing an execution would fall back to
	// NORMAL_MODE_TOOLS and lose dynamically registered tools.
	return {
		planModeEnabled: false,
		executionMode: false,
		savedTools: state.savedTools,
	};
}

export function restorePlanModeState(state: PlanModeState, persisted?: PersistedPlanModeState): PlanModeState {
	if (!persisted) return state;
	return {
		planModeEnabled: persisted.enabled ?? state.planModeEnabled,
		executionMode: persisted.executing ?? state.executionMode,
		// savedTools is runtime-only (not persisted); keep whatever the live state held.
		savedTools: state.savedTools,
	};
}
