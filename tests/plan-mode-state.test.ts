import test from "node:test";
import assert from "node:assert/strict";
import {
	completeExecution,
	createPlanModeState,
	restorePlanModeState,
	startExecution,
	togglePlanMode,
} from "../extensions/plan-mode-state.ts";

test("togglePlanMode flips planning on and resets execution state", () => {
	const initial = { planModeEnabled: false, executionMode: true, savedTools: undefined };
	assert.deepEqual(togglePlanMode(initial), {
		planModeEnabled: true,
		executionMode: false,
		savedTools: undefined,
	});
});

test("startExecution exits planning and tracks only when todos exist", () => {
	assert.deepEqual(
		startExecution({ planModeEnabled: true, executionMode: false, savedTools: undefined }, true),
		{
			planModeEnabled: false,
			executionMode: true,
			savedTools: undefined,
		},
	);
	assert.equal(startExecution({ planModeEnabled: true, executionMode: false, savedTools: undefined }, false).executionMode, false);
});

test("completeExecution clears plan-mode progress", () => {
	assert.deepEqual(
		completeExecution({ planModeEnabled: false, executionMode: true, savedTools: undefined }),
		createPlanModeState(),
	);
});

// S1 fix: completeExecution must preserve savedTools so the caller can still restore MCP/dynamic tools.
test("completeExecution preserves savedTools for later restore", () => {
	const savedTools = ["read", "bash", "mcp__fs__read_file"];
	const result = completeExecution({ planModeEnabled: false, executionMode: true, savedTools });
	assert.equal(result.savedTools, savedTools);
	assert.equal(result.executionMode, false);
});

test("restorePlanModeState applies persisted state over defaults", () => {
	assert.deepEqual(
		restorePlanModeState(createPlanModeState(), {
			enabled: true,
			executing: true,
		}),
		{ planModeEnabled: true, executionMode: true, savedTools: undefined },
	);
});

// S1 fix: savedTools snapshot must survive state transitions so dynamic tools (MCP) are restored.
test("togglePlanMode preserves savedTools across toggle", () => {
	const savedTools = ["read", "bash", "edit", "write", "mcp__github__search"];
	const initial = { planModeEnabled: false, executionMode: false, savedTools };
	assert.deepEqual(togglePlanMode(initial), {
		planModeEnabled: true,
		executionMode: false,
		savedTools,
	});
});

test("startExecution preserves savedTools so it can be restored after execution", () => {
	const savedTools = ["read", "bash", "mcp__fs__read_file"];
	const result = startExecution({ planModeEnabled: true, executionMode: false, savedTools }, true);
	assert.equal(result.savedTools, savedTools);
});

test("createPlanModeState initializes savedTools as undefined", () => {
	assert.equal(createPlanModeState().savedTools, undefined);
});
