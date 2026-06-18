import type { FlowRequest } from "./types.ts";

function inputSuffix(input: string | undefined): string {
	return input?.trim() ? `\n输入: ${input}` : "";
}

export function formatFlowQueued(request: FlowRequest): string {
	switch (request.kind) {
		case "task-create":
			return `Flow 已排队: 创建 Task 草案\n目标: ${request.goal}`;
		case "task-prove":
			return `Flow 已排队: 证明 Task ${request.taskId}${inputSuffix(request.input)}`;
		case "task-run":
			return `Flow 已排队: 运行 Task ${request.taskId}${inputSuffix(request.input)}`;
		case "task-review":
			return `Flow 已排队: 复盘 Run ${request.runId}`;
		case "task-accept":
			return `Flow review accepted: ${request.runId}`;
		case "task-reject":
			return `Flow review rejected: ${request.runId}`;
		case "status":
			return "Flow 已排队: 查看状态";
		case "attach":
			return request.runId ? `Flow driver attach requested: ${request.runId}` : "Flow driver picker opened.";
		case "detach":
			return "Flow driver detached.";
		case "driver-status":
			return "Flow driver status requested.";
		case "help":
			return "Flow 帮助已显示。";
		case "error":
			return request.message;
		default: {
			const exhaustive: never = request;
			return exhaustive;
		}
	}
}
