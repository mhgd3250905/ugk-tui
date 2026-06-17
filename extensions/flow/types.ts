export type FlowRequest =
	| { kind: "task-create"; goal: string }
	| { kind: "task-prove"; taskId: string; input?: string }
	| { kind: "task-run"; taskId: string; input?: string }
	| { kind: "task-review"; runId: string }
	| { kind: "status" }
	| { kind: "help" }
	| { kind: "error"; message: string };

export type FlowActionKind = FlowRequest["kind"];
