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

test("runtime-handled kinds throw instead of producing a prompt", () => {
	// task-prove/task-run/task-review are early-returned by index.ts command
	// routing and never reach the prompt queue. If they ever do, that is a
	// routing regression — they must throw, not silently return a stale prompt.
	const runtimeHandled = [
		{ kind: "task-prove", taskId: "x", input: "i" },
		{ kind: "task-run", taskId: "x", input: "i" },
		{ kind: "task-review", runId: "run-001" },
	] as const;
	for (const request of runtimeHandled) {
		assert.throws(
			() => buildFlowRequestPrompt(request as never),
			/runtime-handled kind/,
		);
	}
});

test("buildFlowTaskReviewPrompt is the live review gate prompt", () => {
	// buildFlowRequestPrompt's task-review case was dead (early-returned by
	// index.ts); the live prompt is buildFlowTaskReviewPrompt. Lock its content.
	const prompt = buildFlowTaskReviewPrompt({ taskId: "demo-task", runId: "run-001" });

	assert.match(prompt, /\[FLOW TASK REVIEW\]/);
	assert.match(prompt, /Task ID: demo-task/);
	assert.match(prompt, /Run ID: run-001/);
	assert.match(prompt, /不能由 driver subagent 自评/);
	assert.match(prompt, /\.flow\/tasks\/demo-task\/runs\/run-001/);
	assert.match(prompt, /validation\.md/);
	assert.match(prompt, /review\.md/);
	assert.match(prompt, /SKILL\.md/);
	assert.match(prompt, /todo\.template\.md/);
	assert.match(prompt, /validator\.md/);
	assert.match(prompt, /runtime 在 accept 时自动 bump/);
	assert.match(prompt, /你是业务质量的\*\*唯一\*\*关卡/);
	assert.match(prompt, /结构校验/);
	assert.match(prompt, /Task 推进为 ready/);
	assert.match(prompt, /Task 会进入 needs-work/);
	assert.match(prompt, /\/flow task accept run-001/);
	assert.match(prompt, /\/flow task reject run-001/);
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
	assert.match(prompt, /ready/);
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
