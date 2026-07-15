# Remove Dedicated Task Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 删除 UGK 中“专用 task”的特殊行为，让所有已安装 task 使用同一套发现、选择和执行规则。

**Architecture:** 简化现有 task registry 和菜单，不新增迁移层。旧 `dedicated` 标签继续作为普通字符串被兼容读取，但不再驱动任何行为。

**Tech Stack:** TypeScript、Node.js test runner、UGK pi extensions

---

### Task 1: 用测试定义统一可见性

**Files:**
- Modify: `tests/subtask-tool.test.ts`
- Modify: `tests/task-extension.test.ts`
- Modify: `tests/task-gateway.test.ts`

1. 把“专用 task 被隐藏”的断言改为“旧 dedicated 标签不影响可见性”。
2. 把锁图标测试改为所有选择项只显示 task 名。
3. 删除专用索引和专用切换行为测试。
4. 运行相关测试，确认旧实现使新断言失败。

### Task 2: 删除专用 task 运行时

**Files:**
- Modify: `extensions/task/task-registry.ts`
- Modify: `extensions/task/task.ts`
- Modify: `extensions/task/task-book.ts`

1. `buildTaskbookPrompt` 直接格式化全部 task。
2. 删除专用索引生成、锁图标、切换菜单和 `setTaskbookDedicated`。
3. 运行三个相关测试文件，确认通过。

### Task 3: 更新文档和本机数据

**Files:**
- Modify: `docs/plans/2026-07-15-ugk-mcp-task-gateway-design.md`
- Modify: `docs/plans/2026-07-15-ugk-mcp-task-gateway-implementation.md`
- Modify: `docs/handoff/2026-07-06-ugk-task-authoring-skill.md`
- Modify: `C:/Users/29485/.pi/agent/tasks/*/taskbook.json`

1. 将现行说明改为所有 task 一律可见。
2. 从本机 taskbook 删除 `dedicated` 标签并删除旧 `_dedicated-index.md`。
3. 用 `rg` 确认运行时代码和本机 taskbook 不再包含专用语义。

### Task 4: 完整验证并提交

1. 运行 `npm test`，预期全部通过（允许既有 skip）。
2. 运行 `npm run test:integration`，预期 40/40 通过。
3. 运行 `git diff --check`。
4. 提交为一个聚焦的功能删除提交。
