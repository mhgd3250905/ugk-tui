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
		"- /flow attach 选择一个正在运行或可恢复的 driver",
		"- /flow attach <run-id> 直接进入指定 driver",
		"- /flow detach 退出当前 driver focus",
		"- /flow driver status 查看 driver focus 和活跃 run",
		"- /flow status 查看 Flow 状态",
	].join("\n");
}

function inputText(input: string | undefined): string {
	return input?.trim() ? input : "无";
}

function buildTaskExecutionPrompt(kind: "task-prove" | "task-run", taskId: string, input: string | undefined): string {
	const title = kind === "task-prove" ? "[FLOW TASK PROVE]" : "[FLOW TASK RUN]";
	const taskPath = `.flow/tasks/${taskId}/task.json`;
	const statusPolicy =
		kind === "task-prove"
			? [
					`- 读取 ${taskPath}；如果 status 是 draft，将本次尝试的任务状态更新为 proving。`,
					"- 创建 `runs/run-<timestamp-or-id>/`，写入 `input.json`，并从 `todo.template.md` 复制生成本次 `todo.md`。",
					"- main agent 使用现有 `subagent` 工具启动 `worker`，让隔离 worker 执行任务主体；main agent 只负责派发和复核。",
					"- worker 必须读取当前 Task 的 `SKILL.md`、`todo.md` 和 `validator.md`，按最优路径逐项执行并填写证据。",
					"- 执行后写入输出、日志、证据、`validation.md` 和 `status.json`。",
					"- 只有 `validator.md` 的验收通过且证据完整，才可把 Task 推进为 verified；否则标记 failed 或 needs-human。",
				]
			: [
					`- 读取 ${taskPath}；如果 status 是 draft，停止执行并提示先运行 \`/flow task prove ${taskId}\`。`,
					"- 如果 status 是 needs-human，停止执行并说明需要用户先完成复盘或补充指导。",
					"- 只有 status 是 verified/active 时，才允许创建新的 `runs/run-<timestamp-or-id>/`。",
					"- 为本次 run 写入 `input.json`，并从 `todo.template.md` 复制生成本次 `todo.md`。",
					"- main agent 使用现有 `subagent` 工具启动 `worker`，让隔离 worker 执行任务主体；main agent 只负责派发和复核。",
					"- worker 必须读取当前 Task 的 `SKILL.md`、`todo.md` 和 `validator.md`，按最优路径逐项执行并填写证据。",
					"- 执行后写入输出、日志、证据、`validation.md` 和 `status.json`。",
				];
	return [
		title,
		"",
		`Task ID: ${taskId}`,
		`用户输入: ${inputText(input)}`,
		"",
		"请按 Flow 原则执行:",
		...statusPolicy,
		"- 填写 `todo.md` 时必须记录原计划、实际执行、偏离旧方案、解决过程、证据和复盘候选，不能只写结论。",
		"- 如果结果是 failed 或 needs-human 且问题未解决，不能写回 skill 或把经验固化为成功流程。",
		"- prove/run 完成后交回 main agent 复核；worker 不负责复盘。",
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
				"- 从用户目标推断稳定、可读、短横线风格的 task id，并创建 `.flow/tasks/<task-id>/`。",
				"- 在 `.flow/tasks/<task-id>/task.json` 写入元数据，包含 `version: 1`、`status: draft`、原始目标和创建时间。",
				"- 在同一目录创建 `SKILL.md`，描述任务边界、输入、最优路径 A/B/C/D、每步注意事项、输出和验收标准。",
				"- 创建 `todo.template.md`，作为后续 prove/run 的执行清单模板，字段覆盖原计划、实际执行、偏离旧方案、解决过程、证据和复盘候选。",
				"- 创建 `input.schema.json` 与 `output.schema.json`，约束输入输出结构。",
				"- 创建 `validator.md`，写清每次 run 必须怎样验收、需要哪些证据、失败如何标记。",
				"- 创建空的 `runs/` 目录，后续每次执行写入 `runs/run-<id>/`。",
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
				`- 定位 \`.flow/tasks/<task-id>/runs/${request.runId}\`；如果只知道 run id，就在 \`.flow/tasks/*/runs/${request.runId}\` 中查找。`,
				"- 检查 run 输入、日志、证据、输出、`todo.md`、`validation.md`、`status.json` 和 `feedback.md`（如果存在）。",
				"- 按 A/B/C/D（`SKILL.md` 的最优路径）逐环节向用户核对，并说明每一环节的证据和风险。",
				"- 把复盘问答、是否修改旧方案、修正过程和用户确认结果写入 `review.md`。",
				"- 只有 run 成功或修复成功，并且用户确认后，才能把经验写回 `SKILL.md`、`todo.template.md`、`validator.md`。",
				"- 写回成功经验时必须 bump `task.json` 的 `version`，记录变更原因，并更新 Task 状态。",
				"- failed/needs-human 未解决时不能写回 skill，也不能把 Task 推进为可复用状态。",
				"- 需要用户确认后，才能把复盘结论写回 Task 状态或更新 `SKILL.md`。",
			].join("\n");
		case "status":
			return [
				"[FLOW STATUS]",
				"",
				"请读取 .flow/tasks 下的 Task 和 run 状态，输出简洁表格。",
				"表格列必须包含：task id、status、version、最近 run、下一步建议。",
				"如果 .flow/tasks 不存在，说明当前项目还没有 Flow Task，并提示：/flow task create \"目标\"。",
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
