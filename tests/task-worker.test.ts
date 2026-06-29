import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeCdpTabLifecycle } from "../extensions/chrome-cdp/tab-session.ts";
import { setWorkerLifecycleFactory } from "../extensions/shared/worker-lifecycle.ts";
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

test("buildTaskWorkerPrompt 注入 TASK_DIR 提示当且仅当传入 taskDir", () => {
	// ponytail: 验证 scripts/ 自带脚本机制——已落盘 taskbook 的 run 注入 TASK_DIR 提示,创建自证阶段不注入
	const withDir = buildTaskWorkerPrompt({
		skill: "# Skill",
		contract: { artifacts: [] },
		runtimeInput: {},
		outputDir: "E:/out",
		feedback: [],
	}, "E:/tasks/foo");
	assert.match(withDir, /TASK_DIR=E:\/tasks\/foo/);
	assert.match(withDir, /scripts\//);

	const withoutDir = buildTaskWorkerPrompt({
		skill: "# Skill",
		contract: { artifacts: [] },
		runtimeInput: {},
		outputDir: "E:/out",
		feedback: [],
	});
	assert.doesNotMatch(withoutDir, /TASK_DIR/);
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

test("dispatchWorker injects a CDP tab lifecycle only when UGK_TASK_ALLOW_CHROME_CDP is set", async () => {
	let receivedLifecycle: unknown = undefined;
	setTaskWorkerRunnerForTests(async (...args: any[]) => {
		receivedLifecycle = args[10]; // lifecycle is the 11th positional arg (index 10)
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
	// ponytail: 模拟组合根接线 —— registerChromeCdp 把工厂注册到 shared 层。task-worker peek 出来用。
	setWorkerLifecycleFactory((port) => makeCdpTabLifecycle(port));

	try {
		// 有 CDP env → 传 lifecycle(非 undefined)
		receivedLifecycle = undefined;
		await dispatchWorker({
			skill: "# Skill",
			contract: {},
			runtimeInput: {},
			outputDir: "E:/out",
		}, { cwd: process.cwd(), env: { UGK_TASK_ALLOW_CHROME_CDP: "1" } });
		assert.notEqual(receivedLifecycle, undefined, "lifecycle should be injected when UGK_TASK_ALLOW_CHROME_CDP set");
		assert.equal(typeof (receivedLifecycle as any)?.beforeSpawn, "function");
		assert.equal(typeof (receivedLifecycle as any)?.afterClose, "function");

		// 无 CDP env → 不传 lifecycle(undefined)
		receivedLifecycle = "sentinel";
		await dispatchWorker({
			skill: "# Skill",
			contract: {},
			runtimeInput: {},
			outputDir: "E:/out",
		}, { cwd: process.cwd(), env: {} });
		assert.equal(receivedLifecycle, undefined, "lifecycle should be undefined when UGK_TASK_ALLOW_CHROME_CDP not set");
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setWorkerLifecycleFactory(undefined);
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

// ponytail: 进度自证 —— onUpdate 必须把 worker 的工具调用(ToolCall/toolResult)转成进度行。
// 这是"第一轮失败想看具体原因"的关键:旧实现只取 LLM 文本流,worker 调 chrome_cdp/bash 时全程静默。
test("dispatchWorker streams tool-call and tool-result as progress lines via onUpdate", async () => {
	const updates: string[] = [];
	// args[7] = onUpdate。模拟 subagent 的 emitUpdate 发来的 partial:
	// 第一次 onUpdate: assistant message 含一个 ToolCall(chrome_cdp navigate)
	// 第二次 onUpdate: toolResult message(成功)
	// 第三次 onUpdate: toolResult message(失败)
	// 增量索引应让每条 message 只发一次,不重复。
	const runnerCalls: any[] = [];
	setTaskWorkerRunnerForTests(async (...args: any[]) => {
		runnerCalls.push(args);
		const onUpdate = args[7];
		const makeDetails = args[8];
		const mkPartial = (messages: any[]) => ({
			content: [{ type: "text", text: "running" }],
			details: makeDetails([{ agent: "worker", agentSource: "user", task: "t", exitCode: 0, messages, stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } }]),
		});
		if (onUpdate) {
			onUpdate(mkPartial([{
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "chrome_cdp", arguments: { action: "navigate", url: "https://example.com" } }],
				usage: { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2 }, model: "m", stopReason: "toolUse", api: "anthropic-messages", provider: "anthropic", timestamp: 0,
			}]));
			onUpdate(mkPartial([
				{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "chrome_cdp", arguments: { action: "navigate", url: "https://example.com" } }], usage: { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2 }, model: "m", stopReason: "toolUse", api: "anthropic-messages", provider: "anthropic", timestamp: 0 },
				{ role: "toolResult", toolCallId: "c1", toolName: "chrome_cdp", content: [{ type: "text", text: "navigated ok" }], isError: false, timestamp: 0 },
			]));
			// 第三条:messages 累积(真实 subagent emitUpdate 发的是完整历史),新增 bash 失败 + write 长路径
			const longPath = "E:/AII/TUI/TUI-0627/.tasks/runs/task-x-search-1782696234776/output/x_search_results.json";
			onUpdate(mkPartial([
				{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "chrome_cdp", arguments: { action: "navigate", url: "https://example.com" } }], usage: { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2 }, model: "m", stopReason: "toolUse", api: "anthropic-messages", provider: "anthropic", timestamp: 0 },
				{ role: "toolResult", toolCallId: "c1", toolName: "chrome_cdp", content: [{ type: "text", text: "navigated ok" }], isError: false, timestamp: 0 },
				{ role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "command not found\nline2" }], isError: true, timestamp: 0 },
				{ role: "assistant", content: [{ type: "toolCall", id: "c3", name: "write", arguments: { path: longPath } }], usage: { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2 }, model: "m", stopReason: "toolUse", api: "anthropic-messages", provider: "anthropic", timestamp: 0 },
			]));
		}
		return { agent: "worker", agentSource: "user", task: "t", exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2 }, model: "m", stopReason: "stop", api: "anthropic-messages", provider: "anthropic", timestamp: 0 }], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } } as any;
	});
	try {
		const progress: string[] = [];
		await dispatchWorker({
			skill: "# Skill",
			contract: {},
			runtimeInput: {},
			outputDir: "E:/out",
		}, { cwd: process.cwd(), onUpdate: (text) => progress.push(text) });

		// 工具调用行:含 name + 知名参数(url)摘要
		assert.ok(progress.some((line) => /🔧 chrome_cdp navigate/.test(line)), `expected chrome_cdp navigate line, got: ${JSON.stringify(progress)}`);
		// 工具结果行(成功):✔ + toolName + text 首行
		assert.ok(progress.some((line) => /✔ chrome_cdp.*navigated ok/.test(line)), `expected success tool-result line, got: ${JSON.stringify(progress)}`);
		// 工具结果行(失败):✖ + toolName + 错误首行
		assert.ok(progress.some((line) => /✖ bash.*command not found/.test(line)), `expected error tool-result line, got: ${JSON.stringify(progress)}`);
		// 增量:同一条 navigate ToolCall 出现在两次 partial,不应重复推(下游也兜底去重,这里再加一层保险)
		const navCount = progress.filter((line) => /🔧 chrome_cdp navigate/.test(line)).length;
		assert.equal(navCount, 1, `tool-call line should be emitted once via incremental index, got ${navCount}`);
		// 长路径短化成 basename(>40 字符的 path/url/file),提升 widget 可读性
		assert.ok(progress.some((line) => /🔧 write x_search_results\.json/.test(line)), `expected shortened write path, got: ${JSON.stringify(progress)}`);
		assert.ok(!progress.some((line) => /🔧 write E:\/AII\/TUI/.test(line)), `full long path should be shortened, got: ${JSON.stringify(progress)}`);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
	}
});
