import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import registerTaskGateway, { TASK_GATEWAY_TOOLS } from "../extensions/task/task-gateway.ts";
import { buildTaskbookPrompt } from "../extensions/task/task-registry.ts";
import { saveTaskbook } from "../extensions/task/task-book.ts";

function makePi() {
	const tools: any[] = [];
	const handlers = new Map<string, Function[]>();
	let activeTools = ["read", "bash", "edit"];
	return {
		tools,
		handlers,
		get activeTools() { return activeTools; },
		pi: {
			registerTool(tool: any) { tools.push(tool); },
			setActiveTools(names: string[]) { activeTools = [...names]; },
			on(event: string, handler: Function) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		},
	};
}

const spec = { goal: "test", hardConstraints: ["only output"], acceptance: ["verify pass"], forbidden: [], context: "" };

test("task gateway stays inert unless explicitly enabled", () => {
	const state = makePi();
	registerTaskGateway(state.pi as any, {});

	assert.deepEqual(state.tools, []);
	assert.equal(state.handlers.size, 0);
});

test("task gateway exposes only task tools and a structured no_match result", async () => {
	const state = makePi();
	registerTaskGateway(state.pi as any, { UGK_TASK_GATEWAY: "1" });

	await state.handlers.get("session_start")![0]();
	assert.deepEqual(state.activeTools, TASK_GATEWAY_TOOLS);

	const tool = state.tools.find((item) => item.name === "task_gateway_result");
	const result = await tool.execute("call-1", {
		status: "no_match",
		reason: "没有适合的 task",
		consideredTasks: ["x-search"],
	});

	assert.equal(result.terminate, true);
	assert.deepEqual(result.details, {
		status: "no_match",
		reason: "没有适合的 task",
		consideredTasks: ["x-search"],
	});
});

test("task gateway appends hard routing rules and blocks a second run_task call", async () => {
	const state = makePi();
	registerTaskGateway(state.pi as any, { UGK_TASK_GATEWAY: "1" });
	await state.handlers.get("session_start")![0]();

	const injected = await state.handlers.get("before_agent_start")![0]({ systemPrompt: "base" });
	assert.match(injected.systemPrompt, /^base/);
	assert.match(injected.systemPrompt, /只能使用已有 task/);
	assert.match(injected.systemPrompt, /不能使用普通工具/);
	assert.match(injected.systemPrompt, /一次 run_task/);

	const guard = state.handlers.get("tool_call")![0];
	assert.equal(await guard({ toolName: "run_task" }), undefined);
	assert.deepEqual(await guard({ toolName: "run_task" }), {
		block: true,
		reason: "gateway 每次请求只允许一次 run_task 调用。",
	});
});

test("task prompt treats a legacy dedicated tag like any other tag", async () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "ugk-task-gateway-"));
	const agentDir = mkdtempSync(path.join(os.tmpdir(), "ugk-task-gateway-agent-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await saveTaskbook("project", cwd, "hidden-search", {
			description: "search hidden sources",
			spec,
			skill: "# Skill",
			verify: "process.exit(0);\n",
			contract: { runtimeInput: ["query"], artifacts: [] },
			tags: ["dedicated"],
		});

		const prompt = await buildTaskbookPrompt(cwd);

		assert.match(prompt, /hidden-search/);
		assert.match(prompt, /search hidden sources/);
		assert.doesNotMatch(prompt, /专用 task 清单见文件/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});
