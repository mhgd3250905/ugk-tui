import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { diagnoseUgk } from "./doctor.js";
import { createRpcJobManager } from "./rpc-job.js";

const ACTIONS = ["start", "status", "respond", "cancel"];
const CHAIN_GUIDANCE = "task 链由宿主编排：互不依赖的 task 作为一个并行批次交给一次 start；依赖阶段等待 pass 后携带真实 artifact 路径发起多次 start。不要把整条 task 链放进一次 start。";
const UGK_TOOL = {
	name: "ugk",
	description: `运行 UGK 中已有 task，并执行机器验收。必须传当前项目的绝对 cwd；start 后用 status 查询结果。没有匹配 task 时返回 no_match，不会退化成通用 Agent。${CHAIN_GUIDANCE}`,
	inputSchema: {
		type: "object",
		properties: {
			action: { type: "string", enum: ACTIONS },
			cwd: { type: "string", description: "当前项目的绝对路径；环境检查和 start 时必填。" },
			request: { type: "string", description: "自包含的自然语言任务；start 时必填。" },
			runId: { type: "string", description: "start 返回的运行 ID。" },
			interactionId: { type: "string", description: "待回答 interaction 的 ID。" },
			value: { type: "string" },
			confirmed: { type: "boolean" },
			cancelled: { type: "boolean" },
		},
		required: ["action"],
	},
};

function normalResult(value) {
	return {
		content: [{ type: "text", text: JSON.stringify(value) }],
		structuredContent: value,
	};
}

function errorResult(message) {
	return { isError: true, content: [{ type: "text", text: message }] };
}

function requiredString(args, name) {
	return typeof args[name] === "string" && args[name].trim() ? args[name] : undefined;
}

export function createUgkMcpServer(options = {}) {
	const jobManager = options.jobManager ?? createRpcJobManager(options);
	const doctor = options.doctor ?? diagnoseUgk;
	const server = new Server(
		{ name: "ugk-task-gateway", version: "1.0.0" },
		{
			capabilities: { tools: {} },
			instructions: `UGK 只运行本机已有的已验收 task。调用 start 时传当前项目绝对 cwd 和自包含 request；随后用 status 查询。遇到 needs_input/needs_approval 时展示给用户并用 respond 回传。no_match 是正常业务结果。${CHAIN_GUIDANCE}`,
		},
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [UGK_TOOL] }));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		if (request.params.name !== "ugk") return errorResult(`未知工具: ${request.params.name}`);
		const args = request.params.arguments ?? {};
		if (!ACTIONS.includes(args.action)) return errorResult("action 必须是 start、status、respond 或 cancel。");

		if (args.action === "start") {
			const cwd = requiredString(args, "cwd");
			const taskRequest = requiredString(args, "request");
			if (!cwd || !path.isAbsolute(cwd) || !taskRequest) return errorResult("start 必须提供绝对 cwd 和非空 request。");
			return normalResult(await jobManager.start({ cwd, request: taskRequest }));
		}
		if (args.action === "status") {
			const id = requiredString(args, "runId");
			if (id) return normalResult(await jobManager.status(id));
			const cwd = requiredString(args, "cwd");
			if (!cwd || !path.isAbsolute(cwd)) return errorResult("不带 runId 的 status 必须提供绝对 cwd。");
			return normalResult(await doctor({ cwd }));
		}
		if (args.action === "respond") {
			const id = requiredString(args, "runId");
			const interactionId = requiredString(args, "interactionId");
			if (!id || !interactionId) return errorResult("respond 必须提供 runId 和 interactionId。");
			return normalResult(await jobManager.respond({
				runId: id,
				interactionId,
				value: args.value,
				confirmed: args.confirmed,
				cancelled: args.cancelled,
			}));
		}

		const id = requiredString(args, "runId");
		if (!id) return errorResult("cancel 必须提供 runId。");
		return normalResult(await jobManager.cancel(id));
	});
	server.onclose = () => jobManager.dispose();
	return server;
}

export async function serveUgkMcp(options = {}) {
	const server = createUgkMcpServer(options);
	await server.connect(options.transport ?? new StdioServerTransport());
	return server;
}
