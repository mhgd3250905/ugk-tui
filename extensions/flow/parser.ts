import type { FlowRequest } from "./types.ts";

const FLOW_TASK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidFlowTaskId(taskId: string): boolean {
	return FLOW_TASK_ID_PATTERN.test(taskId);
}

export function invalidFlowTaskIdMessage(taskId: string): string {
	return `Invalid task id: ${taskId}. Use lowercase letters/numbers with internal dashes only.`;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function splitInlineInput(rest: string): { taskId: string; input?: string } | null {
	const match = rest.trim().match(/^(\S+)(?:\s+--input\s+([\s\S]+))?$/);
	if (!match) return null;
	const input = match[2] ? unquote(match[2]) : undefined;
	return { taskId: match[1], input };
}

export function parseFlowCommand(args: string): FlowRequest {
	const text = args.trim();
	if (!text) return { kind: "help" };

	if (text === "status") return { kind: "status" };
	if (text === "detach") return { kind: "detach" };
	if (text === "driver status") return { kind: "driver-status" };

	const attachPrefix = "attach";
	if (text === attachPrefix) return { kind: "attach", runId: undefined };
	if (text.startsWith(`${attachPrefix} `)) {
		const runId = text.slice(attachPrefix.length).trim();
		if (!runId) return { kind: "attach", runId: undefined };
		return { kind: "attach", runId };
	}

	const createPrefix = "task create";
	if (text === createPrefix) {
		return { kind: "error", message: 'Usage: /flow task create "自然语言目标"' };
	}
	if (text.startsWith(`${createPrefix} `)) {
		const goal = unquote(text.slice(createPrefix.length));
		if (!goal) return { kind: "error", message: 'Usage: /flow task create "自然语言目标"' };
		return { kind: "task-create", goal };
	}

	const provePrefix = "task prove";
	if (text === provePrefix) {
		return { kind: "error", message: "Usage: /flow task prove <task-id> [--input <inline-input>]" };
	}
	if (text.startsWith(`${provePrefix} `)) {
		const parsed = splitInlineInput(text.slice(provePrefix.length));
		if (!parsed) return { kind: "error", message: "Usage: /flow task prove <task-id> [--input <inline-input>]" };
		if (!isValidFlowTaskId(parsed.taskId)) return { kind: "error", message: invalidFlowTaskIdMessage(parsed.taskId) };
		return { kind: "task-prove", ...parsed };
	}

	const runPrefix = "run";
	if (text === runPrefix) return { kind: "error", message: "Usage: /flow run <task-id> [--input <inline-input>]" };
	if (text.startsWith(`${runPrefix} `)) {
		const parsed = splitInlineInput(text.slice(runPrefix.length));
		if (!parsed) return { kind: "error", message: "Usage: /flow run <task-id> [--input <inline-input>]" };
		if (!isValidFlowTaskId(parsed.taskId)) return { kind: "error", message: invalidFlowTaskIdMessage(parsed.taskId) };
		return { kind: "task-run", ...parsed };
	}

	const startPrefix = "task start";
	if (text === startPrefix) return { kind: "error", message: "Usage: /flow task start <task-id> [--input <inline-input>]" };
	if (text.startsWith(`${startPrefix} `)) {
		const parsed = splitInlineInput(text.slice(startPrefix.length));
		if (!parsed) return { kind: "error", message: "Usage: /flow task start <task-id> [--input <inline-input>]" };
		if (!isValidFlowTaskId(parsed.taskId)) return { kind: "error", message: invalidFlowTaskIdMessage(parsed.taskId) };
		return { kind: "task-run", ...parsed };
	}

	const reviewPrefix = "task review";
	if (text === reviewPrefix) return { kind: "error", message: "Usage: /flow task review <run-id>" };
	if (text.startsWith(`${reviewPrefix} `)) {
		const runId = text.slice(reviewPrefix.length).trim();
		if (!runId) return { kind: "error", message: "Usage: /flow task review <run-id>" };
		return { kind: "task-review", runId };
	}

	const acceptPrefix = "task accept";
	if (text === acceptPrefix) return { kind: "error", message: "Usage: /flow task accept <run-id>" };
	if (text.startsWith(`${acceptPrefix} `)) {
		const runId = text.slice(acceptPrefix.length).trim();
		if (!runId) return { kind: "error", message: "Usage: /flow task accept <run-id>" };
		return { kind: "task-accept", runId };
	}

	const rejectPrefix = "task reject";
	if (text === rejectPrefix) return { kind: "error", message: "Usage: /flow task reject <run-id> [reason]" };
	if (text.startsWith(`${rejectPrefix} `)) {
		const rest = text.slice(rejectPrefix.length).trim();
		const match = rest.match(/^(\S+)(?:\s+([\s\S]+))?$/);
		if (!match) return { kind: "error", message: "Usage: /flow task reject <run-id> [reason]" };
		return { kind: "task-reject", runId: match[1], reason: match[2] ? unquote(match[2]) : undefined };
	}

	const deletePrefix = "task delete";
	if (text === deletePrefix) return { kind: "error", message: "Usage: /flow task delete <task-id>" };
	if (text.startsWith(`${deletePrefix} `)) {
		const taskId = text.slice(deletePrefix.length).trim();
		if (!taskId) return { kind: "error", message: "Usage: /flow task delete <task-id>" };
		if (!isValidFlowTaskId(taskId)) return { kind: "error", message: invalidFlowTaskIdMessage(taskId) };
		return { kind: "task-delete", taskId };
	}

	if (text === "reset-signing") return { kind: "reset-signing" };

	return { kind: "help" };
}
