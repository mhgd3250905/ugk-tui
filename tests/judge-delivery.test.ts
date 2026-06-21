import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	registerJudge,
	setJudgeDecisionSessionFactoryForTests,
	setJudgeDriverFactoryForTests,
	setOpenLiveLogTerminalForTests,
} from "../extensions/judge/judge.ts";
import { buildFinalizePrompt } from "../extensions/judge/judge-prompts.ts";
import { parseJudgeFinalVerdict } from "../extensions/judge/judge-utils.ts";
import { loadTaskbook, readExperienceMd, saveTaskbook, writeExperienceMd } from "../extensions/judge/taskbook.ts";

const noopLiveLogOpener = () => ({ ok: true });

function makePi() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const sentMessages: Array<{ message: any; options?: any }> = [];
	const entries: Array<{ customType: string; data: any }> = [];

	return {
		commands,
		handlers,
		sentMessages,
		entries,
		pi: {
			registerCommand(name: string, options: any) {
				commands.set(name, options);
			},
			registerTool() {},
			setActiveTools() {},
			on(event: string, handler: Function) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			sendMessage(message: any, options?: any) {
				sentMessages.push({ message, options });
			},
			sendUserMessage() {},
			appendEntry(customType: string, data: any) {
				entries.push({ customType, data });
			},
		},
	};
}

function makeCtx(confirmResult: boolean | null = true) {
	setOpenLiveLogTerminalForTests(noopLiveLogOpener);
	const notifications: Array<{ message: string; type?: string }> = [];
	const widgetCalls: Array<{ key: string; content: unknown }> = [];
	const ui: any = {
		notify(message: string, type?: string) {
			notifications.push({ message, type });
		},
		select(title: string, options: string[]) {
			// 过程查看终端菜单:测试默认"不打开"
			if (title.includes("过程查看终端")) return options.find((o) => o.startsWith("不打开")) ?? options[0];
			return options[0];
		},
		editor() {
			return "";
		},
		setWidget(key: string, content: unknown) {
			widgetCalls.push({ key, content });
		},
	};
	if (confirmResult !== null) {
		ui.confirm = () => confirmResult;
	}
	const ctx = {
		hasUI: true,
		mode: "tui",
		sessionManager: {
			getEntries() {
				return [];
			},
		},
		ui,
	};
	return { ctx, notifications, widgetCalls };
}

function assistantWithSpec() {
	return {
		role: "assistant",
		content: [
			{
				type: "text",
				text: `\`\`\`json
{
  "goal": "生成交付文件",
  "hardConstraints": ["必须透明展示过程"],
  "acceptance": ["写出 E:/AII/ugk-core/out/result.md", "展示最终证据"],
  "forbidden": ["跳过用户 ack"],
  "context": "阶段 6"
}
\`\`\``,
			},
		],
	};
}

function assistantSpec() {
	return {
		goal: "生成交付文件",
		hardConstraints: ["必须透明展示过程"],
		acceptance: ["写出 E:/AII/ugk-core/out/result.md", "展示最终证据"],
		forbidden: ["跳过用户 ack"],
		context: "阶段 6",
	};
}

function completedWakeupContext(overrides: any = {}) {
	return {
		reason: "judge_complete",
		summary: {
			pathsTried: [
				{
					toolName: "write",
					argsSummary: "path=E:/AII/ugk-core/out/result.md",
					resultSummary: "ok",
					failed: false,
				},
			],
			artifacts: [{ path: "E:/AII/ugk-core/out/result.md", kind: "file" }],
			turnCount: 2,
			steerCount: 0,
			completed: true,
			...overrides.summary,
		},
		tail: {
			toolCalls: [
				{
					toolName: "write",
					argsSummary: "path=E:/AII/ugk-core/out/result.md",
					resultSummary: "ok",
					failed: false,
				},
			],
			assistantOutput: "已写出 E:/AII/ugk-core/out/result.md",
			...overrides.tail,
		},
		transcript: "[tool] write completed",
		decidePrompt: "decide prompt must not be used for final delivery",
	};
}

function installDecisionSession(finalOutputs: string[], prompts: string[]) {
	setJudgeDecisionSessionFactoryForTests(async () => {
		let listener: ((event: any) => void) | undefined;
		return {
			session: {
				isStreaming: false,
				subscribe(callback: (event: any) => void) {
					listener = callback;
					return () => {};
				},
				async prompt(text: string) {
					prompts.push(text);
					listener?.({
						type: "message_update",
						assistantMessageEvent: {
							type: "text_delta",
							delta: finalOutputs.shift() ?? "",
						},
					});
				},
				async steer() {},
				async followUp() {},
				dispose() {},
			},
		};
	});
}

function restoreAligningTaskbookState(ctx: any, taskbookName: string) {
	ctx.sessionManager.getEntries = () => [
		{
			type: "custom",
			customType: "judge-state",
			data: {
				phase: "aligning",
				spec: null,
				summary: "",
				steerCount: 0,
				maxSteer: 5,
				keepWatching: true,
				taskbookName,
				aligningQuestionnaireUsed: true,
			},
		},
	];
}

async function saveDeliveryTaskbook(cwd: string, options: {
	spec?: ReturnType<typeof assistantSpec>;
	steerHistory?: Array<{ direction: string; reason: string; turnIndex: number }>;
	experience?: string;
} = {}) {
	await saveTaskbook(cwd, "judge", {
		description: "desc",
		spec: options.spec ?? assistantSpec(),
		summary: {
			pathsTried: [],
			artifacts: [],
			runningTools: [],
			turnCount: options.steerHistory?.length ?? 0,
			steerCount: options.steerHistory?.length ?? 0,
			steerHistory: options.steerHistory ?? [],
			completed: true,
		},
	});
	if (options.experience !== undefined) {
		await writeExperienceMd(cwd, "judge", options.experience);
	}
}

test("parseJudgeFinalVerdict parses fenced and bare JSON and rejects malformed input", () => {
	assert.deepEqual(parseJudgeFinalVerdict(`{"status":"pass","reason":"满足验收","evidence":["文件存在"]}`), {
		status: "pass",
		reason: "满足验收",
		evidence: ["文件存在"],
	});
	assert.deepEqual(parseJudgeFinalVerdict("```json\n{\"status\":\"fail\",\"reason\":\"缺证据\",\"evidence\":[\"未展示路径\"]}\n```"), {
		status: "fail",
		reason: "缺证据",
		evidence: ["未展示路径"],
	});
	assert.equal(parseJudgeFinalVerdict("{ nope"), undefined);
	assert.equal(parseJudgeFinalVerdict(`{"status":"pass","reason":"x"}`), undefined);
	assert.equal(parseJudgeFinalVerdict(`{"status":"maybe","reason":"x","evidence":[]}`), undefined);
});

test("buildFinalizePrompt asks Judge to compare every acceptance item", () => {
	const prompt = buildFinalizePrompt(
		`{"acceptance":["写出文件","展示证据"]}`,
		{ pathsTried: [], artifacts: [], turnCount: 1, steerCount: 0, completed: true },
		{ toolCalls: [], assistantOutput: "done" },
	);

	assert.match(prompt, /FINALIZE/);
	assert.match(prompt, /acceptance/);
	assert.match(prompt, /PASS/);
	assert.match(prompt, /FAIL/);
});

test("final PASS displays delivery report and user ack marks Judge done", async () => {
	const { pi, commands, handlers, sentMessages, entries } = makePi();
	const { ctx, widgetCalls } = makeCtx(true);
	const prompts: string[] = [];
	installDecisionSession([
		JSON.stringify({
			status: "pass",
			reason: "全部验收项满足",
			evidence: ["E:/AII/ugk-core/out/result.md 已写出", "pathsTried 显示 write 成功"],
		}),
	], prompts);
	setJudgeDriverFactoryForTests(async (options: any) => ({
		async start() {
			options.onTranscriptUpdate?.();
			await new Promise((resolve) => setTimeout(resolve, 0));
			await options.onWakeup(completedWakeupContext());
		},
		dispose() {},
		getSummary() {
			return completedWakeupContext().summary;
		},
		getWidgetLines() {
			return ["driver delivery visible"];
		},
		getTranscriptText() {
			return "driver delivery visible";
		},
	}));
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire", input: {} }, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setJudgeDecisionSessionFactoryForTests(undefined);
	}

	assert.equal(entries.at(-1)?.data.phase, "done");
	assert.equal(prompts.length, 1);
	assert.match(prompts[0], /JUDGE FINALIZE MODE/);
	const report = sentMessages.map((entry) => entry.message.content).join("\n");
	assert.match(report, /✅ Judge PASS/);
	assert.match(report, /E:\/AII\/ugk-core\/out\/result\.md/);
	assert.match(report, /📦 产出/);
	assert.match(report, /🛣️ 走过的路径\(1 步,steer 0\/5\)/);
	assert.match(report, /pathsTried 显示 write 成功/);
	assert.deepEqual(widgetCalls.at(-1), { key: "judge-driver-view", content: undefined });
});

test("taskbook run injects experience into the driver initial prompt", async () => {
	const { pi, handlers } = makePi();
	const { ctx } = makeCtx(true);
	const tmp = mkdtempSync(path.join(os.tmpdir(), "ugk-taskbook-c-"));
	(ctx as any).cwd = tmp;
	restoreAligningTaskbookState(ctx, "judge");
	await saveDeliveryTaskbook(tmp, {
		spec: {
			goal: "历史目标",
			hardConstraints: ["历史约束"],
			acceptance: ["历史验收"],
			forbidden: [],
			context: "",
		},
		steerHistory: [{ direction: "先补测试", reason: "缺回归", turnIndex: 1 }],
	});
	let initialPrompt = "";
	setJudgeDriverFactoryForTests(async (options: any) => {
		initialPrompt = options.initialPrompt;
		return { async start() {}, dispose() {}, getSummary: () => completedWakeupContext().summary };
	});
	registerJudge(pi as any);

	try {
		await handlers.get("session_start")![0]({ reason: "resume" }, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		rmSync(tmp, { recursive: true, force: true });
	}

	assert.match(initialPrompt, /历史经验\(补充参考,非验收标准\)/);
	assert.match(initialPrompt, /先补测试/);
});

test("taskbook PASS appends run history and refreshes experience", async () => {
	const { pi, handlers } = makePi();
	const { ctx } = makeCtx(true);
	const tmp = mkdtempSync(path.join(os.tmpdir(), "ugk-taskbook-pass-"));
	(ctx as any).cwd = tmp;
	restoreAligningTaskbookState(ctx, "judge");
	await saveDeliveryTaskbook(tmp);
	const prompts: string[] = [];
	installDecisionSession([
		JSON.stringify({ status: "pass", reason: "满足", evidence: ["证据 A"] }),
	], prompts);
	setJudgeDriverFactoryForTests(async (options: any) => ({
		async start() {
			await options.onWakeup(completedWakeupContext({
				summary: {
					steerCount: 1,
					steerHistory: [{ direction: "补齐证据", reason: "证据不足", turnIndex: 2 }],
				},
			}));
		},
		dispose() {},
		getSummary() {
			return completedWakeupContext().summary;
		},
	}));
	registerJudge(pi as any);

	try {
		await handlers.get("session_start")![0]({ reason: "resume" }, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setJudgeDecisionSessionFactoryForTests(undefined);
	}

	const loaded = await loadTaskbook(tmp, "judge");
	assert.equal(loaded?.taskbook.runs.at(-1)?.status, "pass");
	assert.deepEqual(loaded?.taskbook.runs.at(-1)?.evidence, ["证据 A"]);
	assert.match(await readExperienceMd(tmp, "judge"), /补齐证据/);
	rmSync(tmp, { recursive: true, force: true });
});

test("final PASS delivery report prioritizes decision evidence and hides raw logs", async () => {
	const { pi, commands, handlers, sentMessages } = makePi();
	const { ctx } = makeCtx(true);
	const prompts: string[] = [];
	const manyPaths = Array.from({ length: 17 }, (_, index) => ({
		toolName: index === 16 ? "bash" : `tool_${index + 1}`,
		argsSummary: index === 16 ? "command=npm test" : "",
		resultSummary: index === 16
			? "content=[{\"type\":\"text\",\"text\":\"npm test failed because lint failed\"}]"
			: "content=[{\"type\":\"text\",\"text\":\"raw successful tool output\"}]",
		failed: index === 16,
	}));
	installDecisionSession([
		JSON.stringify({
			status: "pass",
			reason: "交付内容满足全部验收条件",
			evidence: ["driver 输出了最终结果摘要", "最后一次失败路径已有明确原因"],
		}),
	], prompts);
	setJudgeDriverFactoryForTests(async (options: any) => ({
		async start() {
			await options.onWakeup(completedWakeupContext({
				summary: {
					pathsTried: manyPaths,
					artifacts: [],
					steerCount: 2,
				},
				tail: {
					assistantOutput: "最终结果摘要: 已完成依赖审计,没有发现高危漏洞。",
				},
			}));
		},
		dispose() {},
		getSummary() {
			return completedWakeupContext().summary;
		},
	}));
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire", input: {} }, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setJudgeDecisionSessionFactoryForTests(undefined);
	}

	const report = sentMessages.map((entry) => entry.message.content).join("\n");
	assert.match(report, /✅ Judge PASS/);
	assert.match(report, /交付内容满足全部验收条件/);
	assert.match(report, /📦 产出/);
	assert.match(report, /driver 未产出文件/);
	assert.match(report, /最终结果摘要: 已完成依赖审计/);
	assert.match(report, /🔍 验收证据/);
	assert.match(report, /driver 输出了最终结果摘要/);
	assert.match(report, /🛣️ 走过的路径\(17 步,steer 2\/5\)/);
	assert.match(report, /中间省略 10 步/);
	assert.match(report, /bash ✗/);
	assert.doesNotMatch(report, /content=\[\{"type":"text"/);
	assert.doesNotMatch(report, /DriverSummary/);
	assert.doesNotMatch(report, /TranscriptTail/);
});

test("final PASS delivery report uses evidence file paths when driver artifacts are empty", async () => {
	const { pi, commands, handlers, sentMessages } = makePi();
	const { ctx } = makeCtx(true);
	const prompts: string[] = [];
	installDecisionSession([
		JSON.stringify({
			status: "pass",
			reason: "交付内容满足全部验收条件",
			evidence: [
				"切片文件存在: E:/AII/TUI/demo/slice_10min.m4a",
				"转录结果存在: E:/AII/TUI/demo/slice_10min_transcript.txt",
				"POSIX 报告存在: /tmp/ugk-demo/report.md",
			],
		}),
	], prompts);
	setJudgeDriverFactoryForTests(async (options: any) => ({
		async start() {
			await options.onWakeup(completedWakeupContext({
				summary: {
					pathsTried: [{ toolName: "judge_complete", argsSummary: "", resultSummary: "ok", failed: false }],
					artifacts: [],
					steerCount: 0,
				},
				tail: { assistantOutput: "" },
			}));
		},
		dispose() {},
		getSummary() {
			return completedWakeupContext().summary;
		},
	}));
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire", input: {} }, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setJudgeDecisionSessionFactoryForTests(undefined);
	}

	const report = sentMessages.map((entry) => entry.message.content).join("\n");
	assert.match(report, /📦 产出/);
	assert.match(report, /E:\/AII\/TUI\/demo\/slice_10min\.m4a/);
	assert.match(report, /E:\/AII\/TUI\/demo\/slice_10min_transcript\.txt/);
	assert.match(report, /\/tmp\/ugk-demo\/report\.md/);
	assert.doesNotMatch(report, /未产出/);
});

test("final PASS without confirm UI can be accepted later with /judge ack", async () => {
	const { pi, commands, handlers, entries } = makePi();
	const { ctx, notifications, widgetCalls } = makeCtx(null);
	const prompts: string[] = [];
	installDecisionSession([
		JSON.stringify({ status: "pass", reason: "满足", evidence: ["文件存在"] }),
	], prompts);
	setJudgeDriverFactoryForTests(async (options: any) => ({
		async start() {
			options.onTranscriptUpdate?.();
			await new Promise((resolve) => setTimeout(resolve, 0));
			await options.onWakeup(completedWakeupContext());
		},
		dispose() {},
		getSummary() {
			return completedWakeupContext().summary;
		},
		getWidgetLines() {
			return ["driver delivery visible"];
		},
		getTranscriptText() {
			return "driver delivery visible";
		},
	}));
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire", input: {} }, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setJudgeDecisionSessionFactoryForTests(undefined);
	}

	assert.equal(entries.at(-1)?.data.phase, "delivering");
	assert.equal(entries.at(-1)?.data.pendingAckStatus, "pass");
	assert.notEqual(entries.at(-1)?.data.phase, "done");
	assert.match(notifications.map((entry) => entry.message).join("\n"), /\/judge ack/);
	assert.deepEqual(widgetCalls.at(-1), { key: "judge-driver-view", content: undefined });

	await commands.get("judge").handler("ack", ctx);

	assert.equal(entries.at(-1)?.data.phase, "done");
	assert.match(notifications.map((entry) => entry.message).join("\n"), /accepted/i);
});

test("rejected final PASS with remaining steer budget returns to driving", async () => {
	const { pi, commands, handlers, entries } = makePi();
	const { ctx, notifications } = makeCtx(false);
	const wakeupResults: any[] = [];
	installDecisionSession([
		JSON.stringify({ status: "pass", reason: "满足", evidence: ["文件存在"] }),
	], []);
	setJudgeDriverFactoryForTests(async (options: any) => ({
		async start() {
			wakeupResults.push(await options.onWakeup(completedWakeupContext()));
		},
		dispose() {},
		getSummary() {
			return completedWakeupContext().summary;
		},
	}));
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire", input: {} }, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setJudgeDecisionSessionFactoryForTests(undefined);
	}

	assert.equal(entries.at(-1)?.data.phase, "driving");
	assert.equal(entries.at(-1)?.data.pendingAckStatus, undefined);
	assert.equal(wakeupResults[0].action, "steer");
	assert.match(wakeupResults[0].direction, /User rejected the PASS delivery/);
	assert.match(notifications.map((entry) => entry.message).join("\n"), /rejected/i);
});

test("/judge ack accepts restored pending PASS delivery without parsing report text", async () => {
	const { pi, commands, handlers, entries } = makePi();
	const { ctx, notifications } = makeCtx(false);
	ctx.sessionManager.getEntries = () => [
		{
			type: "custom",
			customType: "judge-state",
			data: {
				phase: "delivering",
				spec: null,
				summary: "交付报告文案以后可以改,这里故意不包含固定 PASS 首行。",
				steerCount: 0,
				maxSteer: 5,
				keepWatching: false,
				pendingAckStatus: "pass",
			},
		},
	];
	registerJudge(pi as any);

	await handlers.get("session_start")![0]({ reason: "resume" }, ctx);
	await commands.get("judge").handler("ack", ctx);

	assert.equal(entries.at(-1)?.data.phase, "done");
	assert.equal(entries.at(-1)?.data.pendingAckStatus, undefined);
	assert.match(notifications.map((entry) => entry.message).join("\n"), /accepted/i);
});

test("/judge ack on pending PASS sediment runs the taskbook run record (reviewer Blocker fix)", async () => {
	const { pi, commands, handlers, entries } = makePi();
	const { ctx, notifications } = makeCtx(false);
	const tmp = mkdtempSync(path.join(os.tmpdir(), "ugk-taskbook-ack-sediment-"));
	(ctx as any).cwd = tmp;
	// 预置 taskbook + session 重启回来时已处于 pendingAck=pass + 带 pendingTaskbookRun
	await saveDeliveryTaskbook(tmp);
	ctx.sessionManager.getEntries = () => [
		{
			type: "custom",
			customType: "judge-state",
			data: {
				phase: "delivering",
				spec: assistantSpec(),
				summary: "交付报告",
				steerCount: 0,
				maxSteer: 5,
				keepWatching: false,
				pendingAckStatus: "pass",
				pendingTaskbookRun: {
					name: "judge",
					spec: assistantSpec(),
					summary: {
						pathsTried: [],
						artifacts: [],
						runningTools: [],
						turnCount: 1,
						steerCount: 0,
						steerHistory: [],
						completed: true,
					},
					finalVerdict: { status: "pass", reason: "满足", evidence: ["证据 A"] },
				},
				taskbookName: "judge",
				aligningQuestionnaireUsed: true,
			},
		},
	];
	registerJudge(pi as any);

	try {
		await handlers.get("session_start")![0]({ reason: "resume" }, ctx);
		await commands.get("judge").handler("ack", ctx);

		// taskbook 应该记录一次 PASS run(reviewer Blocker 的核心断言)
		const loaded = await loadTaskbook(tmp, "judge");
		assert.equal(loaded?.taskbook.runs.length, 1);
		assert.equal(loaded?.taskbook.runs[0].status, "pass");
		assert.deepEqual(loaded?.taskbook.runs[0].evidence, ["证据 A"]);
		// state 被清成 done,pendingTaskbookRun 也清掉
		assert.equal(entries.at(-1)?.data.phase, "done");
		assert.equal(entries.at(-1)?.data.pendingTaskbookRun, undefined);
		assert.match(notifications.map((entry) => entry.message).join("\n"), /accepted/i);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("final FAIL returns to driving and steers the driver with evidence", async () => {
	const { pi, commands, handlers, entries } = makePi();
	const { ctx } = makeCtx(true);
	const prompts: string[] = [];
	const wakeupResults: any[] = [];
	installDecisionSession([
		JSON.stringify({ status: "fail", reason: "缺少最终证据", evidence: ["没有展示证据"] }),
	], prompts);
	setJudgeDriverFactoryForTests(async (options: any) => ({
		async start() {
			wakeupResults.push(await options.onWakeup(completedWakeupContext()));
		},
		dispose() {},
		getSummary() {
			return completedWakeupContext().summary;
		},
	}));
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire", input: {} }, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setJudgeDecisionSessionFactoryForTests(undefined);
	}

	assert.equal(entries.at(-1)?.data.phase, "driving");
	assert.equal(wakeupResults[0].action, "steer");
	assert.match(wakeupResults[0].direction, /缺少最终证据/);
	assert.match(wakeupResults[0].direction, /没有展示证据/);
});

test("final FAIL at max steer reports status without steering again", async () => {
	const { pi, commands, handlers, entries } = makePi();
	const { ctx, notifications } = makeCtx(true);
	const prompts: string[] = [];
	const wakeupResults: any[] = [];
	installDecisionSession([
		JSON.stringify({ status: "fail", reason: "仍不满足验收", evidence: ["已达纠偏上限"] }),
	], prompts);
	setJudgeDriverFactoryForTests(async (options: any) => ({
		async start() {
			wakeupResults.push(await options.onWakeup(completedWakeupContext({
				summary: { steerCount: 5 },
			})));
		},
		dispose() {},
		getSummary() {
			return completedWakeupContext().summary;
		},
	}));
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		await handlers.get("tool_call")![0]({ toolName: "questionnaire", input: {} }, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setJudgeDecisionSessionFactoryForTests(undefined);
	}

	assert.equal(entries.at(-1)?.data.phase, "delivering");
	assert.equal(wakeupResults[0].action, "pass");
	assert.equal(wakeupResults[0].keepWatching, false);
	assert.match(notifications.map((entry) => entry.message).join("\n"), /仍不满足验收/);

	await commands.get("judge").handler("ack", ctx);

	assert.equal(entries.at(-1)?.data.phase, "delivering");
	assert.match(notifications.map((entry) => entry.message).join("\n"), /PASS/);
});

test("taskbook terminal FAIL appends a fail run without rewriting experience", async () => {
	const { pi, handlers } = makePi();
	const { ctx } = makeCtx(true);
	const tmp = mkdtempSync(path.join(os.tmpdir(), "ugk-taskbook-fail-"));
	(ctx as any).cwd = tmp;
	restoreAligningTaskbookState(ctx, "judge");
	await saveDeliveryTaskbook(tmp, { experience: "original experience" });
	const prompts: string[] = [];
	installDecisionSession([
		JSON.stringify({ status: "fail", reason: "缺少证据", evidence: ["没有文件"] }),
	], prompts);
	setJudgeDriverFactoryForTests(async (options: any) => ({
		async start() {
			await options.onWakeup(completedWakeupContext({ summary: { steerCount: 5 } }));
		},
		dispose() {},
		getSummary() {
			return completedWakeupContext().summary;
		},
	}));
	registerJudge(pi as any);

	try {
		await handlers.get("session_start")![0]({ reason: "resume" }, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setJudgeDecisionSessionFactoryForTests(undefined);
	}

	const loaded = await loadTaskbook(tmp, "judge");
	assert.equal(loaded?.taskbook.runs.at(-1)?.status, "fail");
	assert.equal(loaded?.taskbook.runs.at(-1)?.failReason, "缺少证据");
	assert.equal(await readExperienceMd(tmp, "judge"), "original experience");
	rmSync(tmp, { recursive: true, force: true });
});

test("taskbook FAIL with remaining steer budget does not append a run", async () => {
	const { pi, handlers } = makePi();
	const { ctx } = makeCtx(true);
	const tmp = mkdtempSync(path.join(os.tmpdir(), "ugk-taskbook-resume-"));
	(ctx as any).cwd = tmp;
	restoreAligningTaskbookState(ctx, "judge");
	await saveDeliveryTaskbook(tmp);
	const prompts: string[] = [];
	installDecisionSession([
		JSON.stringify({ status: "fail", reason: "还能修", evidence: ["缺一项"] }),
	], prompts);
	setJudgeDriverFactoryForTests(async (options: any) => ({
		async start() {
			await options.onWakeup(completedWakeupContext({ summary: { steerCount: 0 } }));
		},
		dispose() {},
		getSummary() {
			return completedWakeupContext().summary;
		},
	}));
	registerJudge(pi as any);

	try {
		await handlers.get("session_start")![0]({ reason: "resume" }, ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setJudgeDecisionSessionFactoryForTests(undefined);
	}

	const loaded = await loadTaskbook(tmp, "judge");
	assert.deepEqual(loaded?.taskbook.runs, []);
	rmSync(tmp, { recursive: true, force: true });
});
