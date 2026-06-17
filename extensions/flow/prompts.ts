import type { FlowRequest } from "./types.ts";

export function buildFlowHelpText(): string {
	return [
		"[FLOW HELP]",
		"",
		"可用命令:",
		'- /flow task create "目标" 生成一个 draft Task 草案',
		"- /flow task prove <task-id> [--input <inline-input>] 使用 subagent worker 证明 Task 可运行",
		"- /flow run <task-id> [--input <inline-input>] 运行已证明的 Task",
		"- /flow task review <run-id> 由 main agent 主持复盘并等待用户确认",
		"- /flow status 查看 Flow 状态",
	].join("\n");
}

function inputText(input: string | undefined): string {
	return input?.trim() ? input : "无";
}

function buildTaskExecutionPrompt(kind: "task-prove" | "task-run", taskId: string, input: string | undefined): string {
	const title = kind === "task-prove" ? "[FLOW TASK PROVE]" : "[FLOW TASK RUN]";
	return [
		title,
		"",
		`Task ID: ${taskId}`,
		`用户输入: ${inputText(input)}`,
		"",
		"请按 Flow 原则执行:",
		"- 由 driver 调起 subagent worker 执行，不要让 driver 自己完成任务主体。",
		"- 读取当前 Task 的 `SKILL.md`，按其中的输入、流程和验收标准工作。",
		"- 基于 `.flow/tasks/<task-id>/todo.template.md` 填写 `todo.md`，记录实际步骤和证据。",
		"- 为本次尝试创建 `runs/run-<timestamp-or-id>/`，保存输入、输出、日志、证据和状态。",
		"- 如果结果是 failed 或 needs-human 且问题未解决，不能写回 skill 或把经验固化为成功流程。",
		"- prove/run 完成后交回 main agent 复核；driver 不负责复盘。",
	].join("\n");
}

export function buildFlowRequestPrompt(request: FlowRequest): string {
	switch (request.kind) {
		case "task-create":
			return [
				"[FLOW TASK CREATE]",
				"",
				`用户自然语言目标: ${request.goal}`,
				"",
				"请创建 Flow Task 草案:",
				"- 只生成 draft，不要执行任务本体。",
				"- 在 `.flow/tasks/<task-id>/task.json` 写入元数据，包含 `status` 且值为 `draft`。",
				"- 在同一目录创建 `SKILL.md`，描述任务边界、输入、流程、输出和验收标准。",
				"- 创建 `todo.template.md`，作为后续 run/prove 的执行清单模板。",
				"- 不要把 Task 标记为 active；只有 prove/review 通过并经用户确认后才可推进。",
				"- 最后提示用户下一步运行 `/flow task prove <task-id>`。",
			].join("\n");
		case "task-prove":
			return buildTaskExecutionPrompt("task-prove", request.taskId, request.input);
		case "task-run":
			return buildTaskExecutionPrompt("task-run", request.taskId, request.input);
		case "task-review":
			return [
				"[FLOW TASK REVIEW]",
				"",
				`Run ID: ${request.runId}`,
				"",
				"请由 main agent 主持复盘:",
				"- 不能由 driver subagent 自评，也不能让执行该 run 的 worker 自评。",
				"- 检查 run 输入、日志、证据、输出和 `todo.md`。",
				"- 按 A/B/C/D（`SKILL.md` 的最优路径）逐环节向用户核对，并说明每一环节的证据和风险。",
				"- failed/needs-human 未解决时不能写回 skill，也不能把 Task 推进为可复用状态。",
				"- 需要用户确认后，才能把复盘结论写回 Task 状态或更新 `SKILL.md`。",
			].join("\n");
		case "status":
			return [
				"[FLOW STATUS]",
				"",
				"请读取 `.flow/` 下的 Task 和 run 状态，汇总 draft、active、failed、needs-human 与待 review 项。",
			].join("\n");
		case "help":
			return buildFlowHelpText();
		case "error":
			return request.message;
		default: {
			const exhaustive: never = request;
			return exhaustive;
		}
	}
}
