export interface FlowConsoleTask {
	id: string;
	status?: string;
}

export interface FlowConsoleDriver {
	taskId: string;
	runId: string;
	status: string;
	step?: string;
}

export interface FlowConsoleOption {
	label: string;
	command?: string;
}

export type FlowStageGate =
	| { phase: "create"; taskId: string }
	| { phase: "prove-pass"; taskId: string; runId: string }
	| { phase: "run-pass"; taskId: string; runId: string }
	| { phase: "review-accepted"; taskId: string; runId: string };

export function buildFlowConsoleOptions(state: {
	tasks: FlowConsoleTask[];
	drivers: FlowConsoleDriver[];
}): FlowConsoleOption[] {
	const options: FlowConsoleOption[] = [{ label: "Create task", command: "task create" }];
	for (const task of state.tasks) {
		if (task.status === "draft" || task.status === "needs-human") {
			options.push({ label: `Prove ${task.id}`, command: `task prove ${task.id}` });
		}
		if (task.status === "verified" || task.status === "active") {
			options.push({ label: `Run ${task.id}`, command: `run ${task.id}` });
		}
	}
	for (const driver of state.drivers) {
		if (driver.status === "done") {
			options.push({ label: `Review ${driver.taskId}/${driver.runId}`, command: `task review ${driver.taskId}/${driver.runId}` });
		}
	}
	options.push(
		{ label: "Attach driver", command: "attach" },
		{ label: "Show status", command: "status" },
		{ label: "Exit" },
	);
	return options;
}

export function parseFlowConsoleSelection(selection: string | undefined): FlowConsoleOption | undefined {
	if (!selection || selection === "Exit") return undefined;
	if (selection === "Show status") return { label: selection, command: "status" };
	if (selection === "Attach driver") return { label: selection, command: "attach" };
	if (selection === "Create task") return { label: selection, command: "task create" };
	const prove = selection.match(/^Prove (.+)$/);
	if (prove) return { label: selection, command: `task prove ${prove[1]}` };
	const run = selection.match(/^Run (.+)$/);
	if (run) return { label: selection, command: `run ${run[1]}` };
	const review = selection.match(/^Review (.+)$/);
	if (review) return { label: selection, command: `task review ${review[1]}` };
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
