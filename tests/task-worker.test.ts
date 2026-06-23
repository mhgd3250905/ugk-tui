import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildTaskWorkerPrompt, dispatchWorker, setTaskWorkerRunnerForTests } from "../extensions/task/task-worker.ts";

test("buildTaskWorkerPrompt injects skill contract runtime input outputDir and feedback", () => {
	const prompt = buildTaskWorkerPrompt({
		skill: "# Skill",
		contract: { artifacts: [{ name: "report.json" }] },
		runtimeInput: { source: "a" },
		outputDir: "E:/out",
		feedback: [{ assertion: "文件存在", actual: "missing" }],
	});

	assert.match(prompt, /所有产出必须落到: E:\/out/);
	assert.match(prompt, /# Skill/);
	assert.match(prompt, /report\.json/);
	assert.match(prompt, /"source": "a"/);
	assert.match(prompt, /上一轮失败反馈/);
	assert.doesNotMatch(prompt, /verify\.mjs/);
});

test("dispatchWorker maps subagent result to task worker result", async () => {
	let receivedTask = "";
	setTaskWorkerRunnerForTests(async (_defaultCwd, _agents, agentName, task) => {
		receivedTask = task;
		return {
			agent: agentName,
			agentSource: "user",
			task,
			exitCode: 0,
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: "生成了 report.json" }],
				usage: { input: 10, output: 5, cost: { total: 0.01 }, totalTokens: 15 },
			}],
			stderr: "",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 15, turns: 1 },
		} as any;
	});
	try {
		const result = await dispatchWorker({
			skill: "# Skill",
			contract: { artifacts: [] },
			runtimeInput: {},
			outputDir: "E:/out",
		}, { cwd: process.cwd() });

		assert.equal(result.ok, true);
		assert.equal(result.outputDir, "E:/out");
		assert.equal(result.summary, "生成了 report.json");
		assert.deepEqual(result.usage, { input: 10, output: 5, cost: 0.01 });
		assert.match(receivedTask, /# Skill/);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
	}
});

test("dispatchWorker reports failed worker result", async () => {
	setTaskWorkerRunnerForTests(async () => ({
		agent: "worker",
		agentSource: "unknown",
		task: "task",
		exitCode: 1,
		messages: [],
		stderr: "Unknown agent",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	}) as any);
	try {
		const result = await dispatchWorker({
			skill: "# Skill",
			contract: {},
			runtimeInput: {},
			outputDir: "E:/out",
		}, { cwd: process.cwd() });

		assert.equal(result.ok, false);
		assert.match(result.errorMessage ?? "", /Unknown agent/);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
	}
});

test("dispatchWorker passes extra env to the child agent", async () => {
	let receivedEnv: Record<string, string | undefined> | undefined;
	setTaskWorkerRunnerForTests(async (...args: any[]) => {
		receivedEnv = args[9];
		return {
			agent: "worker",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		} as any;
	});
	try {
		await dispatchWorker({
			skill: "# Skill",
			contract: {},
			runtimeInput: {},
			outputDir: "E:/out",
		}, { cwd: process.cwd(), env: { UGK_TASK_ALLOW_CHROME_CDP: "1" } });

		assert.equal(receivedEnv?.UGK_TASK_ALLOW_CHROME_CDP, "1");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
	}
});

test("worker agent inherits all tools and forbids subagent in prompt", () => {
	const source = readFileSync(path.resolve("agents/worker.md"), "utf8");

	// 不写 tools 字段 = 继承全部默认工具(含 chrome_cdp / mcp)
	assert.doesNotMatch(source, /^tools:/m);
	// 但必须在 prompt 里禁止 subagent
	assert.match(source, /不得调用 subagent|禁止派 subagent|禁止.*subagent/);
	// 复制提示仍在
	assert.match(source, /~\/\.pi\/agent\/agents\/worker\.md/);
});
