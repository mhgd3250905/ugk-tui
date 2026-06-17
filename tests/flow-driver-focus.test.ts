import test from "node:test";
import assert from "node:assert/strict";
import {
	attachFlowDriver,
	detachFlowDriver,
	FLOW_FOCUS_ENTRY_TYPE,
	restoreFlowFocus,
} from "../extensions/flow/driver-focus.ts";
import type { FlowFocusState } from "../extensions/flow/types.ts";

test("attachFlowDriver and detachFlowDriver update focus state", () => {
	const initial: FlowFocusState = { focus: "main" };

	assert.deepEqual(attachFlowDriver(initial, { taskId: "task-a", runId: "run-001" }), {
		focus: "driver",
		taskId: "task-a",
		runId: "run-001",
	});
	assert.deepEqual(detachFlowDriver({ focus: "driver", taskId: "task-a", runId: "run-001" }), {
		focus: "main",
	});
});

test("restoreFlowFocus reads the latest persisted custom entry", () => {
	const entries = [
		{ type: "custom", customType: FLOW_FOCUS_ENTRY_TYPE, data: { focus: "driver", taskId: "old", runId: "run-000" } },
		{ type: "custom", customType: FLOW_FOCUS_ENTRY_TYPE, data: { focus: "main" } },
		{ type: "custom", customType: FLOW_FOCUS_ENTRY_TYPE, data: { focus: "driver", taskId: "x", runId: "run-001" } },
	] as any[];

	assert.deepEqual(restoreFlowFocus(entries), { focus: "driver", taskId: "x", runId: "run-001" });
});

test("restoreFlowFocus skips invalid focus data and falls back to main", () => {
	const entries = [
		{ type: "custom", customType: FLOW_FOCUS_ENTRY_TYPE, data: { focus: "driver", taskId: "x" } },
		{ type: "custom", customType: FLOW_FOCUS_ENTRY_TYPE, data: { focus: "main", runId: "unexpected" } },
		{ type: "custom", customType: "other", data: { focus: "driver", runId: "run-001" } },
	] as any[];

	assert.deepEqual(restoreFlowFocus(entries), { focus: "main" });
});

test("restoreFlowFocus treats the latest flow-focus entry as authoritative when invalid", () => {
	const entries = [
		{ type: "custom", customType: FLOW_FOCUS_ENTRY_TYPE, data: { focus: "driver", taskId: "old", runId: "run-000" } },
		{ type: "custom", customType: FLOW_FOCUS_ENTRY_TYPE, data: { focus: "driver", taskId: "x" } },
	] as any[];

	assert.deepEqual(restoreFlowFocus(entries), { focus: "main" });
});
