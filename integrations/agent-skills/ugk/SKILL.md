---
name: ugk
description: Use UGK's verified local tasks through its MCP gateway. Use only when the user explicitly asks to use UGK, asks to install or configure UGK, or wants to continue an existing UGK runId. Do not use for ordinary tasks that do not mention UGK.
---

# UGK

Use UGK only as an executor for existing, machine-verified tasks. 普通任务不自动交给 UGK；没有匹配 task 时让 UGK 返回 `no_match`，不要把它当成通用 agent。

## Workflow

1. 只响应用户明确的 UGK 意图。不能仅因为任务可重复就自行触发。
2. 取得用户当前项目的 workspace。必须传当前项目的绝对 `cwd`，不能使用 MCP server 自己的目录。
3. 从已知对话整理最小、自包含的 `request`，保留用户已经给出的目标、限制、时间范围和输出格式；不要转发整段对话或补造需求。
4. 阅读当前宿主的安装说明。Codex 使用 [references/codex.md](references/codex.md)。
5. 检查安装和配置。MCP 尚不可用时执行 `ugk mcp doctor --json`；连接后用不带 `runId` 的 `status`。按返回的 `code` 和 `nextAction` 处理。
6. 用 `cwd` 和 `request` 调用 `start`，保存 `runId`，再调用 `status`，直到结束或出现交互。
7. 遇到 `needs_input` 或 `needs_approval`，用用户能理解的话展示问题。把用户回答通过 `respond` 回传；用户拒绝或要求停止时调用 `cancel`。不能代替用户编造回答或授权。
8. 解释结构化结果：`pass` 报告 task 和产物；`no_match` 说明没有适用的现有 task；`task_failed` 展示 `code`、`stage`、尝试次数、验收失败和建议动作；`internal_error` 是网关或运行时故障，不是 task 结果。
9. 最多自动纠错一次，而且新 `request` 必须有实质变化并来自已知用户上下文。不要用相同或只改写措辞的 request 重试；没有新信息时停止并解释。

## Task chains

用户给出多个 task 的完整链路时，由宿主 agent 保存编排进度；UGK 的一次运行仍只执行一个 task 或一个并行批次。旧 TUI 提示里的 `run_task(...)` 是阶段定义，宿主不要直接调用它，而要转换成 `ugk` 的 `start` → `status` 流程。

- 不要把整条链放进一个 `request`。先按产物依赖拆成阶段。
- 互不依赖的 task 合并成一个并行批次，用一次 `start` 交给 UGK；存在依赖的 task 必须等前一阶段终态后，用新的 `start` 运行。
- 只有 `pass` 结果里的 artifact 绝对路径可以传给下一阶段，不能猜测或沿用提示中的占位路径。
- 任一阶段返回 `task_failed`、`no_match`、`cancelled` 或 `internal_error` 时停止链路，报告该阶段的结构化结果，不继续下游 task。
- publisher、send-email 等有外部副作用的阶段若状态不明，继续查询同一 `runId` 或询问用户；不要新建运行重新执行，避免重复发布或发送。

## Credential safety

- 不要读取包含 API key 的文件内容到 agent 上下文。
- 不要把 API key 放进命令参数；只把本机 key 文件路径交给 UGK 的导入命令。
- 不要回显、转述或记录 API key。
- 需要凭据时，让用户在本机创建私有文件；取得同意后运行 `ugk auth import --provider deepseek --file <path>`，再重新执行 doctor。
