import test from "node:test";
import assert from "node:assert/strict";
import { buildFlowHelpText, buildFlowRequestPrompt } from "../extensions/flow/prompts.ts";

test("builds task create prompt with draft task instructions", () => {
	const goal = "用户自然语言目标";
	const prompt = buildFlowRequestPrompt({ kind: "task-create", goal });

	assert.match(prompt, /\[FLOW TASK CREATE\]/);
	assert.match(prompt, new RegExp(goal));
	assert.match(prompt, /\.flow\/tasks\/<task-id>\/task\.json/);
	assert.match(prompt, /SKILL\.md/);
	assert.match(prompt, /todo\.template\.md/);
	assert.match(prompt, /status/);
	assert.match(prompt, /draft/);
	assert.match(prompt, /不要把 Task 标记为 active/);
	assert.match(prompt, /\/flow task prove <task-id>/);
});

test("builds task prove prompt with worker run instructions", () => {
	const prompt = buildFlowRequestPrompt({
		kind: "task-prove",
		taskId: "x-search-post-collector",
		input: "keyword=Medtrum",
	});

	assert.match(prompt, /\[FLOW TASK PROVE\]/);
	assert.match(prompt, /x-search-post-collector/);
	assert.match(prompt, /keyword=Medtrum/);
	assert.match(prompt, /runs\/run-/);
	assert.match(prompt, /subagent/);
	assert.match(prompt, /worker/);
	assert.match(prompt, /读取当前 Task 的 `SKILL\.md`/);
	assert.match(prompt, /填写 `todo\.md`/);
});

test("builds task review prompt with main-agent review gate", () => {
	const prompt = buildFlowRequestPrompt({ kind: "task-review", runId: "run-001" });

	assert.match(prompt, /\[FLOW TASK REVIEW\]/);
	assert.match(prompt, /run-001/);
	assert.match(prompt, /不能由 driver subagent 自评/);
	assert.match(prompt, /按 A\/B\/C\/D/);
	assert.match(prompt, /逐环节向用户核对/);
	assert.match(prompt, /用户确认/);
});

test("builds status prompt", () => {
	assert.match(buildFlowRequestPrompt({ kind: "status" }), /\[FLOW STATUS\]/);
});

test("builds flow help text", () => {
	const help = buildFlowHelpText();

	assert.match(help, /\/flow task create "目标"/);
	assert.match(help, /\/flow task prove <task-id>/);
});
