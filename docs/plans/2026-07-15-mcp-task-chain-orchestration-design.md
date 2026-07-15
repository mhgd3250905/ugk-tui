# MCP task 链宿主编排设计

## 目标

用户可以把包含并行采集、顺序加工和最终发布的完整 task 链交给 Codex。Codex 负责保存链路进度，UGK 继续只负责执行一个 task 或一个并行批次并做机器验收。

## 数据流

Codex 先把链拆成有依赖关系的阶段。互不依赖的 task 合并为一个 MCP `start`，由 UGK 内部一次 `run_task({ tasks: [...] })` 并行执行；依赖前序产物的 task 等前一阶段 `pass` 后，再使用真实 artifact 绝对路径发起新的 `start`。每次运行沿用现有 `status`、`respond` 和 `cancel` 协议。

## 失败边界

任一阶段返回 `task_failed`、`no_match`、`cancelled` 或 `internal_error`，Codex 停止后续阶段并展示结构化原因。产物路径只能来自 `pass` 结果，不能猜测。publisher、send-email 等有外部副作用的阶段若状态不明，继续查询原 `runId` 或询问用户，不能新建运行盲目重试，避免重复发布或发信。

## 改动范围

只更新 Codex 配套 Skill、MCP server instructions/tool description 和契约测试。保留 gateway 每次运行只允许一次 `run_task` 的限制，不新增任务链引擎、持久化状态或 MCP 工具。
