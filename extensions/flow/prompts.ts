import type { FlowRequest } from "./types.ts";

export function buildFlowHelpText(): string {
	return [
		"[FLOW HELP]",
		"",
		"可用命令:",
		'- /flow task create "目标" 生成一个 draft Task 草案',
		"- /flow task prove <task-id> [--input <inline-input>] 启动 interactive driver 证明 Task 可运行",
		"- /flow run <task-id> [--input <inline-input>] 启动 interactive driver 运行已证明的 Task",
		"- /flow task start <task-id> [--input <inline-input>] 同 /flow run，用于再次执行已批准 Task",
		"- /flow task review <task-id>/<run-id> 由 main agent 主持复盘并等待用户确认",
		"- /flow task accept <task-id>/<run-id> 用户确认且 Task 设计已更新或确认无需更新后接受 review，推进 Task 为 verified",
		"- /flow task reject <task-id>/<run-id> [reason] 驳回 review，标记 Task 需要修正",
		"- /flow task delete <task-id> 删除 Task 和它的所有历史 run",
		"- /flow attach 选择一个正在运行或可恢复的 driver",
		"- /flow attach <run-id> 或 /flow attach <task-id>/<run-id> 直接进入指定 driver",
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
					`- 读取 ${taskPath}；runtime 已将本次尝试登记为 proving。`,
					"- 创建 `runs/run-<timestamp-or-id>/`，写入 `input.json`，并从 `todo.template.md` 复制生成本次 `todo.md`。",
					"- 启动 interactive driver session 执行任务主体；Flow runtime 负责创建 run、维护状态和转发 driver focus 输入。",
					"- driver 必须读取当前 Task 的 `SKILL.md`、`todo.md` 和 `validator.md`，按最优路径逐项执行并填写证据。",
					"- 执行后写入输出、日志、证据和 progress；不要写入或修改 `status.json`、`validation.json` 或 `validation.md`。",
					"- Flow runtime 会在 driver 完成后生成 validation 产物；输出契约不合规时 runtime 会要求 driver 自动修复，合规后才进入 review。",
				]
			: [
					`- 读取 ${taskPath}；如果 status 是 draft，停止执行并提示先运行 \`/flow task prove ${taskId}\`。`,
					"- 如果 status 是 needs-human，停止执行并提示重新 prove；不要让用户处理内部输出契约。",
					"- 只有 status 是 verified/active/approved 时，才允许创建新的 `runs/run-<timestamp-or-id>/`。",
					"- 为本次 run 写入 `input.json`，并从 `todo.template.md` 复制生成本次 `todo.md`。",
					"- 启动 interactive driver session 执行任务主体；Flow runtime 负责创建 run、维护状态和转发 driver focus 输入。",
					"- driver 必须读取当前 Task 的 `SKILL.md`、`todo.md` 和 `validator.md`，按最优路径逐项执行并填写证据。",
					"- 执行后写入输出、日志、证据和 progress；不要写入或修改 `status.json`、`validation.json` 或 `validation.md`。",
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
		"- 如果结果是 failed 或被 review reject 且问题未解决，不能写回 skill 或把经验固化为成功流程。",
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
				"- 检查 run 输入、日志、证据、输出、`todo.md`、`validation.md`、`validation.json`、`review.json`、`status.json` 和 `feedback.md`（如果存在）。",
				"- 用户只判断业务结果和可复用偏好；内部文件、schema、input、evidence 粒度和 lifecycle 字段由 agent/runtime 自己修复和复验。",
				"- 向用户汇报本次结果是否可接受、是否要把这次成功步骤保存为以后复用的流程、哪些阈值/口径需要调整；不要把用户当开发者。",
				"- 不要在给用户看的问题里出现 output/result.json、schema、evidence、driver、Task skill、run、review.json、validation.json、SKILL.md、validator.md、task.json 等内部术语。",
				"- 给用户明确动作：回复“接受”表示结果满意并保存为以后复用的流程；回复“拒绝：原因”表示结果不满意；回复“调整：内容”表示先按用户要求修改口径或流程。",
				"- 如果用户说不懂，先解释这个问题和用户决策有什么关系，再给出可选的业务判断；不能跳过或替用户沉默处理。",
				"- 把复盘问答、是否修改旧方案、修正过程和用户确认结果写入 `review.md`。",
				"- 只有 run 成功或修复成功，并且用户确认后，才能把经验写回 `SKILL.md`、`todo.template.md`、`validator.md`。",
				"- 写回成功经验时必须 bump `task.json` 的 `version`，记录变更原因；不要手工修改 `task.json.status`。",
				`- 用户确认并完成写回，或确认无需修改 Task 资产后，调用 \`/flow task accept ${request.runId}\`；否则 \`/flow run\` 会被 runtime 拦截。`,
				`- 如果用户不同意或证据不足，调用 \`/flow task reject ${request.runId} "原因"\`，并说明需要重新 prove。`,
				"- failed 或被 review reject 且问题未解决时不能写回 skill，也不能把 Task 推进为可复用状态。",
				"- review 结论只能通过 `/flow task accept` 或 `/flow task reject` 改变 Task 生命周期；main 只负责更新 Task 设计资产。",
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
			// task-accept/task-reject/task-delete/attach/detach/driver-status 这些 kind
			// 在 index.ts 命令路由里已被提前 return 处理,不会走到 prompt 队列。
			// 若真到此分支,说明命令路由出了回归——显式抛错而非静默。
			const kind = (request as { kind?: string }).kind ?? "unknown";
			throw new Error(`buildFlowRequestPrompt received a runtime-handled kind: ${kind}`);
		}
	}
}

export function buildFlowTaskReviewPrompt(args: { taskId: string; runId: string }): string {
	const runPath = `.flow/tasks/${args.taskId}/runs/${args.runId}`;
	return [
		"[FLOW TASK REVIEW]",
		"",
		`Task ID: ${args.taskId}`,
		`Run ID: ${args.runId}`,
		`Run path: ${runPath}`,
		"",
		"请由 main agent 主持复盘:",
		"- 不能由 driver subagent 自评，也不能让执行该 run 的 worker 自评。",
		`- 检查 ${runPath}/input.json、output/result.json、evidence/、todo.md、progress.md、validation.md、validation.json、review.json、status.json 和 feedback.md。`,
		"- 先向用户汇报 runtime validation 结论；用户只判断业务结果和可复用偏好。",
		"- 只问用户能理解和能决定的问题：结果是否可接受、是否要把这次成功步骤保存为以后复用的流程、输出口径或阈值是否要调整。",
		"- 内部文件、schema、input、evidence 粒度和 lifecycle 字段由 agent/runtime 自己修复和复验，不要让用户理解这些内部契约。",
		"- 不要在给用户看的问题里出现 output/result.json、schema、evidence、driver、Task skill、run、review.json、validation.json、SKILL.md、validator.md、task.json 等内部术语。",
		"- 给用户明确动作：回复“接受”表示结果满意并保存为以后复用的流程；回复“拒绝：原因”表示结果不满意；回复“调整：内容”表示先按用户要求修改口径或流程。",
		"- 如果用户说不懂，先解释这个问题和用户决策有什么关系，再给出可选的业务判断；不能跳过或替用户沉默处理。",
		"- 把复盘问答、是否修改旧方案、修正过程和用户确认结果写入 `review.md`。",
		"- 只有 run 成功或修复成功，并且用户确认后，才能把经验写回 `SKILL.md`、`todo.template.md`、`validator.md` 或 schema。",
		"- 写回成功经验时必须 bump `task.json.version`，记录变更原因；不要手工把 Task 标记为可运行。",
		`- 用户确认并完成写回，或确认无需修改 Task 资产后，调用 \`/flow task accept ${args.runId}\`；runtime 会写入 accepted review 并把 Task 推进为 verified。`,
		`- 如果用户不同意或证据不足，调用 \`/flow task reject ${args.runId} "原因"\`，Task 会进入 needs-human。`,
		"- failed 或被 review reject 且问题未解决时不能写回 skill，也不能把 Task 推进为可复用状态。",
	].join("\n");
}

export function buildFlowDriverContractRepairPrompt(args: {
	kind: "prove" | "run";
	taskId: string;
	runId: string;
	issues: string[];
	summary: string;
}): string {
	const runPath = `.flow/tasks/${args.taskId}/runs/${args.runId}`;
	return [
		"[FLOW DRIVER CONTRACT REPAIR]",
		"",
		`Phase: ${args.kind}`,
		`Task ID: ${args.taskId}`,
		`Run ID: ${args.runId}`,
		`Run path: ${runPath}`,
		"",
		"Runtime gate failed. This is an internal Flow output contract issue; do not ask the user what to do.",
		`Summary: ${args.summary}`,
		"",
		"Issues:",
		...args.issues.map((issue) => `- ${issue}`),
		"",
		"Repair requirements:",
		`- Write a valid ${runPath}/output/result.json object that satisfies output.schema.json if present.`,
		`- Ensure ${runPath}/evidence/ contains at least one non-empty evidence file.`,
		`- Ensure ${runPath}/progress.md exists and reflects the actual repair work.`,
		"- Preserve useful existing artifacts such as report.md, screenshots, logs, or raw JSON; summarize them in result.json instead of deleting them.",
		"- Do not modify status.json, validation.json, validation.md, SKILL.md, todo.template.md, or validator.md.",
		"- After repairing the files, stop. Flow runtime will re-run validation.",
	].join("\n");
}

export function buildFlowTaskContractRepairPrompt(args: {
	taskId: string;
	issues: string[];
}): string {
	const taskPath = `.flow/tasks/${args.taskId}`;
	return [
		"[FLOW TASK CONTRACT REPAIR]",
		"",
		`Task ID: ${args.taskId}`,
		`Task path: ${taskPath}`,
		"",
		"Runtime gate failed. This is an internal Flow task-asset contract issue; do not ask the user what to do.",
		"",
		"Issues:",
		...args.issues.map((issue) => `- ${issue}`),
		"",
		"Repair requirements:",
		`- Ensure ${taskPath}/task.json is valid JSON with id, version, and status.`,
		`- Ensure ${taskPath}/SKILL.md describes task boundary, input, execution paths, output, and validation rules.`,
		`- Ensure ${taskPath}/todo.template.md contains the reusable run checklist.`,
		`- Ensure ${taskPath}/validator.md defines how runtime/user review should validate evidence and result quality.`,
		`- Ensure ${taskPath}/input.schema.json is a JSON object schema.`,
		`- Ensure ${taskPath}/output.schema.json is a JSON object schema for output/result.json.`,
		"- Do not run the task body. Only repair the Task assets.",
		"- After repairing the files, stop. Flow runtime will re-run this gate.",
	].join("\n");
}
