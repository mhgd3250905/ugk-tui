import test from "node:test";
import assert from "node:assert/strict";
import {
	completeExecution,
	createPlanModeState,
	restorePlanModeState,
	startExecution,
	togglePlanMode,
} from "../extensions/plan-mode-state.ts";

const todoItems = [{ step: 1, text: "Read files", completed: false }];

test("togglePlanMode flips planning on and resets execution state", () => {
	const initial = { planModeEnabled: false, executionMode: true, todoItems };
	assert.deepEqual(togglePlanMode(initial), {
		planModeEnabled: true,
		executionMode: false,
		todoItems: [],
	});
});

test("startExecution exits planning and keeps extracted todos", () => {
	assert.deepEqual(startExecution({ planModeEnabled: true, executionMode: false, todoItems }), {
		planModeEnabled: false,
		executionMode: true,
		todoItems,
	});
});

test("completeExecution clears plan-mode progress", () => {
	assert.deepEqual(completeExecution({ planModeEnabled: false, executionMode: true, todoItems }), createPlanModeState());
});

test("restorePlanModeState applies persisted state over defaults", () => {
	assert.deepEqual(
		restorePlanModeState(createPlanModeState(), {
			enabled: true,
			executing: true,
			todos: todoItems,
		}),
		{ planModeEnabled: true, executionMode: true, todoItems },
	);
});
