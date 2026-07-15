import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TASK_GATEWAY_TOOLS = ["run_task", "questionnaire", "task_gateway_result"];

const TASK_GATEWAY_PROMPT = `## UGK task gateway
你只能使用已有 task 完成请求，不能使用普通工具直接完成任务，也不能创建或修改 task。
匹配时调用一次 run_task；没有匹配项时调用 task_gateway_result 返回 no_match；信息不足时可用 questionnaire。`;

export default function registerTaskGateway(
	pi: ExtensionAPI,
	env: Record<string, string | undefined> = process.env,
): void {
	if (env.UGK_TASK_GATEWAY !== "1") return;

	let runTaskCalled = false;
	pi.registerTool({
		name: "task_gateway_result",
		label: "Task Gateway Result",
		description: "Return a structured result when no existing task matches the request.",
		parameters: Type.Object({
			status: Type.Literal("no_match"),
			reason: Type.String(),
			consideredTasks: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_toolCallId, params) {
			const details = {
				status: "no_match" as const,
				reason: params.reason,
				...(params.consideredTasks ? { consideredTasks: params.consideredTasks } : {}),
			};
			return {
				content: [{ type: "text" as const, text: `no_match: ${params.reason}` }],
				details,
				terminate: true,
			};
		},
	});

	pi.on("session_start", async () => {
		runTaskCalled = false;
		pi.setActiveTools?.([...TASK_GATEWAY_TOOLS]);
	});
	pi.on("before_agent_start", async (event: any) => ({
		systemPrompt: `${typeof event?.systemPrompt === "string" ? event.systemPrompt : ""}\n\n${TASK_GATEWAY_PROMPT}`,
	}));
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "run_task") return;
		if (runTaskCalled) return { block: true, reason: "gateway 每次请求只允许一次 run_task 调用。" };
		runTaskCalled = true;
	});
}
