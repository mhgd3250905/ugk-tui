import test from "node:test";
import assert from "node:assert/strict";
import {
	registerJudge,
	setJudgeDecisionSessionFactoryForTests,
	setJudgeDriverFactoryForTests,
} from "../extensions/judge/judge.ts";
import { buildFinalizePrompt } from "../extensions/judge/judge-prompts.ts";
import { parseJudgeFinalVerdict } from "../extensions/judge/judge-utils.ts";

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

function makeCtx(confirmResult = true) {
	const notifications: Array<{ message: string; type?: string }> = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		sessionManager: {
			getEntries() {
				return [];
			},
		},
		ui: {
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
			select(_title: string, options: string[]) {
				return options[0];
			},
			editor() {
				return "";
			},
			confirm() {
				return confirmResult;
			},
		},
	};
	return { ctx, notifications };
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
	const { ctx } = makeCtx(true);
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
			await options.onWakeup(completedWakeupContext());
		},
		dispose() {},
		getSummary() {
			return completedWakeupContext().summary;
		},
	}));
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setJudgeDecisionSessionFactoryForTests(undefined);
	}

	assert.equal(entries.at(-1)?.data.phase, "done");
	assert.equal(prompts.length, 1);
	assert.match(prompts[0], /JUDGE FINALIZE MODE/);
	const report = sentMessages.map((entry) => entry.message.content).join("\n");
	assert.match(report, /PASS/);
	assert.match(report, /E:\/AII\/ugk-core\/out\/result\.md/);
	assert.match(report, /pathsTried/);
	assert.match(report, /artifacts/);
	assert.match(report, /pathsTried 显示 write 成功/);
});

test("final PASS without user ack can be accepted later with /judge ack", async () => {
	const { pi, commands, handlers, entries } = makePi();
	const { ctx, notifications } = makeCtx(false);
	const prompts: string[] = [];
	installDecisionSession([
		JSON.stringify({ status: "pass", reason: "满足", evidence: ["文件存在"] }),
	], prompts);
	setJudgeDriverFactoryForTests(async (options: any) => ({
		async start() {
			await options.onWakeup(completedWakeupContext());
		},
		dispose() {},
		getSummary() {
			return completedWakeupContext().summary;
		},
	}));
	registerJudge(pi as any);

	try {
		await commands.get("judge").handler("", ctx);
		await handlers.get("agent_end")![0]({ messages: [assistantWithSpec()] }, ctx);
	} finally {
		setJudgeDriverFactoryForTests(undefined);
		setJudgeDecisionSessionFactoryForTests(undefined);
	}

	assert.equal(entries.at(-1)?.data.phase, "delivering");
	assert.notEqual(entries.at(-1)?.data.phase, "done");
	assert.match(notifications.map((entry) => entry.message).join("\n"), /\/judge ack/);

	await commands.get("judge").handler("ack", ctx);

	assert.equal(entries.at(-1)?.data.phase, "done");
	assert.match(notifications.map((entry) => entry.message).join("\n"), /accepted/i);
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
