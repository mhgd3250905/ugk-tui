export interface FlowConsoleTask {
	id: string;
	status?: string;
}

export interface FlowConsoleDriver {
	taskId: string;
	runId: string;
	status: string;
	step?: string;
	reviewStatus?: string;
}

export interface FlowConsoleOption {
	label: string;
	command?: string;
}

// 单一真相在 task-store.ts;import 用于本模块,re-export 维持现有外部导入路径。
import { isRunnableFlowTaskStatus } from "./task-store.ts";
export { isRunnableFlowTaskStatus };

export type FlowStageGate =
	| { phase: "create"; taskId: string }
	| { phase: "prove-pass"; taskId: string; runId: string }
	| { phase: "run-pass"; taskId: string; runId: string }
	| { phase: "review-accepted"; taskId: string; runId: string };

export function buildFlowConsoleOptions(state: {
	tasks: FlowConsoleTask[];
}): FlowConsoleOption[] {
	const options: FlowConsoleOption[] = [{ label: "Create task", command: "task create" }];
	if (state.tasks.length > 0) {
		options.push({ label: "Tasks", command: "tasks" });
	}
	options.push(
		{ label: "Attach driver", command: "attach" },
		{ label: "Show status", command: "status" },
		{ label: "Exit" },
	);
	return options;
}

export function buildFlowTaskListOptions(tasks: FlowConsoleTask[]): FlowConsoleOption[] {
	return [
		...tasks.map((task) => ({
			label: `${task.id} [${task.status ?? "unknown"}]`,
			command: `task select ${task.id}`,
		})),
		{ label: "Back" },
	];
}

export function buildFlowTaskActionOptions(state: {
	task: FlowConsoleTask;
	drivers: FlowConsoleDriver[];
}): FlowConsoleOption[] {
	const options: FlowConsoleOption[] = [];
	if (state.task.status === "draft" || state.task.status === "needs-human") {
		options.push({ label: `Prove ${state.task.id}`, command: `task prove ${state.task.id}` });
	}
	if (isRunnableFlowTaskStatus(state.task.status)) {
		options.push({ label: `Run ${state.task.id}`, command: `run ${state.task.id}` });
	}
	for (const driver of state.drivers) {
		if (driver.taskId === state.task.id && driver.status === "done" && driver.reviewStatus !== "accepted") {
			options.push({ label: `Review ${driver.taskId}/${driver.runId}`, command: `task review ${driver.taskId}/${driver.runId}` });
		}
	}
	options.push(
		{ label: `Delete ${state.task.id}`, command: `task delete ${state.task.id}` },
		{ label: "Back" },
	);
	return options;
}

export function parseFlowConsoleSelection(selection: string | undefined): FlowConsoleOption | undefined {
	if (!selection || selection === "Exit" || selection === "Back") return undefined;
	if (selection === "Show status") return { label: selection, command: "status" };
	if (selection === "Attach driver") return { label: selection, command: "attach" };
	if (selection === "Create task") return { label: selection, command: "task create" };
	if (selection === "Tasks") return { label: selection, command: "tasks" };
	const prove = selection.match(/^Prove (.+)$/);
	if (prove) return { label: selection, command: `task prove ${prove[1]}` };
	const run = selection.match(/^Run (.+)$/);
	if (run) return { label: selection, command: `run ${run[1]}` };
	const review = selection.match(/^Review (.+)$/);
	if (review) return { label: selection, command: `task review ${review[1]}` };
	const deleted = selection.match(/^Delete (.+)$/);
	if (deleted) return { label: selection, command: `task delete ${deleted[1]}` };
	return undefined;
}

export function buildFlowStageGateOptions(gate: FlowStageGate): FlowConsoleOption[] {
	if (gate.phase === "create") {
		return [
			{ label: `Continue: prove ${gate.taskId}`, command: `task prove ${gate.taskId}` },
			{ label: "Stop here" },
		];
	}
	if (gate.phase === "prove-pass" || gate.phase === "run-pass") {
		return [
			{ label: `Continue: review ${gate.taskId}/${gate.runId}`, command: `task review ${gate.taskId}/${gate.runId}` },
			{ label: "Stop here" },
		];
	}
	return [
		{ label: `Continue: run ${gate.taskId}`, command: `run ${gate.taskId}` },
		{ label: "Stop here" },
	];
}

export function parseFlowStageGateSelection(
	selection: string | undefined,
	gate: FlowStageGate,
): FlowConsoleOption | undefined {
	return buildFlowStageGateOptions(gate).find((option) => option.label === selection && option.command);
}
