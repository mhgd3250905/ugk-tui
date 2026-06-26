# 444d204 阶段审核报告与优化方案

## 摘要

- 范围: `main..444d204`, 当前分支 `feat/one-liner-task-dispatch`, `HEAD=444d204`。
- 只读审核: 未修改代码, 审核完成时工作区干净。
- 验证: `npm test` 通过, 514/514; `git diff --check main..HEAD` 无输出。
- 结论: 无 P0; 有 1 个 P1 权限缓存问题, 2 个 P2 参数解析回归/边界问题。

## Findings

### P1: 受保护工具授权缓存 key 过宽

[extensions/task/task.ts](../../extensions/task/task.ts:512) 只按 `taskbook.name` 判断已授权, [extensions/task/task.ts](../../extensions/task/task.ts:523) 批量确认后还会把整批 taskbook 名都加入缓存。

实际授权对象应是"具体 taskbook + 当前 protected tools 集合"。同名 user/project 覆盖、taskbook 编辑后新增工具、或批次里非 protected task 被顺手缓存, 都可能让后续 `UGK_TASK_ALLOW_CHROME_CDP` / `UGK_TASK_ALLOW_MCP_TOOLS` 免确认下发。

优化方案: 缓存 key 改为 `loaded.dir + sortedProtectedToolNames`, 或 `scope:name + sortedProtectedToolNames`; 只缓存实际使用 protected tool 的 taskbook。

### P2: 本地解析到的显式可选字段会被 dispatcher/default 覆盖

[extensions/task/task-dispatcher.ts](../../extensions/task/task-dispatcher.ts:176) dispatcher 成功后直接返回 dispatcher 结果再补 default, 没有合并 local partial。

复现: `https://x, page=2`, local 抽到 `page=2`, dispatcher 返回 `{ "url": "https://x" }`, 最终变成 `{ "url": "https://x", "page": 1 }`。

优化方案: dispatcher 补齐 required 后, 将 deterministic local partial 合入结果, 显式 `field=value` 优先于 dispatcher/default。

### P2: `topN` 原有 headless 本地解析被删除

[extensions/task/task-dispatcher.ts](../../extensions/task/task-dispatcher.ts:119) 移除 `topN` 特例后, dispatcher 不可用时 `帮我查询知乎top3` / `3` 会走到 [extensions/task/task-dispatcher.ts](../../extensions/task/task-dispatcher.ts:190) 抛错。

已复现: `runtimeInput:["topN"]` + `帮我查询知乎top3` 返回解析失败。

优化方案: 恢复仅 `topN` 的确定性本地解析; 不恢复泛化单字段裸值捷径, 除非明确接受绕过 dispatcher 的产品取舍。

## Ponytail 取舍

- 可删/可缩: 删除"必须路由到 dispatcher"的实现路径断言, 改测最终解析行为; prompt 文案 regex 测试可降级为 request/options 结构测试。
- 不建议删: `resetTaskProtectedToolGrantsForTests` 先保留, 模块级 Set 是跨测试状态, 重置钩子比靠唯一名称隔离更稳。
- 不建议大回退: `reasoningEffort:"medium"` 和 dispatcher 唯一路径是当前分支核心判断; 除非成本/延迟成为明确目标, 再考虑恢复泛化单字段本地 shortcut。

## 架构优化

### Strong: 加深 protected-tool grant Module

让授权 Interface 表达"taskbook identity + tool set", Implementation 仍留在 `resolveTaskWorkerEnv`, 不扩大权限模型。

### Strong: 收拢 contract runtimeInput 语义

建一个很小的内部 `task-contract` Module, 移动现有 `runtimeFields/defaults/required/runtimeDefault` 等 helper; 不新增 schema 框架。

### Worth exploring: 让 dispatcher Adapter request 可测

抽 `buildTaskDispatcherRequest(...)` 纯函数, 断言 `reasoningEffort:"medium"`、prompt 规则、messages 形状; `resolveRuntimeInputFromText` Interface 不变。

### Skip: 暂不拆大 `task.ts`

`runTaskWithRetry` 已经提供有效 depth; 现在大拆会制造 hypothetical seam。

## 测试计划

- 新增 grant 缓存测试: 同 taskbook 同工具不重复弹; 同名不同 scope、新增 MCP tool、编辑后新增 protected tool 必须重新确认。
- 新增 dispatcher 测试: `url,page=2` 保留 `page=2`; dispatcher 无 auth 时 `top3` / `3` 仍可解析。
- 回归命令: `node --test tests/task-dispatcher.test.ts tests/subtask-tool.test.ts tests/task-extension.test.ts tests/task-book.test.ts`, 再跑 `npm test`。

