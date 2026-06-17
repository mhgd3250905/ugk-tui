import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { FlowDriverSummary, FlowFocusState } from "./types.ts";

export const FLOW_FOCUS_ENTRY_TYPE = "flow-focus";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFlowFocusState(data: unknown): FlowFocusState | undefined {
	if (!isRecord(data)) {
		return undefined;
	}

	if (data.focus === "main" && Object.keys(data).length === 1) {
		return { focus: "main" };
	}

	if (
		data.focus === "driver" &&
		typeof data.runId === "string" &&
		(data.taskId === undefined || typeof data.taskId === "string")
	) {
		return data.taskId === undefined
			? { focus: "driver", runId: data.runId }
			: { focus: "driver", runId: data.runId, taskId: data.taskId };
	}

	return undefined;
}

export function attachFlowDriver(
	_state: FlowFocusState,
	driver: Pick<FlowDriverSummary, "taskId" | "runId">,
): FlowFocusState {
	return { focus: "driver", taskId: driver.taskId, runId: driver.runId };
}

export function detachFlowDriver(_state: FlowFocusState): FlowFocusState {
	return { focus: "main" };
}

export function restoreFlowFocus(entries: SessionEntry[]): FlowFocusState {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as SessionEntry & { customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== FLOW_FOCUS_ENTRY_TYPE) {
			continue;
		}

		const state = toFlowFocusState(entry.data);
		if (state) {
			return state;
		}
	}

	return { focus: "main" };
}
