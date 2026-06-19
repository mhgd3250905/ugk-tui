export type FlowDriverStatus =
	| "starting"
	| "running"
	| "waiting"
	| "waiting-for-user"
	| "needs-human"
	| "validating"
	| "done"
	| "failed"
	| "paused";

export interface FlowDriverSummary {
	taskId: string;
	runId: string;
	status: FlowDriverStatus;
	step?: string;
	summary?: string;
	updatedAt?: string;
	runDir: string;
}

export type FlowFocusState = { focus: "main" } | { focus: "driver"; runId: string; taskId?: string };

export type FlowRequest =
	| { kind: "task-create"; goal: string }
	| { kind: "task-prove"; taskId: string; input?: string }
	| { kind: "task-run"; taskId: string; input?: string }
	| { kind: "task-review"; runId: string }
	| { kind: "task-accept"; runId: string }
	| { kind: "task-reject"; runId: string; reason?: string }
	| { kind: "task-delete"; taskId: string }
	| { kind: "reset-signing" }
	| { kind: "repair-signing"; taskId: string }
	| { kind: "attach"; runId?: string }
	| { kind: "detach" }
	| { kind: "driver-status" }
	| { kind: "status" }
	| { kind: "help" }
	| { kind: "error"; message: string };

export type FlowActionKind = FlowRequest["kind"];
