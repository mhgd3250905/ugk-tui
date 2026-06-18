import test from "node:test";
import assert from "node:assert/strict";
import { buildFlowHelpText, buildFlowRequestPrompt, buildFlowTaskReviewPrompt } from "../extensions/flow/prompts.ts";

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

test("builds task prove prompt with driver run instructions", () => {
	const prompt = buildFlowRequestPrompt({
		kind: "task-prove",
		taskId: "x-search-post-collector",
		input: "keyword=Medtrum",
	});

	assert.match(prompt, /\[FLOW TASK PROVE\]/);
	assert.match(prompt, /x-search-post-collector/);
	assert.match(prompt, /keyword=Medtrum/);
	assert.match(prompt, /runs\/run-/);
	assert.match(prompt, /interactive driver|driver/);
	assert.match(prompt, /读取当前 Task 的 `SKILL\.md`/);
	assert.match(prompt, /登记为 proving/);
	assert.match(prompt, /input\.json/);
	assert.match(prompt, /todo\.template\.md/);
	assert.match(prompt, /填写 `todo\.md`/);
	assert.match(prompt, /validator\.md/);
	assert.match(prompt, /validation\.json/);
	assert.match(prompt, /validation\.md/);
	assert.match(prompt, /status\.json/);
	assert.match(prompt, /输出契约不合规/);
	assert.match(prompt, /自动修复/);
	assert.match(prompt, /进入 review/);
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
	assert.match(prompt, /verified\/active\/approved/);
	assert.match(prompt, /interactive driver|driver/);
});

test("builds task review prompt with main-agent review gate", () => {
	const prompt = buildFlowRequestPrompt({ kind: "task-review", runId: "run-001" });

	assert.match(prompt, /\[FLOW TASK REVIEW\]/);
	assert.match(prompt, /run-001/);
	assert.match(prompt, /不能由 driver subagent 自评/);
	assert.match(prompt, /\.flow\/tasks\/<task-id>\/runs\/run-001/);
	assert.match(prompt, /validation\.md/);
	assert.match(prompt, /validation\.json/);
	assert.match(prompt, /review\.json/);
	assert.match(prompt, /status\.json/);
	assert.match(prompt, /feedback\.md/);
	assert.match(prompt, /review\.md/);
	assert.match(prompt, /成功或修复成功/);
	assert.match(prompt, /SKILL\.md/);
	assert.match(prompt, /todo\.template\.md/);
	assert.match(prompt, /validator\.md/);
	assert.match(prompt, /version/);
	assert.match(prompt, /用户只判断业务结果和可复用偏好/);
	assert.match(prompt, /用户说不懂/);
	assert.match(prompt, /先解释/);
	assert.match(prompt, /不要在给用户看的问题里出现/);
	assert.match(prompt, /保存为以后复用的流程/);
	assert.match(prompt, /回复“接受”/);
	assert.match(prompt, /回复“拒绝/);
	assert.match(prompt, /回复“调整/);
	assert.match(prompt, /用户确认/);
	assert.match(prompt, /\/flow task accept run-001/);
	assert.match(prompt, /\/flow task reject run-001/);
	assert.match(prompt, /确认无需修改 Task 资产/);
	assert.match(prompt, /不要手工修改 `task\.json\.status`/);
	assert.match(prompt, /只能通过 `\/flow task accept` 或 `\/flow task reject` 改变 Task 生命周期/);
	assert.doesNotMatch(prompt, /逐环节向用户核对/);
	assert.doesNotMatch(prompt, /更新 Task 状态/);
});

test("builds concrete task review prompt with task and run path", () => {
	const prompt = buildFlowTaskReviewPrompt({ taskId: "readme-extract-summary", runId: "run-001" });

	assert.match(prompt, /\[FLOW TASK REVIEW\]/);
	assert.match(prompt, /Task ID: readme-extract-summary/);
	assert.match(prompt, /Run ID: run-001/);
	assert.match(prompt, /\.flow\/tasks\/readme-extract-summary\/runs\/run-001/);
	assert.match(prompt, /validation\.json/);
	assert.match(prompt, /validation\.md/);
	assert.match(prompt, /review\.json/);
	assert.match(prompt, /用户/);
	assert.match(prompt, /用户只判断业务结果和可复用偏好/);
	assert.match(prompt, /用户说不懂/);
	assert.match(prompt, /先解释/);
	assert.match(prompt, /不要在给用户看的问题里出现/);
	assert.match(prompt, /保存为以后复用的流程/);
	assert.match(prompt, /回复“接受”/);
	assert.match(prompt, /回复“拒绝/);
	assert.match(prompt, /回复“调整/);
	assert.match(prompt, /review\.md/);
	assert.match(prompt, /\/flow task accept run-001/);
	assert.match(prompt, /\/flow task reject run-001/);
	assert.match(prompt, /确认无需修改 Task 资产/);
	assert.match(prompt, /verified/);
	assert.doesNotMatch(prompt, /逐环节向用户核对/);
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

test("builds flow help text", () => {
	const help = buildFlowHelpText();

	assert.match(help, /\/flow task create "目标"/);
	assert.match(help, /\/flow task prove <task-id>/);
	assert.match(help, /\/flow task start <task-id>/);
	assert.match(help, /\/flow task review <task-id>\/<run-id>/);
	assert.match(help, /\/flow task accept <task-id>\/<run-id>/);
	assert.match(help, /确认无需更新/);
	assert.match(help, /\/flow task reject <task-id>\/<run-id>/);
	assert.match(help, /\/flow task delete <task-id>/);
	assert.match(help, /interactive driver|driver/);
	assert.match(help, /\/flow attach/);
	assert.match(help, /\/flow attach <task-id>\/<run-id>/);
	assert.match(help, /\/flow detach/);
	assert.match(help, /\/flow driver status/);
});
