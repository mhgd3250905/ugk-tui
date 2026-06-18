import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerFlow, setFlowDriverSessionFactoryForTests } from "../extensions/flow/index.ts";
import { readDriverStatus, writeDriverStatus } from "../extensions/flow/driver-store.ts";

function makePi() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const sentMessages: Array<{ message: any; options?: any }> = [];
	const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
	return {
		commands,
		handlers,
		sentMessages,
		entries,
		pi: {
			registerCommand(name: string, options: any) {
				commands.set(name, options);
			},
			on(event: string, handler: Function) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			sendMessage(message: any, options?: any) {
				sentMessages.push({ message, options });
			},
			appendEntry(customType: string, data: unknown) {
				entries.push({ type: "custom", customType, data });
			},
		},
	};
}

function makeCtx(cwd = process.cwd()) {
	const notifications: Array<{ message: string; type?: string }> = [];
	const confirms: Array<{ title: string; message: string }> = [];
	const status = new Map<string, string | undefined>();
	const widgets = new Map<string, unknown>();
	const statusCalls: Array<{ key: string; value: string | undefined }> = [];
	const widgetCalls: Array<{ key: string; value: unknown }> = [];
	const sessionViewCalls: Array<{ action: "attach" | "detach"; owner: string; session?: unknown; options?: any }> = [];
	const sessionSwitcherCalls: Array<{ owner: string; options?: any }> = [];
	return {
		notifications,
		confirms,
		status,
		widgets,
		statusCalls,
		widgetCalls,
		sessionViewCalls,
		sessionSwitcherCalls,
		ctx: {
			cwd,
			hasUI: true,
			mode: "tui",
			isIdle() {
				return true;
			},
			sessionManager: {
				getEntries() {
					return [];
				},
			},
			ui: {
				notify(message: string, type?: string) {
					notifications.push({ message, type });
				},
				async confirm(title: string, message: string) {
					confirms.push({ title, message });
					return true;
				},
				select(_title: string, options: string[]) {
					return options[0];
				},
				setStatus(key: string, value: string | undefined) {
					status.set(key, value);
					statusCalls.push({ key, value });
				},
				setWidget(key: string, value: unknown) {
					widgets.set(key, value);
					widgetCalls.push({ key, value });
				},
				attachSessionView(owner: string, session: unknown, options?: any) {
					sessionViewCalls.push({ action: "attach", owner, session, options });
					return true;
				},
				detachSessionView(owner: string) {
					sessionViewCalls.push({ action: "detach", owner });
					return true;
				},
				setSessionSwitcher(owner: string, options?: any) {
					sessionSwitcherCalls.push({ owner, options });
					return true;
				},
				theme: {
					fg(_name: string, text: string) {
						return text;
					},
				},
			},
		},
	};
}

function makeTempFlowProject(
	drivers: Array<{
		taskId: string;
		runId: string;
		status: string;
		step?: string;
		summary?: string;
		updatedAt?: string;
	}>,
) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flow-extension-"));
	for (const driver of drivers) {
		const runDir = path.join(cwd, ".flow", "tasks", driver.taskId, "runs", driver.runId);
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(
			path.join(runDir, "status.json"),
			`${JSON.stringify(
				{
					taskId: driver.taskId,
					runId: driver.runId,
					status: driver.status,
					step: driver.step,
					summary: driver.summary,
					updatedAt: driver.updatedAt ?? "2026-06-17T00:00:00.000Z",
				},
				null,
				"\t",
			)}\n`,
		);
		fs.writeFileSync(path.join(runDir, "feedback.md"), "# User Feedback\n\n");
	}
	return cwd;
}

function writeTempTask(cwd: string, taskId: string, status = "draft"): void {
	const taskDir = path.join(cwd, ".flow", "tasks", taskId);
	fs.mkdirSync(taskDir, { recursive: true });
	fs.writeFileSync(
		path.join(taskDir, "task.json"),
		`${JSON.stringify({ id: taskId, status, version: 1 }, null, 2)}\n`,
		"utf8",
	);
	fs.writeFileSync(path.join(taskDir, "SKILL.md"), "# Skill\n\n## 最优路径\n\nA. Prepare\n", "utf8");
	fs.writeFileSync(path.join(taskDir, "todo.template.md"), "# Run Todo\n", "utf8");
	fs.writeFileSync(path.join(taskDir, "validator.md"), "# Validator\n", "utf8");
}

function makeTempTaskProject(taskId: string): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flow-task-"));
	writeTempTask(cwd, taskId);
	return cwd;
}

function writePassingRunOutput(runDir: string, summary = "driver result PASS"): void {
	fs.mkdirSync(path.join(runDir, "output"), { recursive: true });
	fs.mkdirSync(path.join(runDir, "evidence"), { recursive: true });
	fs.writeFileSync(
		path.join(runDir, "output", "result.json"),
		`${JSON.stringify({ title: "PASS", summary, pathUsed: "A" }, null, "\t")}\n`,
	);
	fs.writeFileSync(path.join(runDir, "evidence", "read-evidence.md"), "# Evidence\n\nPASS\n");
}

function writePassingValidation(runDir: string, taskId: string, runId = "run-001", summary = "ok"): void {
	fs.writeFileSync(
		path.join(runDir, "validation.json"),
		`${JSON.stringify(
			{
				taskId,
				runId,
				phase: "prove",
				result: "PASS",
				summary,
				issues: [],
				artifacts: {
					resultJson: path.join(runDir, "output", "result.json"),
					evidenceDir: path.join(runDir, "evidence"),
					progressMd: path.join(runDir, "progress.md"),
					validationJson: path.join(runDir, "validation.json"),
					validationMd: path.join(runDir, "validation.md"),
				},
				createdAt: "2026-06-18T01:00:00.000Z",
				nextStep: `/flow task review ${taskId}/${runId}`,
			},
			null,
			"\t",
		)}\n`,
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("registerFlow registers /flow command", () => {
	const { pi, commands } = makePi();

	registerFlow(pi as any);

	assert.ok(commands.has("flow"));
	assert.match(commands.get("flow").description, /Flow/);
});

test('/flow task create "..." queues request and injects hidden task context', async () => {
	const { pi, commands, sentMessages } = makePi();
	const { ctx, notifications } = makeCtx();
	registerFlow(pi as any);

	await commands.get("flow").handler('task create "整理代码审查流程"', ctx);

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].type, "info");
	assert.match(notifications[0].message, /创建 Task 草案/);
	assert.match(notifications[0].message, /整理代码审查流程/);

	assert.equal(sentMessages.length, 1);
	assert.equal(sentMessages[0].message.customType, "flow-task-context");
	assert.equal(sentMessages[0].message.display, false);
	assert.match(sentMessages[0].message.content, /\[FLOW TASK CREATE\]/);
	assert.match(sentMessages[0].message.content, /整理代码审查流程/);
	assert.match(sentMessages[0].message.content, /\[FLOW CONTEXT ID: flow-1\]/);
	assert.deepEqual(sentMessages[0].options, { triggerTurn: true });
});

test("/flow help only notifies and does not send request", async () => {
	const { pi, commands, sentMessages } = makePi();
	const { ctx, notifications } = makeCtx();
	registerFlow(pi as any);

	await commands.get("flow").handler("", ctx);

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].type, "info");
	assert.match(notifications[0].message, /\[FLOW HELP\]/);
	assert.equal(sentMessages.length, 0);
});

test("flow command does not run while agent is busy", async () => {
	const { pi, commands, sentMessages } = makePi();
	const { ctx } = makeCtx();
	ctx.isIdle = () => false;
	registerFlow(pi as any);

	await commands.get("flow").handler("status", ctx);

	assert.equal(sentMessages.length, 0);
});

test("context filter preserves current injected flow context and removes stale contexts", async () => {
	const { pi, commands, handlers, sentMessages } = makePi();
	const { ctx } = makeCtx();
	registerFlow(pi as any);

	await commands.get("flow").handler("status", ctx);
	const current = sentMessages[0].message;
	const stale = {
		customType: "flow-task-context",
		content: "[FLOW TASK RUN]\nold",
		display: false,
	};

	const result = await handlers.get("context")![0]({
		messages: [stale, current, { role: "user", content: "正常用户消息" }],
	});

	assert.deepEqual(result.messages, [current, { role: "user", content: "正常用户消息" }]);
});

test("context filter keeps current flow context through agent_end and removes it on the next idle input", async () => {
	const { pi, commands, handlers, sentMessages } = makePi();
	const { ctx } = makeCtx();
	registerFlow(pi as any);

	await commands.get("flow").handler("status", ctx);
	const current = sentMessages[0].message;

	for (const handler of handlers.get("turn_end") ?? []) {
		await handler();
	}
	const afterTurnEnd = await handlers.get("context")![0]({ messages: [current] });

	for (const handler of handlers.get("agent_end") ?? []) {
		await handler();
	}
	const afterAgentEnd = await handlers.get("context")![0]({ messages: [current] });

	await handlers.get("input")![0]({ text: "下一条普通消息", source: "interactive" });
	const afterNextInput = await handlers.get("context")![0]({ messages: [current] });

	assert.deepEqual(afterTurnEnd.messages, [current]);
	assert.deepEqual(afterAgentEnd.messages, [current]);
	assert.deepEqual(afterNextInput.messages, []);
});

test("context filter keeps current flow context for streaming follow-up input", async () => {
	const { pi, commands, handlers, sentMessages } = makePi();
	const { ctx } = makeCtx();
	registerFlow(pi as any);

	await commands.get("flow").handler("status", ctx);
	const current = sentMessages[0].message;

	await handlers.get("input")![0]({ text: "补充说明", source: "interactive", streamingBehavior: "followUp" });
	const result = await handlers.get("context")![0]({ messages: [current] });

	assert.deepEqual(result.messages, [current]);
});

test("/flow status queues a status request", async () => {
	const { pi, commands, sentMessages } = makePi();
	const { ctx, notifications } = makeCtx();
	registerFlow(pi as any);

	await commands.get("flow").handler("status", ctx);

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].type, "info");
	assert.match(notifications[0].message, /查看状态/);
	assert.match(sentMessages[0].message.content, /\[FLOW STATUS\]/);
});

test("/flow task prove creates a run and starts a driver session", async () => {
	const started: string[] = [];
	let initialPrompt = "";
	let runDir = "";
	setFlowDriverSessionFactoryForTests(async (options) => ({
		taskId: "x",
		runId: "run-001",
		runDir: options.runDir,
		sessionFile: "driver.jsonl",
		async start() {
			initialPrompt = options.initialPrompt;
			runDir = options.runDir;
			started.push("started");
			await new Promise(() => {});
		},
		async sendUserInput(text: string) {
			started.push(text);
		},
		getTranscriptText() {
			return "";
		},
		getWidgetLines() {
			return ["driver"];
		},
		dispose() {},
	}));
	try {
		const { pi, commands, sentMessages } = makePi();
		const { ctx, notifications } = makeCtx();
		ctx.cwd = makeTempTaskProject("x");
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove x --input keyword=Medtrum", ctx);

		assert.deepEqual(started, ["started"]);
		assert.match(initialPrompt, /\[FLOW INTERACTIVE DRIVER\]/);
		assert.match(initialPrompt, /SKILL\.md/);
		assert.match(initialPrompt, /validator\.md/);
		assert.equal(fs.existsSync(path.join(runDir, "input.json")), true);
		assert.equal(sentMessages.length, 0);
		assert.match(notifications.at(-1)!.message, /Flow driver running/);
		assert.match(notifications.at(-1)!.message, /\/flow attach x\/run-001/);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("/flow task prove passes a confirmation-capable driver UI proxy", async () => {
	let driverConfirmResult: boolean | undefined;
	setFlowDriverSessionFactoryForTests(async (options: any) => {
		driverConfirmResult = await options.uiContext.confirm("Allow Chrome CDP?", "driver needs logged-in Chrome");
		options.uiContext.setStatus("driver-probe", "must not touch main status");
		options.uiContext.setWidget("driver-probe", ["must not touch main widget"]);
		return {
			taskId: "x",
			runId: "run-001",
			runDir: options.runDir,
			async start() {},
			async sendUserInput() {},
			getTranscriptText() {
				return "";
			},
			getWidgetLines() {
				return ["driver"];
			},
			dispose() {},
		};
	});
	try {
		const { pi, commands } = makePi();
		const { ctx, confirms, status, widgets } = makeCtx();
		ctx.cwd = makeTempTaskProject("x");
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove x", ctx);

		assert.equal(driverConfirmResult, true);
		assert.deepEqual(confirms, [{ title: "Allow Chrome CDP?", message: "driver needs logged-in Chrome" }]);
		assert.equal(status.has("driver-probe"), false);
		assert.equal(widgets.has("driver-probe"), false);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("/flow run missing task is blocked before creating a driver run", async () => {
	let factoryCalls = 0;
	setFlowDriverSessionFactoryForTests(async () => {
		factoryCalls += 1;
		throw new Error("factory should not run");
	});
	try {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flow-task-"));
		const { pi, commands, sentMessages } = makePi();
		const { ctx, notifications } = makeCtx(cwd);
		registerFlow(pi as any);

		await commands.get("flow").handler("run missing-task --input x", ctx);

		assert.equal(factoryCalls, 0);
		assert.equal(sentMessages.length, 0);
		assert.equal(fs.existsSync(path.join(cwd, ".flow", "tasks", "missing-task", "runs")), false);
		assert.equal(notifications.at(-1)?.type, "error");
		assert.match(notifications.at(-1)?.message ?? "", /missing-task/);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("/flow run draft task is blocked before creating a driver run", async () => {
	let factoryCalls = 0;
	setFlowDriverSessionFactoryForTests(async () => {
		factoryCalls += 1;
		throw new Error("factory should not run");
	});
	try {
		const cwd = makeTempTaskProject("draft-task");
		const { pi, commands, sentMessages } = makePi();
		const { ctx, notifications } = makeCtx(cwd);
		registerFlow(pi as any);

		await commands.get("flow").handler("run draft-task", ctx);

		assert.equal(factoryCalls, 0);
		assert.equal(sentMessages.length, 0);
		assert.equal(fs.existsSync(path.join(cwd, ".flow", "tasks", "draft-task", "runs")), false);
		assert.equal(notifications.at(-1)?.type, "warning");
		assert.match(notifications.at(-1)?.message ?? "", /draft/);
		assert.match(notifications.at(-1)?.message ?? "", /verified\/active/);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("/flow run needs-human task is blocked before creating a driver run", async () => {
	let factoryCalls = 0;
	setFlowDriverSessionFactoryForTests(async () => {
		factoryCalls += 1;
		throw new Error("factory should not run");
	});
	try {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flow-task-"));
		writeTempTask(cwd, "human-task", "needs-human");
		const { pi, commands, sentMessages } = makePi();
		const { ctx, notifications } = makeCtx(cwd);
		registerFlow(pi as any);

		await commands.get("flow").handler("run human-task", ctx);

		assert.equal(factoryCalls, 0);
		assert.equal(sentMessages.length, 0);
		assert.equal(fs.existsSync(path.join(cwd, ".flow", "tasks", "human-task", "runs")), false);
		assert.equal(notifications.at(-1)?.type, "warning");
		assert.match(notifications.at(-1)?.message ?? "", /needs-human/);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("/flow run verified task is blocked without an accepted review", async () => {
	let factoryCalls = 0;
	setFlowDriverSessionFactoryForTests(async () => {
		factoryCalls += 1;
		throw new Error("factory should not run");
	});
	try {
		const cwd = makeTempTaskProject("verified-task");
		const taskPath = path.join(cwd, ".flow", "tasks", "verified-task", "task.json");
		fs.writeFileSync(
			taskPath,
			`${JSON.stringify(
				{
					id: "verified-task",
					status: "verified",
					version: 2,
					latest_review_run: "run-001",
				},
				null,
				"\t",
			)}\n`,
		);
		const { pi, commands, sentMessages } = makePi();
		const { ctx, notifications } = makeCtx(cwd);
		registerFlow(pi as any);

		await commands.get("flow").handler("run verified-task", ctx);

		assert.equal(factoryCalls, 0);
		assert.equal(sentMessages.length, 0);
		assert.equal(notifications.at(-1)?.type, "warning");
		assert.match(notifications.at(-1)?.message ?? "", /accepted review/i);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("/flow run verified task starts only when latest review is accepted", async () => {
	let factoryCalls = 0;
	setFlowDriverSessionFactoryForTests(async (options) => {
		factoryCalls += 1;
		return {
			taskId: options.taskId,
			runId: options.runId,
			runDir: options.runDir,
			async start() {
				await new Promise(() => {});
			},
			async sendUserInput() {},
			getTranscriptText() {
				return "";
			},
			getWidgetLines() {
				return ["driver"];
			},
			dispose() {},
		};
	});
	try {
		const cwd = makeTempTaskProject("verified-task");
		const taskDir = path.join(cwd, ".flow", "tasks", "verified-task");
		fs.writeFileSync(
			path.join(taskDir, "task.json"),
			`${JSON.stringify(
				{
					id: "verified-task",
					status: "verified",
					version: 2,
					latest_review_run: "run-001",
				},
				null,
				"\t",
			)}\n`,
		);
		const reviewRunDir = path.join(taskDir, "runs", "run-001");
		fs.mkdirSync(reviewRunDir, { recursive: true });
		fs.writeFileSync(
			path.join(reviewRunDir, "review.json"),
			`${JSON.stringify(
				{
					taskId: "verified-task",
					runId: "run-001",
					status: "accepted",
					userConfirmed: true,
					taskDesignUpdated: true,
					taskVersion: 2,
				},
				null,
				"\t",
			)}\n`,
		);
		const { pi, commands } = makePi();
		const { ctx, notifications } = makeCtx(cwd);
		registerFlow(pi as any);

		await commands.get("flow").handler("run verified-task", ctx);

		assert.equal(factoryCalls, 1);
		assert.match(notifications.at(-1)?.message ?? "", /Flow driver running/);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("/flow task prove missing task is blocked before creating a driver run", async () => {
	let factoryCalls = 0;
	setFlowDriverSessionFactoryForTests(async () => {
		factoryCalls += 1;
		throw new Error("factory should not run");
	});
	try {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flow-task-"));
		const { pi, commands, sentMessages } = makePi();
		const { ctx, notifications } = makeCtx(cwd);
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove missing-task", ctx);

		assert.equal(factoryCalls, 0);
		assert.equal(sentMessages.length, 0);
		assert.equal(fs.existsSync(path.join(cwd, ".flow", "tasks", "missing-task", "runs")), false);
		assert.equal(notifications.at(-1)?.type, "error");
		assert.match(notifications.at(-1)?.message ?? "", /missing-task/);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("/flow task prove missing required task files is blocked before creating a driver run", async () => {
	let factoryCalls = 0;
	setFlowDriverSessionFactoryForTests(async () => {
		factoryCalls += 1;
		throw new Error("factory should not run");
	});
	try {
		const cwd = makeTempTaskProject("incomplete-task");
		fs.unlinkSync(path.join(cwd, ".flow", "tasks", "incomplete-task", "validator.md"));
		const { pi, commands, sentMessages } = makePi();
		const { ctx, notifications } = makeCtx(cwd);
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove incomplete-task", ctx);

		assert.equal(factoryCalls, 0);
		assert.equal(sentMessages.length, 0);
		assert.equal(fs.existsSync(path.join(cwd, ".flow", "tasks", "incomplete-task", "runs")), false);
		assert.equal(notifications.at(-1)?.type, "error");
		assert.match(notifications.at(-1)?.message ?? "", /validator\.md/);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("/flow task prove rejects invalid task ids before resolving task paths", async () => {
	let factoryCalls = 0;
	setFlowDriverSessionFactoryForTests(async () => {
		factoryCalls += 1;
		throw new Error("factory should not run");
	});
	try {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flow-task-"));
		const outsideTaskDir = path.join(cwd, "outside");
		fs.mkdirSync(outsideTaskDir, { recursive: true });
		fs.writeFileSync(path.join(outsideTaskDir, "task.json"), JSON.stringify({ id: "outside", status: "draft" }), "utf8");
		fs.writeFileSync(path.join(outsideTaskDir, "SKILL.md"), "# Skill\n", "utf8");
		fs.writeFileSync(path.join(outsideTaskDir, "todo.template.md"), "# Todo\n", "utf8");
		fs.writeFileSync(path.join(outsideTaskDir, "validator.md"), "# Validator\n", "utf8");
		const { pi, commands, sentMessages } = makePi();
		const { ctx, notifications } = makeCtx(cwd);
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove ../../outside", ctx);

		assert.equal(factoryCalls, 0);
		assert.equal(sentMessages.length, 0);
		assert.equal(fs.existsSync(path.join(outsideTaskDir, "runs")), false);
		assert.equal(notifications.at(-1)?.type, "error");
		assert.match(notifications.at(-1)?.message ?? "", /Invalid task id/);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("driver factory failure marks the run failed without registering a live driver", async () => {
	setFlowDriverSessionFactoryForTests(async () => {
		throw new Error("session create failed");
	});
	try {
		const cwd = makeTempTaskProject("x");
		const { pi, commands, handlers } = makePi();
		const { ctx, notifications } = makeCtx(cwd);
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove x --input keyword=Medtrum", ctx);

		const runDir = path.join(cwd, ".flow", "tasks", "x", "runs", "run-001");
		const status = readDriverStatus(runDir);
		assert.equal(status?.status, "failed");
		assert.match(status?.summary ?? "", /session create failed/);
		assert.equal(notifications.at(-1)?.type, "error");
		assert.match(notifications.at(-1)?.message ?? "", /session create failed/);

		await commands.get("flow").handler("attach x/run-001", ctx);
		const result = await handlers.get("input")![0]({ text: "继续", source: "interactive" }, ctx);

		assert.deepEqual(result, { action: "handled" });
		assert.equal(notifications.at(-1)?.type, "warning");
		assert.match(notifications.at(-1)?.message ?? "", /not live/);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("driver start failure disposes and removes the live driver", async () => {
	let disposed = false;
	let sendCalls = 0;
	setFlowDriverSessionFactoryForTests(async (options) => ({
		taskId: options.taskId,
		runId: options.runId,
		runDir: options.runDir,
		sessionFile: "driver.jsonl",
		async start() {
			throw new Error("driver start failed");
		},
		async sendUserInput() {
			sendCalls += 1;
		},
		getTranscriptText() {
			return "";
		},
		getWidgetLines() {
			return ["driver"];
		},
		dispose() {
			disposed = true;
		},
	}));
	try {
		const cwd = makeTempTaskProject("x");
		const { pi, commands, handlers } = makePi();
		const { ctx, notifications } = makeCtx(cwd);
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove x", ctx);
		await sleep(10);

		const runDir = path.join(cwd, ".flow", "tasks", "x", "runs", "run-001");
		const status = readDriverStatus(runDir);
		assert.equal(status?.status, "failed");
		assert.match(status?.summary ?? "", /driver start failed/);
		assert.equal(disposed, true);

		await commands.get("flow").handler("attach x/run-001", ctx);
		const result = await handlers.get("input")![0]({ text: "继续", source: "interactive" }, ctx);

		assert.deepEqual(result, { action: "handled" });
		assert.equal(sendCalls, 0);
		assert.equal(notifications.at(-1)?.type, "warning");
		assert.match(notifications.at(-1)?.message ?? "", /not live/);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("driver terminal completion keeps the driver accessible until review", async () => {
	let disposed = false;
	let releaseStart!: () => void;
	const startCompleted = new Promise<void>((resolve) => {
		releaseStart = resolve;
	});
	setFlowDriverSessionFactoryForTests(async (options) => ({
		taskId: options.taskId,
		runId: options.runId,
		runDir: options.runDir,
		sessionFile: "driver.jsonl",
		async start() {
			await startCompleted;
			writePassingRunOutput(options.runDir, "PASS");
		},
		async sendUserInput() {},
		getTranscriptText() {
			return "PASS";
		},
		getWidgetLines() {
			return ["PASS"];
		},
		dispose() {
			disposed = true;
		},
	}));
	try {
		const cwd = makeTempTaskProject("x");
		const { pi, commands, entries } = makePi();
		const { ctx, notifications, status, widgets } = makeCtx(cwd);
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove x", ctx);
		await commands.get("flow").handler("attach x/run-001", ctx);

		const runDir = path.join(cwd, ".flow", "tasks", "x", "runs", "run-001");
		releaseStart();
		await sleep(10);

		const runStatus = readDriverStatus(runDir);
		assert.equal(disposed, false);
		assert.equal(runStatus?.status, "done");
		assert.equal(runStatus?.step, "validated");
		assert.equal(runStatus?.summary, "PASS: PASS");
		assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, ".flow", "tasks", "x", "task.json"), "utf8")).status, "proved");
		assert.equal(fs.existsSync(path.join(runDir, "validation.json")), true);
		assert.equal(status.get("flow-driver"), "driver:run-001");
		assert.deepEqual(widgets.get("flow-driver-view"), ["PASS"]);
		assert.deepEqual(entries.at(-1)?.data, { focus: "driver", taskId: "x", runId: "run-001" });
		assert.equal(notifications.at(-1)?.type, "info");
		assert.match(notifications.at(-1)?.message ?? "", /Flow driver completed: x\/run-001/);
		assert.match(notifications.at(-1)?.message ?? "", /driver completed/);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("main view shows running driver activity and completed driver result", async () => {
	let releaseStart!: () => void;
	const startCompleted = new Promise<void>((resolve) => {
		releaseStart = resolve;
	});
	let transcript = "";
	setFlowDriverSessionFactoryForTests(async (options) => ({
		taskId: options.taskId,
		runId: options.runId,
		runDir: options.runDir,
		sessionFile: "driver.jsonl",
		async start() {
			await startCompleted;
			transcript = "最终结果：找到 3 条 medtrum 相关帖子";
			writePassingRunOutput(options.runDir, transcript);
		},
		async sendUserInput() {},
		getTranscriptText() {
			return transcript;
		},
		getWidgetLines() {
			return ["driver widget fallback"];
		},
		dispose() {},
	}));
	try {
		const { pi, commands } = makePi();
		const { ctx, widgets, sessionSwitcherCalls } = makeCtx(makeTempTaskProject("x"));
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove x", ctx);

		assert.deepEqual(widgets.get("flow-driver-view"), [
			"Flow driver activity",
			"- x/run-001 running starting",
			"  waiting for driver result...",
		]);

		releaseStart();
		await sleep(10);

		assert.deepEqual(widgets.get("flow-driver-view"), [
			"Flow driver activity",
			"- x/run-001 done validated",
			"  result: PASS - 最终结果：找到 3 条 medtrum 相关帖子",
			"  next: /flow task review x/run-001",
		]);
		const switcher = sessionSwitcherCalls.at(-1);
		assert.deepEqual(
			switcher?.options.items.map((item: any) => ({
				id: item.id,
				description: item.description,
			})),
			[{ id: "x/run-001", description: "done validated" }],
		);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("driver completion queues a main-agent validation handoff", async () => {
	let releaseStart!: () => void;
	const startCompleted = new Promise<void>((resolve) => {
		releaseStart = resolve;
	});
	setFlowDriverSessionFactoryForTests(async (options) => ({
		taskId: options.taskId,
		runId: options.runId,
		runDir: options.runDir,
		sessionFile: "driver.jsonl",
		async start() {
			fs.mkdirSync(path.join(options.runDir, "output"), { recursive: true });
			fs.writeFileSync(path.join(options.runDir, "output", "result.json"), '{"ok":true}\n');
			await startCompleted;
		},
		async sendUserInput() {},
		getTranscriptText() {
			return "✅ Run-001 完成\n结果: PASS";
		},
		getWidgetLines() {
			return ["driver widget fallback"];
		},
		dispose() {},
	}));
	try {
		const { pi, commands, sentMessages } = makePi();
		const { ctx } = makeCtx(makeTempTaskProject("x"));
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove x", ctx);
		releaseStart();
		await sleep(10);

		const handoff = sentMessages.at(-1);
		assert.equal(handoff?.options?.triggerTurn, true);
		assert.equal(handoff?.message.customType, "flow-task-context");
		assert.equal(handoff?.message.display, false);
		assert.match(handoff?.message.content ?? "", /\[FLOW DRIVER COMPLETION\]/);
		assert.match(handoff?.message.content ?? "", /Task ID: x/);
		assert.match(handoff?.message.content ?? "", /Run ID: run-001/);
		assert.match(handoff?.message.content ?? "", /output\/result\.json/);
		assert.match(handoff?.message.content ?? "", /验收/);
		assert.match(handoff?.message.content ?? "", /\/flow task review x\/run-001/);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("/flow attach with no args opens picker and focuses selected driver", async () => {
	const updatedAt = new Date().toISOString();
	const cwd = makeTempFlowProject([
		{
			taskId: "task-a",
			runId: "run-001",
			status: "running",
			step: "step 1",
			updatedAt,
		},
		{
			taskId: "task-b",
			runId: "run-004",
			status: "waiting",
			step: "step 4",
			updatedAt,
		},
		{
			taskId: "task-done",
			runId: "run-009",
			status: "done",
			step: "complete",
			updatedAt,
		},
	]);
	const { pi, commands, sentMessages, entries } = makePi();
	const { ctx, notifications, status } = makeCtx(cwd);
	let pickerOptions: string[] = [];
	ctx.ui.select = async (_title: string, options: string[]) => {
		pickerOptions = options;
		await sleep(1100);
		return options[1];
	};
	registerFlow(pi as any);

	await commands.get("flow").handler("attach", ctx);

	assert.equal(notifications.at(-1)?.type, "info");
	assert.doesNotMatch(notifications.at(-1)?.message ?? "", /Flow driver attached/);
	assert.match(notifications.at(-1)?.message ?? "", /not live/);
	assert.match(notifications.at(-1)?.message ?? "", /showing summary only/);
	assert.match(notifications.at(-1)?.message ?? "", /task-b\/run-004/);
	assert.ok(pickerOptions.some((option) => option.includes("done") && option.includes("run-009")));
	assert.deepEqual(entries.at(-1)?.data, { focus: "driver", taskId: "task-b", runId: "run-004" });
	assert.equal(status.get("flow-driver"), "driver:run-004");
	assert.equal(sentMessages.length, 0);
});

test("/flow attach <run-id> warns when run id is ambiguous", async () => {
	const cwd = makeTempFlowProject([
		{ taskId: "task-a", runId: "run-001", status: "running", updatedAt: "2026-06-17T00:00:01.000Z" },
		{ taskId: "task-b", runId: "run-001", status: "waiting", updatedAt: "2026-06-17T00:00:02.000Z" },
	]);
	const { pi, commands, sentMessages, entries } = makePi();
	const { ctx, notifications } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("attach run-001", ctx);

	assert.equal(notifications.at(-1)?.type, "warning");
	assert.match(notifications.at(-1)?.message ?? "", /ambiguous/);
	assert.match(notifications.at(-1)?.message ?? "", /run-001/);
	assert.match(notifications.at(-1)?.message ?? "", /task-a\/run-001/);
	assert.equal(sentMessages.length, 0);
	assert.equal(entries.length, 0);
});

test("/flow attach <task-id>/<run-id> directly attaches an exact driver", async () => {
	const cwd = makeTempFlowProject([
		{ taskId: "task-a", runId: "run-001", status: "running", updatedAt: "2026-06-17T00:00:01.000Z" },
		{ taskId: "task-b", runId: "run-001", status: "waiting", updatedAt: "2026-06-17T00:00:02.000Z" },
	]);
	const { pi, commands, sentMessages, entries } = makePi();
	const { ctx, notifications } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("attach task-b/run-001", ctx);

	assert.equal(notifications.at(-1)?.type, "info");
	assert.match(notifications.at(-1)?.message ?? "", /task-b\/run-001/);
	assert.deepEqual(entries.at(-1)?.data, { focus: "driver", taskId: "task-b", runId: "run-001" });
	assert.equal(sentMessages.length, 0);
});

test("/flow task review warns instead of queueing hidden prompt while focused on a driver", async () => {
	const cwd = makeTempFlowProject([
		{ taskId: "task-a", runId: "run-001", status: "running", updatedAt: "2026-06-17T00:00:01.000Z" },
	]);
	const { pi, commands, sentMessages, entries } = makePi();
	const { ctx, notifications } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("attach run-001", ctx);
	await commands.get("flow").handler("task review run-001", ctx);

	assert.equal(sentMessages.length, 0);
	assert.equal(notifications.at(-1)?.type, "warning");
	assert.match(notifications.at(-1)?.message ?? "", /still running/i);
	assert.deepEqual(entries.at(-1)?.data, { focus: "driver", taskId: "task-a", runId: "run-001" });
});

test("/flow task review opens a completed focused driver run and marks task reviewing", async () => {
	const cwd = makeTempTaskProject("task-a");
	const runDir = path.join(cwd, ".flow", "tasks", "task-a", "runs", "run-001");
	writeDriverStatus(runDir, {
		taskId: "task-a",
		runId: "run-001",
		status: "done",
		step: "validated",
		summary: "PASS: ok",
		updatedAt: "2026-06-18T01:00:00.000Z",
	});
	fs.writeFileSync(path.join(runDir, "feedback.md"), "# User Feedback\n\n");
	const { pi, commands, sentMessages, entries } = makePi();
	const { ctx, notifications } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("attach task-a/run-001", ctx);
	await commands.get("flow").handler("task review run-001", ctx);

	assert.deepEqual(entries.at(-1)?.data, { focus: "main" });
	assert.equal(sentMessages.length, 1);
	assert.match(sentMessages[0].message.content, /\[FLOW TASK REVIEW\]/);
	assert.match(sentMessages[0].message.content, /Task ID: task-a/);
	assert.match(sentMessages[0].message.content, /Run path: \.flow\/tasks\/task-a\/runs\/run-001/);
	assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, ".flow", "tasks", "task-a", "task.json"), "utf8")).status, "reviewing");
	assert.equal(notifications.at(-1)?.type, "info");
	assert.match(notifications.at(-1)?.message ?? "", /复盘 Run run-001/);
});

test("/flow task accept requires a started review", async () => {
	const cwd = makeTempTaskProject("task-a");
	const runDir = path.join(cwd, ".flow", "tasks", "task-a", "runs", "run-001");
	writeDriverStatus(runDir, {
		taskId: "task-a",
		runId: "run-001",
		status: "done",
		step: "validated",
		summary: "PASS: ok",
		updatedAt: "2026-06-18T01:00:00.000Z",
	});
	writePassingRunOutput(runDir, "ok");
	writePassingValidation(runDir, "task-a", "run-001", "ok");
	const { pi, commands } = makePi();
	const { ctx, notifications } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("task accept run-001", ctx);

	assert.equal(notifications.at(-1)?.type, "warning");
	assert.match(notifications.at(-1)?.message ?? "", /has not started/);
	assert.match(notifications.at(-1)?.message ?? "", /task-a\/run-001/);
	assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, ".flow", "tasks", "task-a", "task.json"), "utf8")).status, "draft");
});

test("/flow task accept marks a reviewed PASS prove as verified and unblocks run", async () => {
	let factoryCalls = 0;
	setFlowDriverSessionFactoryForTests(async (options) => {
		factoryCalls += 1;
		return {
			taskId: options.taskId,
			runId: options.runId,
			runDir: options.runDir,
			async start() {
				await new Promise(() => {});
			},
			async sendUserInput() {},
			getTranscriptText() {
				return "";
			},
			getWidgetLines() {
				return ["driver"];
			},
			dispose() {},
		};
	});
	try {
		const cwd = makeTempTaskProject("task-a");
		const runDir = path.join(cwd, ".flow", "tasks", "task-a", "runs", "run-001");
		writeDriverStatus(runDir, {
			taskId: "task-a",
			runId: "run-001",
			status: "done",
			step: "validated",
			summary: "PASS: ok",
			updatedAt: "2026-06-18T01:00:00.000Z",
		});
		writePassingRunOutput(runDir, "ok");
		writePassingValidation(runDir, "task-a", "run-001", "ok");
		const { pi, commands, sentMessages } = makePi();
		const { ctx, notifications } = makeCtx(cwd);
		registerFlow(pi as any);

		await commands.get("flow").handler("task review run-001", ctx);
		await commands.get("flow").handler("task accept run-001", ctx);
		await commands.get("flow").handler("run task-a", ctx);

		const task = JSON.parse(fs.readFileSync(path.join(cwd, ".flow", "tasks", "task-a", "task.json"), "utf8"));
		const review = JSON.parse(fs.readFileSync(path.join(runDir, "review.json"), "utf8"));
		assert.equal(task.status, "verified");
		assert.equal(task.latest_review_run, "run-001");
		assert.equal(review.status, "accepted");
		assert.equal(review.userConfirmed, true);
		assert.equal(review.taskDesignUpdated, false);
		assert.equal(review.taskDesignDecision, "no-change");
		assert.equal(factoryCalls, 1);
		assert.match(notifications.at(-1)?.message ?? "", /Flow driver running/);
		assert.equal(sentMessages.length, 1);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("/flow task reject marks task needs-human", async () => {
	const cwd = makeTempTaskProject("task-a");
	const runDir = path.join(cwd, ".flow", "tasks", "task-a", "runs", "run-001");
	writeDriverStatus(runDir, {
		taskId: "task-a",
		runId: "run-001",
		status: "done",
		step: "validated",
		summary: "PASS: ok",
		updatedAt: "2026-06-18T01:00:00.000Z",
	});
	writePassingValidation(runDir, "task-a", "run-001", "ok");
	const validationPath = path.join(runDir, "validation.json");
	const validation = JSON.parse(fs.readFileSync(validationPath, "utf8"));
	validation.result = "NEEDS-HUMAN";
	validation.summary = "missing output/result.json";
	fs.writeFileSync(validationPath, `${JSON.stringify(validation, null, "\t")}\n`);
	const { pi, commands } = makePi();
	const { ctx, notifications } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler('task reject run-001 "证据不足"', ctx);

	const task = JSON.parse(fs.readFileSync(path.join(cwd, ".flow", "tasks", "task-a", "task.json"), "utf8"));
	const review = JSON.parse(fs.readFileSync(path.join(runDir, "review.json"), "utf8"));
	assert.equal(task.status, "needs-human");
	assert.equal(task.latest_validation, "NEEDS-HUMAN");
	assert.equal(review.status, "needs-changes");
	assert.equal(review.decisions[0], "证据不足");
	assert.equal(notifications.at(-1)?.type, "warning");
	assert.match(notifications.at(-1)?.message ?? "", /needs-human/);
});

test("/flow attach <run-id> shows summary-only notice for a non-live driver", async () => {
	const cwd = makeTempFlowProject([
		{ taskId: "task-a", runId: "run-001", status: "running", updatedAt: "2026-06-17T00:00:01.000Z" },
	]);
	const { pi, commands, sentMessages } = makePi();
	const { ctx, notifications } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("attach run-001", ctx);

	assert.equal(notifications.at(-1)?.type, "info");
	assert.doesNotMatch(notifications.at(-1)?.message ?? "", /Flow driver attached/);
	assert.match(notifications.at(-1)?.message ?? "", /not live/);
	assert.match(notifications.at(-1)?.message ?? "", /showing summary only/);
	assert.match(notifications.at(-1)?.message ?? "", /task-a\/run-001/);
	assert.equal(sentMessages.length, 0);
});

test("/flow attach missing warns", async () => {
	const cwd = makeTempFlowProject([
		{ taskId: "task-a", runId: "run-001", status: "running", updatedAt: "2026-06-17T00:00:01.000Z" },
	]);
	const { pi, commands, sentMessages } = makePi();
	const { ctx, notifications } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("attach run-missing", ctx);

	assert.equal(notifications.at(-1)?.type, "warning");
	assert.match(notifications.at(-1)?.message ?? "", /run-missing/);
	assert.equal(sentMessages.length, 0);
});

test("/flow detach clears focused driver", async () => {
	const cwd = makeTempFlowProject([
		{ taskId: "task-a", runId: "run-001", status: "running", updatedAt: "2026-06-17T00:00:01.000Z" },
	]);
	const { pi, commands, sentMessages, entries } = makePi();
	const { ctx, notifications, status, widgets } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("attach run-001", ctx);
	await commands.get("flow").handler("detach", ctx);

	assert.match(notifications.at(-1)?.message ?? "", /Flow driver detached/);
	assert.deepEqual(entries.at(-1)?.data, { focus: "main" });
	assert.equal(status.get("flow-driver"), undefined);
	assert.equal(widgets.get("flow-driver-view"), undefined);
	assert.equal(sentMessages.length, 0);
});

test("/flow driver status lists drivers", async () => {
	const cwd = makeTempFlowProject([
		{
			taskId: "task-a",
			runId: "run-001",
			status: "running",
			step: "step 1",
			summary: "loading",
			updatedAt: "2026-06-17T00:00:01.000Z",
		},
		{
			taskId: "task-b",
			runId: "run-004",
			status: "waiting",
			step: "step 4",
			summary: "needs input",
			updatedAt: "2026-06-17T00:00:02.000Z",
		},
	]);
	const { pi, commands, sentMessages } = makePi();
	const { ctx, notifications } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("driver status", ctx);

	assert.equal(notifications.at(-1)?.type, "info");
	assert.match(notifications.at(-1)?.message ?? "", /run-001/);
	assert.match(notifications.at(-1)?.message ?? "", /run-004/);
	assert.equal(sentMessages.length, 0);
});

test("driver focus input is handled instead of reaching main", async () => {
	const cwd = makeTempFlowProject([
		{
			taskId: "task-a",
			runId: "run-001",
			status: "running",
			step: "首屏加载",
			updatedAt: "2026-06-17T00:00:01.000Z",
		},
	]);
	const { pi, commands, handlers } = makePi();
	const { ctx, notifications } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("attach run-001", ctx);
	const result = await handlers.get("input")![0]({ text: "停，先等首屏加载", source: "interactive" }, ctx);

	const feedback = fs.readFileSync(
		path.join(cwd, ".flow", "tasks", "task-a", "runs", "run-001", "feedback.md"),
		"utf8",
	);
	assert.deepEqual(result, { action: "handled" });
	assert.match(feedback, /停，先等首屏加载/);
	assert.match(feedback, /affected step: 首屏加载/);
	assert.doesNotMatch(feedback, /queued to driver/);
	assert.match(feedback, /recorded; not delivered because driver is not live/);
	assert.equal(notifications.at(-1)?.type, "warning");
	assert.match(notifications.at(-1)?.message ?? "", /recoverable but not live/);
});

test("driver focus input is forwarded to live driver sessions", async () => {
	const started: string[] = [];
	setFlowDriverSessionFactoryForTests(async (options) => ({
		taskId: options.taskId,
		runId: options.runId,
		runDir: options.runDir,
		sessionFile: "driver.jsonl",
		async start() {
			started.push("started");
			await new Promise(() => {});
		},
		async sendUserInput(text: string) {
			started.push(text);
		},
		getTranscriptText() {
			return "";
		},
		getWidgetLines() {
			return ["driver updated"];
		},
		dispose() {},
	}));
	try {
		const { pi, commands, handlers } = makePi();
		const { ctx, notifications, widgets } = makeCtx(makeTempTaskProject("x"));
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove x --input keyword=Medtrum", ctx);
		await commands.get("flow").handler("attach run-001", ctx);
		const result = await handlers.get("input")![0]({ text: "先暂停", source: "interactive" }, ctx);

		assert.deepEqual(result, { action: "handled" });
		assert.deepEqual(started, ["started", "先暂停"]);
		assert.deepEqual(widgets.get("flow-driver-view"), ["driver updated"]);
		assert.match(notifications.at(-1)?.message ?? "", /Sent to Flow driver run-001/);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("/flow attach live driver activates native session view when a visible session is available", async () => {
	const visibleSession = { kind: "driver-session" };
	setFlowDriverSessionFactoryForTests(async (options) => ({
		taskId: options.taskId,
		runId: options.runId,
		runDir: options.runDir,
		sessionFile: "driver.jsonl",
		visibleSession,
		async start() {
			await new Promise(() => {});
		},
		async sendUserInput() {},
		getTranscriptText() {
			return "";
		},
		getWidgetLines() {
			return ["driver widget fallback"];
		},
		dispose() {},
	}));
	try {
		const { pi, commands } = makePi();
		const { ctx, sessionViewCalls, widgets } = makeCtx(makeTempTaskProject("x"));
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove x", ctx);
		await commands.get("flow").handler("attach x/run-001", ctx);

		assert.deepEqual(sessionViewCalls.map((call) => call.action), ["attach"]);
		assert.equal(sessionViewCalls[0].owner, "flow-driver");
		assert.equal(sessionViewCalls[0].session, visibleSession);
		assert.equal(sessionViewCalls[0].options.detachCommand, "/flow detach");
		assert.match(sessionViewCalls[0].options.label, /x\/run-001/);
		assert.equal(widgets.get("flow-driver-view"), undefined);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("live Flow drivers populate the session switcher below the editor", async () => {
	const visibleSession = { kind: "driver-session" };
	setFlowDriverSessionFactoryForTests(async (options) => ({
		taskId: options.taskId,
		runId: options.runId,
		runDir: options.runDir,
		sessionFile: "driver.jsonl",
		visibleSession,
		async start() {
			await new Promise(() => {});
		},
		async sendUserInput() {},
		getTranscriptText() {
			return "";
		},
		getWidgetLines() {
			return ["driver widget fallback"];
		},
		dispose() {},
	}));
	try {
		const { pi, commands } = makePi();
		const { ctx, sessionSwitcherCalls } = makeCtx(makeTempTaskProject("x"));
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove x", ctx);

		const switcher = sessionSwitcherCalls.at(-1);
		assert.equal(switcher?.owner, "flow-driver");
		assert.equal(switcher?.options.title, "Flow sessions");
		assert.deepEqual(
			switcher?.options.items.map((item: any) => ({
				id: item.id,
				label: item.label,
				active: item.active,
			})),
			[{ id: "x/run-001", label: "x/run-001", active: false }],
		);
		assert.equal(typeof switcher?.options.onSelect, "function");
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("Flow session switcher moves from a focused driver to main or another live driver", async () => {
	const visibleSessions: Record<string, unknown> = {
		"task-a/run-001": { kind: "driver-a" },
		"task-b/run-001": { kind: "driver-b" },
	};
	setFlowDriverSessionFactoryForTests(async (options) => ({
		taskId: options.taskId,
		runId: options.runId,
		runDir: options.runDir,
		sessionFile: `${options.taskId}.jsonl`,
		visibleSession: visibleSessions[`${options.taskId}/${options.runId}`],
		async start() {
			await new Promise(() => {});
		},
		async sendUserInput() {},
		getTranscriptText() {
			return "";
		},
		getWidgetLines() {
			return [`${options.taskId} widget`];
		},
		dispose() {},
	}));
	try {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flow-switcher-"));
		writeTempTask(cwd, "task-a");
		writeTempTask(cwd, "task-b");
		const { pi, commands, entries } = makePi();
		const { ctx, sessionSwitcherCalls, sessionViewCalls } = makeCtx(cwd);
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove task-a", ctx);
		await commands.get("flow").handler("task prove task-b", ctx);
		await commands.get("flow").handler("attach task-a/run-001", ctx);

		let switcher = sessionSwitcherCalls.at(-1);
		assert.deepEqual(
			switcher?.options.items.map((item: any) => ({
				id: item.id,
				label: item.label,
				active: item.active,
			})),
			[
				{ id: "main", label: "main", active: false },
				{ id: "task-a/run-001", label: "task-a/run-001", active: true },
				{ id: "task-b/run-001", label: "task-b/run-001", active: false },
			],
		);

		await switcher?.options.onSelect("main", switcher.options.items[0]);
		assert.deepEqual(sessionViewCalls.map((call) => call.action), ["attach", "detach"]);
		assert.deepEqual(entries.at(-1)?.data, { focus: "main" });

		switcher = sessionSwitcherCalls.at(-1);
		await switcher?.options.onSelect("task-b/run-001", switcher.options.items[1]);
		assert.equal(sessionViewCalls.at(-1)?.action, "attach");
		assert.equal(sessionViewCalls.at(-1)?.session, visibleSessions["task-b/run-001"]);
		assert.deepEqual(entries.at(-1)?.data, { focus: "driver", taskId: "task-b", runId: "run-001" });
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("Flow session switcher can open a completed driver retained in this session", async () => {
	const visibleSession = { kind: "completed-driver" };
	let releaseStart!: () => void;
	const startCompleted = new Promise<void>((resolve) => {
		releaseStart = resolve;
	});
	let disposed = false;
	setFlowDriverSessionFactoryForTests(async (options) => ({
		taskId: options.taskId,
		runId: options.runId,
		runDir: options.runDir,
		sessionFile: "driver.jsonl",
		visibleSession,
		async start() {
			await startCompleted;
			writePassingRunOutput(options.runDir, "done transcript");
		},
		async sendUserInput() {},
		getTranscriptText() {
			return "done transcript";
		},
		getWidgetLines() {
			return ["done transcript"];
		},
		dispose() {
			disposed = true;
		},
	}));
	try {
		const { pi, commands, entries } = makePi();
		const { ctx, sessionSwitcherCalls, sessionViewCalls } = makeCtx(makeTempTaskProject("x"));
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove x", ctx);
		releaseStart();
		await sleep(10);

		const switcher = sessionSwitcherCalls.at(-1);
		assert.deepEqual(
			switcher?.options.items.map((item: any) => ({
				id: item.id,
				description: item.description,
			})),
			[{ id: "x/run-001", description: "done validated" }],
		);

		await switcher?.options.onSelect("x/run-001", switcher.options.items[0]);

		assert.equal(disposed, false);
		assert.equal(sessionViewCalls.at(-1)?.action, "attach");
		assert.equal(sessionViewCalls.at(-1)?.session, visibleSession);
		assert.deepEqual(entries.at(-1)?.data, { focus: "driver", taskId: "x", runId: "run-001" });
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("driver focus input continues to native visible session instead of Flow forwarding", async () => {
	const sent: string[] = [];
	const visibleSession = { kind: "driver-session" };
	setFlowDriverSessionFactoryForTests(async (options) => ({
		taskId: options.taskId,
		runId: options.runId,
		runDir: options.runDir,
		sessionFile: "driver.jsonl",
		visibleSession,
		async start() {
			await new Promise(() => {});
		},
		async sendUserInput(text: string) {
			sent.push(text);
		},
		getTranscriptText() {
			return "";
		},
		getWidgetLines() {
			return ["driver widget fallback"];
		},
		dispose() {},
	}));
	try {
		const cwd = makeTempTaskProject("x");
		const { pi, commands, handlers } = makePi();
		const { ctx } = makeCtx(cwd);
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove x", ctx);
		await commands.get("flow").handler("attach x/run-001", ctx);
		const result = await handlers.get("input")![0]({ text: "先暂停", source: "interactive" }, ctx);

		const feedback = fs.readFileSync(path.join(cwd, ".flow", "tasks", "x", "runs", "run-001", "feedback.md"), "utf8");
		assert.deepEqual(result, { action: "continue" });
		assert.deepEqual(sent, []);
		assert.equal(feedback, "# User Feedback\n\n");
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("/flow detach clears native session view", async () => {
	const visibleSession = { kind: "driver-session" };
	setFlowDriverSessionFactoryForTests(async (options) => ({
		taskId: options.taskId,
		runId: options.runId,
		runDir: options.runDir,
		sessionFile: "driver.jsonl",
		visibleSession,
		async start() {
			await new Promise(() => {});
		},
		async sendUserInput() {},
		getTranscriptText() {
			return "";
		},
		getWidgetLines() {
			return ["driver widget fallback"];
		},
		dispose() {},
	}));
	try {
		const { pi, commands } = makePi();
		const { ctx, sessionViewCalls } = makeCtx(makeTempTaskProject("x"));
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove x", ctx);
		await commands.get("flow").handler("attach x/run-001", ctx);
		await commands.get("flow").handler("detach", ctx);

		assert.deepEqual(sessionViewCalls.map((call) => call.action), ["attach", "detach"]);
		assert.equal(sessionViewCalls[1].owner, "flow-driver");
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("live driver transcript updates refresh the attached driver widget", async () => {
	let onTranscriptUpdate: (() => void) | undefined;
	let widgetLines = ["initial driver"];
	setFlowDriverSessionFactoryForTests(async (options) => {
		onTranscriptUpdate = options.onTranscriptUpdate;
		return {
			taskId: options.taskId,
			runId: options.runId,
			runDir: options.runDir,
			sessionFile: "driver.jsonl",
			async start() {
				await new Promise(() => {});
			},
			async sendUserInput() {},
			getTranscriptText() {
				return "";
			},
			getWidgetLines() {
				return widgetLines;
			},
			dispose() {},
		};
	});
	try {
		const { pi, commands } = makePi();
		const { ctx, widgets } = makeCtx(makeTempTaskProject("x"));
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove x", ctx);
		await commands.get("flow").handler("attach x/run-001", ctx);
		assert.equal(typeof onTranscriptUpdate, "function");

		widgetLines = ["fresh live line"];
		onTranscriptUpdate!();
		await sleep(0);

		assert.deepEqual(widgets.get("flow-driver-view"), ["fresh live line"]);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("driver focus input delivery failure is handled and marks the run failed", async () => {
	let disposed = false;
	let sendCalls = 0;
	setFlowDriverSessionFactoryForTests(async (options) => ({
		taskId: options.taskId,
		runId: options.runId,
		runDir: options.runDir,
		sessionFile: "driver.jsonl",
		async start() {
			await new Promise(() => {});
		},
		async sendUserInput() {
			sendCalls += 1;
			throw new Error("delivery failed");
		},
		getTranscriptText() {
			return "";
		},
		getWidgetLines() {
			return ["driver"];
		},
		dispose() {
			disposed = true;
		},
	}));
	try {
		const cwd = makeTempTaskProject("x");
		const { pi, commands, handlers } = makePi();
		const { ctx, notifications } = makeCtx(cwd);
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove x", ctx);
		await commands.get("flow").handler("attach x/run-001", ctx);
		let result: unknown;
		await assert.doesNotReject(async () => {
			result = await handlers.get("input")![0]({ text: "先暂停", source: "interactive" }, ctx);
		});

		const runDir = path.join(cwd, ".flow", "tasks", "x", "runs", "run-001");
		const status = readDriverStatus(runDir);
		const feedback = fs.readFileSync(path.join(runDir, "feedback.md"), "utf8");
		assert.deepEqual(result, { action: "handled" });
		assert.equal(status?.status, "failed");
		assert.match(status?.summary ?? "", /delivery failed/);
		assert.match(feedback, /delivery failed/);
		assert.equal(disposed, true);
		assert.equal(notifications.at(-1)?.type, "warning");
		assert.match(notifications.at(-1)?.message ?? "", /delivery failed/);

		await handlers.get("input")![0]({ text: "再试一次", source: "interactive" }, ctx);
		assert.equal(sendCalls, 1);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("live driver lookup disambiguates colliding run ids by task", async () => {
	const sent: string[] = [];
	setFlowDriverSessionFactoryForTests(async (options) => ({
		taskId: options.taskId,
		runId: options.runId,
		runDir: options.runDir,
		sessionFile: `${options.taskId}.jsonl`,
		async start() {
			await new Promise(() => {});
		},
		async sendUserInput(text: string) {
			sent.push(`${options.taskId}:${text}`);
		},
		getTranscriptText() {
			return "";
		},
		getWidgetLines() {
			return [`${options.taskId} driver`];
		},
		dispose() {},
	}));
	try {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flow-task-"));
		writeTempTask(cwd, "task-a");
		writeTempTask(cwd, "task-b");
		const { pi, commands, handlers } = makePi();
		const { ctx } = makeCtx(cwd);
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove task-a --input a", ctx);
		await commands.get("flow").handler("task prove task-b --input b", ctx);
		await commands.get("flow").handler("attach task-a/run-001", ctx);
		const result = await handlers.get("input")![0]({ text: "只发给 task-a", source: "interactive" }, ctx);

		assert.deepEqual(result, { action: "handled" });
		assert.deepEqual(sent, ["task-a:只发给 task-a"]);
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("session_shutdown pauses transient live drivers and disposes them", async () => {
	const disposed: string[] = [];
	setFlowDriverSessionFactoryForTests(async (options) => ({
		taskId: options.taskId,
		runId: options.runId,
		runDir: options.runDir,
		sessionFile: `${options.taskId}.jsonl`,
		async start() {
			await new Promise(() => {});
		},
		async sendUserInput() {},
		getTranscriptText() {
			return "";
		},
		getWidgetLines() {
			return [`${options.taskId} driver`];
		},
		dispose() {
			disposed.push(options.taskId);
		},
	}));
	try {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flow-task-"));
		writeTempTask(cwd, "task-a");
		writeTempTask(cwd, "task-b");
		const { pi, commands, handlers } = makePi();
		const { ctx } = makeCtx(cwd);
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove task-a --input a", ctx);
		await commands.get("flow").handler("task prove task-b --input b", ctx);
		const taskARunDir = path.join(cwd, ".flow", "tasks", "task-a", "runs", "run-001");
		const taskBRunDir = path.join(cwd, ".flow", "tasks", "task-b", "runs", "run-001");
		assert.equal(readDriverStatus(taskARunDir)?.status, "running");
		assert.equal(readDriverStatus(taskBRunDir)?.status, "running");

		for (const handler of handlers.get("session_shutdown") ?? []) {
			await handler();
		}

		assert.deepEqual(disposed.sort(), ["task-a", "task-b"]);
		assert.equal(readDriverStatus(taskARunDir)?.status, "paused");
		assert.match(readDriverStatus(taskARunDir)?.summary ?? "", /session shut down/);
		assert.equal(readDriverStatus(taskBRunDir)?.status, "paused");
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("session_shutdown preserves terminal live driver status", async () => {
	const disposed: string[] = [];
	setFlowDriverSessionFactoryForTests(async (options) => ({
		taskId: options.taskId,
		runId: options.runId,
		runDir: options.runDir,
		sessionFile: "driver.jsonl",
		async start() {},
		async sendUserInput() {},
		getTranscriptText() {
			return "";
		},
		getWidgetLines() {
			return ["driver"];
		},
		dispose() {
			disposed.push(options.taskId);
		},
	}));
	try {
		const cwd = makeTempTaskProject("task-done");
		const { pi, commands, handlers } = makePi();
		const { ctx } = makeCtx(cwd);
		registerFlow(pi as any);

		await commands.get("flow").handler("task prove task-done", ctx);
		const runDir = path.join(cwd, ".flow", "tasks", "task-done", "runs", "run-001");
		writeDriverStatus(runDir, {
			taskId: "task-done",
			runId: "run-001",
			status: "done",
			step: "complete",
			summary: "completed before shutdown",
			sessionFile: "driver.jsonl",
		});

		for (const handler of handlers.get("session_shutdown") ?? []) {
			await handler();
		}

		const status = readDriverStatus(runDir);
		assert.deepEqual(disposed, ["task-done"]);
		assert.equal(status?.status, "done");
		assert.equal(status?.summary, "completed before shutdown");
	} finally {
		setFlowDriverSessionFactoryForTests(undefined);
	}
});

test("driver focus input writes feedback to the focused task when run ids collide", async () => {
	const cwd = makeTempFlowProject([
		{
			taskId: "task-a",
			runId: "run-001",
			status: "running",
			step: "wrong task",
			updatedAt: "2026-06-17T00:00:01.000Z",
		},
		{
			taskId: "task-b",
			runId: "run-001",
			status: "waiting",
			step: "right task",
			updatedAt: "2026-06-17T00:00:02.000Z",
		},
	]);
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("attach task-b/run-001", ctx);
	const result = await handlers.get("input")![0]({ text: "只发给 task-b", source: "interactive" }, ctx);

	const taskAFeedback = fs.readFileSync(
		path.join(cwd, ".flow", "tasks", "task-a", "runs", "run-001", "feedback.md"),
		"utf8",
	);
	const taskBFeedback = fs.readFileSync(
		path.join(cwd, ".flow", "tasks", "task-b", "runs", "run-001", "feedback.md"),
		"utf8",
	);
	assert.deepEqual(result, { action: "handled" });
	assert.equal(taskAFeedback, "# User Feedback\n\n");
	assert.match(taskBFeedback, /只发给 task-b/);
	assert.match(taskBFeedback, /affected step: right task/);
});

test("slash input while focused returns continue and does not append feedback", async () => {
	const cwd = makeTempFlowProject([
		{ taskId: "task-a", runId: "run-001", status: "running", updatedAt: "2026-06-17T00:00:01.000Z" },
	]);
	const { pi, commands, handlers } = makePi();
	const { ctx } = makeCtx(cwd);
	registerFlow(pi as any);

	await commands.get("flow").handler("attach run-001", ctx);
	const result = await handlers.get("input")![0]({ text: "/flow status", source: "interactive" }, ctx);

	const feedback = fs.readFileSync(
		path.join(cwd, ".flow", "tasks", "task-a", "runs", "run-001", "feedback.md"),
		"utf8",
	);
	assert.deepEqual(result, { action: "continue" });
	assert.equal(feedback, "# User Feedback\n\n");
});

test("session_start clears and persists stale focused driver", async () => {
	const cwd = makeTempFlowProject([]);
	const { pi, handlers, entries } = makePi();
	const { ctx, status, widgets } = makeCtx(cwd);
	ctx.sessionManager.getEntries = () => [
		{
			type: "custom",
			customType: "flow-focus",
			data: { focus: "driver", taskId: "task-stale", runId: "run-stale" },
		},
	];
	registerFlow(pi as any);

	await handlers.get("session_start")![0]({ reason: "startup" }, ctx);

	assert.deepEqual(entries.at(-1)?.data, { focus: "main" });
	assert.equal(status.get("flow-driver"), undefined);
	assert.equal(widgets.get("flow-driver-view"), undefined);
});

test("driver commands without drivers notify strings and do not queue hidden prompts", async () => {
	for (const flowCommand of ["attach", "detach", "driver status"]) {
		const cwd = makeTempFlowProject([]);
		const { pi, commands, sentMessages } = makePi();
		const { ctx, notifications } = makeCtx(cwd);
		registerFlow(pi as any);

		await commands.get("flow").handler(flowCommand, ctx);

		assert.equal(notifications.length, 1);
		assert.equal(typeof notifications[0].message, "string");
		assert.doesNotMatch(notifications[0].message, /\[object Object\]/);
		assert.equal(sentMessages.length, 0);
	}
});

test("flow context filter removes stale flow task messages when no request is pending", async () => {
	const { pi, handlers } = makePi();
	registerFlow(pi as any);

	const normalMessage = { role: "user", content: "正常用户消息" };
	const plainMentionMessage = { role: "user", content: "普通用户消息提到 [FLOW TASK RUN] 但不是旧 prompt" };
	const arrayMentionMessage = { role: "user", content: [{ type: "text", text: "说明文字 [FLOW TASK REVIEW]" }] };
	const plainDriverMentionMessage = { role: "user", content: "普通用户消息提到 [FLOW DRIVER ATTACH] 但不是旧 prompt" };
	const arrayDriverMentionMessage = { role: "user", content: [{ type: "text", text: "说明文字 [FLOW DRIVER STATUS]" }] };

	const result = await handlers.get("context")![0]({
		messages: [
			{ customType: "flow-task-context", content: "[FLOW TASK CREATE]", display: false },
			{ role: "user", content: "[FLOW TASK RUN]\nold" },
			{ role: "user", content: "  [FLOW STATUS]\nold status" },
			{ role: "user", content: [{ type: "text", text: "\n[FLOW TASK PROVE]\nold prove" }] },
			{ role: "user", content: "[FLOW DRIVER ATTACH]\nold attach" },
			{ role: "user", content: "  [FLOW DRIVER DETACH]\nold detach" },
			{ role: "user", content: [{ type: "text", text: "\n[FLOW DRIVER STATUS]\nold driver status" }] },
			normalMessage,
			plainMentionMessage,
			arrayMentionMessage,
			plainDriverMentionMessage,
			arrayDriverMentionMessage,
		],
	});

	assert.deepEqual(result.messages, [
		normalMessage,
		plainMentionMessage,
		arrayMentionMessage,
		plainDriverMentionMessage,
		arrayDriverMentionMessage,
	]);
});
