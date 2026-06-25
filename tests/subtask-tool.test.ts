import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerTask } from "../extensions/task/task.ts";
import { saveTaskbook, loadTaskbook } from "../extensions/task/task-book.ts";
import { buildTaskbookPrompt } from "../extensions/task/task-registry.ts";
import { setTaskDispatcherForTests } from "../extensions/task/task-dispatcher.ts";
import { setTaskWorkerRunnerForTests } from "../extensions/task/task-worker.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(path.join(os.tmpdir(), "ugk-subtask-tool-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
process.on("exit", () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(testAgentDir, { recursive: true, force: true });
});

const spec = {
	goal: "生成报告",
	hardConstraints: ["只写输出目录"],
	acceptance: ["verify pass"],
	forbidden: [],
	context: "",
};

function makePi(initialActiveTools = ["read", "bash", "edit", "write", "subagent"]) {
	const commands = new Map<string, any>();
	const tools: any[] = [];
	const handlers = new Map<string, Function[]>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	let currentActiveTools = [...initialActiveTools];
	return {
		commands,
		handlers,
		entries,
		tools,
		pi: {
			registerCommand(name: string, options: any) {
				commands.set(name, options);
			},
			registerTool(tool: any) {
				tools.push(tool);
			},
			appendEntry(customType: string, data: unknown) {
				entries.push({ customType, data });
			},
			getActiveTools() {
				return [...currentActiveTools];
			},
			setActiveTools(names: string[]) {
				currentActiveTools = [...names];
			},
			sendUserMessage() {},
			on(event: string, handler: Function) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		},
	};
}

function makeCtx(cwd = mkdtempSync(path.join(os.tmpdir(), "ugk-subtask-tool-"))) {
	return {
		cwd,
		ctx: {
			cwd,
			sessionManager: { getEntries: () => [] },
			ui: {
				notify() {},
				select(_title: string, options: string[]) {
					return options[0];
				},
				setStatus() {},
				setWidget() {},
				editor(_title: string, value: string) {
					return value;
				},
				input(_title: string, value: string) {
					return value;
				},
				confirm() {
					return true;
				},
			},
		},
	};
}

function workerOk(summary = "done") {
	return {
		agent: "worker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: summary }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	} as any;
}

async function saveFixtureTask(cwd: string, name: string, verify = "process.exit(0);\n") {
	await saveTaskbook("project", cwd, name, {
		description: `${name} description`,
		spec,
		skill: "# Skill",
		verify,
		contract: { runtimeInput: ["text"], artifacts: [{ name: "report.txt", type: "file", required: true }] },
	});
}

test("buildTaskbookPrompt lists task names, descriptions, and input fields", async () => {
	const { cwd } = makeCtx();
	try {
		await saveFixtureTask(cwd, "alpha");
		await saveFixtureTask(cwd, "beta");

		const prompt = await buildTaskbookPrompt(cwd);

		assert.match(prompt, /## 可用 task/);
		assert.match(prompt, /- alpha — alpha description/);
		assert.match(prompt, /- beta — beta description/);
		assert.match(prompt, /input: text/);
		assert.doesNotMatch(prompt, /contract\.json/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_task single returns machine-verifiable PASS and records the run", async () => {
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => workerOk("写好了"));
	setTaskDispatcherForTests(async () => ({ text: "hello" }));
	try {
		await saveFixtureTask(cwd, "single-pass", "import {writeFile} from 'node:fs/promises'; await writeFile(`${process.env.TASK_OUTPUT_DIR}/report.txt`, 'ok', 'utf8'); process.exit(0);\n");
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", { name: "single-pass", input: "hello" }, undefined, undefined, ctx);
		const loaded = await loadTaskbook(cwd, "single-pass");

		assert.equal(result.isError, undefined);
		assert.match(result.content[0].text, /PASS/);
		assert.equal(result.details.results[0].status, "pass");
		assert.equal(path.isAbsolute(result.details.results[0].outputDir), true);
		assert.equal(result.details.results[0].artifacts.length, 1);
		assert.equal(loaded?.taskbook.runs.at(-1)?.status, "pass");
		assert.deepEqual(loaded?.taskbook.runs.at(-1)?.input, { text: "hello" });
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_task missing taskbook returns available task names as a tool error", async () => {
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	try {
		await saveFixtureTask(cwd, "known");
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", { name: "missing", input: "hello" }, undefined, undefined, ctx);

		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /missing/);
		assert.match(result.content[0].text, /known/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_task fails cleanly when dispatcher cannot parse input (no UI prompt)", async () => {
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	let inputPrompted = 0;
	ctx.ui.input = () => {
		inputPrompted += 1;
		return "should-not-reach";
	};
	registerTask(pi as any);
	setTaskDispatcherForTests(async () => undefined);
	try {
		await saveFixtureTask(cwd, "needs-input");
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", { name: "needs-input", input: "含糊不清的输入" }, undefined, undefined, ctx);

		assert.equal(result.isError, true);
		assert.equal(inputPrompted, 0);
		assert.match(result.content[0].text, /runtimeInput|解析/);
	} finally {
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("taskbook prompt is injected before agent starts after session_start", async () => {
	const { pi, handlers } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	try {
		await saveFixtureTask(cwd, "injectable");

		await handlers.get("session_start")![0]({}, ctx);
		const injected = await handlers.get("before_agent_start")![0]({}, ctx);

		assert.match(injected.systemPrompt, /injectable/);
		assert.equal(injected.message, undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_task parallel confirms protected tools once for the batch", async () => {
	const { pi, tools } = makePi(["read", "bash", "chrome_cdp"]);
	const { cwd, ctx } = makeCtx();
	let confirmCount = 0;
	ctx.ui.confirm = () => {
		confirmCount += 1;
		return true;
	};
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => workerOk("done"));
	setTaskDispatcherForTests(async (_ctx, _skill, _contract, rawInput) => ({ text: rawInput }));
	try {
		await saveTaskbook("project", cwd, "protected-a", {
			description: "protected a",
			spec,
			skill: "Use chrome_cdp.",
			verify: "process.exit(0);\n",
			contract: { requiredTools: ["chrome_cdp"], artifacts: [] },
		});
		await saveTaskbook("project", cwd, "protected-b", {
			description: "protected b",
			spec,
			skill: "Use chrome_cdp.",
			verify: "process.exit(0);\n",
			contract: { requiredTools: ["chrome_cdp"], artifacts: [] },
		});
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", {
			tasks: [
				{ name: "protected-a", input: "one" },
				{ name: "protected-b", input: "two" },
			],
		}, undefined, undefined, ctx);

		assert.equal(result.isError, undefined);
		assert.equal(confirmCount, 1);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_task parallel isolates a single task's execution failure from the batch", async () => {
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	let callCount = 0;
	setTaskWorkerRunnerForTests(async () => {
		callCount += 1;
		if (callCount === 2) throw new Error("spawn crashed");
		return workerOk("done");
	});
	setTaskDispatcherForTests(async () => ({ text: "x" }));
	try {
		await saveFixtureTask(cwd, "good");
		await saveFixtureTask(cwd, "crashy");
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", {
			tasks: [{ name: "good", input: "a" }, { name: "crashy", input: "b" }],
		}, undefined, undefined, ctx);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0].text, /1\/2 succeeded/);
		const failed = result.details.results.filter((item: any) => item.status === "fail");
		assert.equal(failed.length, 1);
		assert.match(failed[0].workerSummary, /spawn crashed/);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_task parallel returns per-task output directories and aggregate count", async () => {
	const { pi, tools } = makePi();
	const { cwd, ctx } = makeCtx();
	registerTask(pi as any);
	setTaskWorkerRunnerForTests(async () => workerOk("done"));
	setTaskDispatcherForTests(async (_ctx, _skill, _contract, rawInput) => ({ text: rawInput }));
	try {
		await saveFixtureTask(cwd, "ok-task");
		await saveFixtureTask(cwd, "bad-task", "console.log(JSON.stringify([{assertion:'ok',expected:'true',actual:'false'}])); process.exit(1);\n");
		const tool = tools.find((item) => item.name === "run_task");

		const result = await tool.execute("call-1", {
			tasks: [
				{ name: "ok-task", input: "one" },
				{ name: "bad-task", input: "two" },
			],
		}, undefined, undefined, ctx);

		assert.match(result.content[0].text, /1\/2 succeeded/);
		assert.equal(result.details.results[0].status, "pass");
		assert.equal(result.details.results[1].status, "fail");
		assert.notEqual(result.details.results[0].outputDir, result.details.results[1].outputDir);
	} finally {
		setTaskWorkerRunnerForTests(undefined);
		setTaskDispatcherForTests(undefined);
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("task executing phase blocks nested run_task", async () => {
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx();
	registerTask(pi as any);

	await commands.get("task").handler("new", ctx);
	await handlers.get("tool_call")![0]({ toolName: "questionnaire" }, ctx);
	await handlers.get("agent_end")![0]({
		messages: [{ role: "assistant", content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` }] }],
	}, ctx);
	await commands.get("task").handler("execute", ctx);

	const blocked = await handlers.get("tool_call")![0]({ toolName: "run_task", input: {} }, ctx);

	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /禁止调用/);
});
