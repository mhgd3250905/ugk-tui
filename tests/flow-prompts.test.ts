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
	assert.match(prompt, /input\.schema\.json/);
	assert.match(prompt, /output\.schema\.json/);
	assert.match(prompt, /validator\.md/);
	assert.match(prompt, /runs\//);
	assert.match(prompt, /task id/);
	assert.match(prompt, /status/);
	assert.match(prompt, /draft/);
	assert.match(prompt, /version/);
	assert.match(prompt, /1/);
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
	assert.match(prompt, /main agent 使用现有 `subagent` 工具启动 `worker`/);
	assert.match(prompt, /读取当前 Task 的 `SKILL\.md`/);
	assert.match(prompt, /更新为 proving/);
	assert.match(prompt, /input\.json/);
	assert.match(prompt, /todo\.template\.md/);
	assert.match(prompt, /填写 `todo\.md`/);
	assert.match(prompt, /validator\.md/);
	assert.match(prompt, /validation\.md/);
	assert.match(prompt, /status\.json/);
	assert.match(prompt, /verified/);
});

test("builds task run prompt with status guards", () => {
	const prompt = buildFlowRequestPrompt({
		kind: "task-run",
		taskId: "x-search-post-collector",
		input: "keyword=Medtrum",
	});

	assert.match(prompt, /\[FLOW TASK RUN\]/);
	assert.match(prompt, /读取 \.flow\/tasks\/x-search-post-collector\/task\.json/);
	assert.match(prompt, /status 是 draft/);
	assert.match(prompt, /\/flow task prove x-search-post-collector/);
	assert.match(prompt, /status 是 needs-human/);
	assert.match(prompt, /verified\/active/);
	assert.match(prompt, /main agent 使用现有 `subagent` 工具启动 `worker`/);
});

test("builds task review prompt with main-agent review gate", () => {
	const prompt = buildFlowRequestPrompt({ kind: "task-review", runId: "run-001" });

	assert.match(prompt, /\[FLOW TASK REVIEW\]/);
	assert.match(prompt, /run-001/);
	assert.match(prompt, /不能由 driver subagent 自评/);
	assert.match(prompt, /\.flow\/tasks\/<task-id>\/runs\/run-001/);
	assert.match(prompt, /validation\.md/);
	assert.match(prompt, /status\.json/);
	assert.match(prompt, /feedback\.md/);
	assert.match(prompt, /review\.md/);
	assert.match(prompt, /成功或修复成功/);
	assert.match(prompt, /SKILL\.md/);
	assert.match(prompt, /todo\.template\.md/);
	assert.match(prompt, /validator\.md/);
	assert.match(prompt, /version/);
	assert.match(prompt, /按 A\/B\/C\/D/);
	assert.match(prompt, /逐环节向用户核对/);
	assert.match(prompt, /用户确认/);
});

test("builds status prompt", () => {
	const prompt = buildFlowRequestPrompt({ kind: "status" });

	assert.match(prompt, /\[FLOW STATUS\]/);
	assert.match(prompt, /读取 \.flow\/tasks/);
	assert.match(prompt, /task id/);
	assert.match(prompt, /status/);
	assert.match(prompt, /下一步建议/);
	assert.match(prompt, /\/flow task create "目标"/);
});

test("builds placeholder prompts for parsed driver commands", () => {
	const attachPrompt = buildFlowRequestPrompt({ kind: "attach" });
	assert.equal(typeof attachPrompt, "string");
	assert.match(attachPrompt, /attach/);

	const detachPrompt = buildFlowRequestPrompt({ kind: "detach" });
	assert.equal(typeof detachPrompt, "string");
	assert.match(detachPrompt, /detach/);

	const statusPrompt = buildFlowRequestPrompt({ kind: "driver-status" });
	assert.equal(typeof statusPrompt, "string");
	assert.match(statusPrompt, /driver status/);
});

test("builds flow help text", () => {
	const help = buildFlowHelpText();

	assert.match(help, /\/flow task create "目标"/);
	assert.match(help, /\/flow task prove <task-id>/);
	assert.match(help, /\/flow attach/);
	assert.match(help, /\/flow detach/);
	assert.match(help, /\/flow driver status/);
});
