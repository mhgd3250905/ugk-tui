# MCP Task Chain Orchestration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 教会 Codex 和其他 MCP 宿主把 task 链拆成多次 UGK 运行，同时保留 UGK 的单次原子执行边界。

**Architecture:** 宿主保存编排状态，互不依赖的 task 作为一个并行批次，依赖阶段分别调用 `start`。只修改 Skill 和 MCP 说明，不修改 gateway/RPC 执行逻辑。

**Tech Stack:** Markdown Skill、MCP JavaScript server、Node.js test runner。

---

### Task 1: 用测试固定 task 链编排契约

**Files:**
- Modify: `tests/ugk-host-skill.test.ts`
- Modify: `tests/ugk-mcp-server.test.ts`

**Step 1: Write the failing tests**

新增断言，要求 Skill 和 MCP tool description 明确：整条链不能放进一个 request；独立 task 用一个并行批次；依赖阶段多次 `start`；只传递 PASS artifact；状态不明时不重复执行外部副作用阶段。

**Step 2: Run tests to verify they fail**

Run: `node --test tests/ugk-host-skill.test.ts tests/ugk-mcp-server.test.ts`

Expected: FAIL，因为现有 Skill 和 MCP 说明没有 task 链规则。

### Task 2: 写入最小编排说明

**Files:**
- Modify: `integrations/agent-skills/ugk/SKILL.md`
- Modify: `mcp/server.js`

**Step 1: Update the Skill**

增加 `Task chains` 小节：宿主拆阶段；独立 task 合并为一个并行批次；依赖 task 分别 `start`；等待终态并传递真实 artifact；失败即停；外部副作用状态不明不重跑。

**Step 2: Update MCP guidance**

在 tool description 和 server instructions 中加入同一条短规则，让没有安装 Skill 的 MCP 宿主也不会把整条链塞入一次运行。

**Step 3: Run targeted tests**

Run: `node --test tests/ugk-host-skill.test.ts tests/ugk-mcp-server.test.ts`

Expected: PASS。

### Task 3: 回归、安装和提交

**Files:**
- Install copy: `C:/Users/29485/.codex/skills/ugk/`

**Step 1: Run all tests**

Run: `npm test`

Expected: 全量单测 PASS。

**Step 2: Refresh the installed Skill**

用仓库版本覆盖本机 `~/.codex/skills/ugk`，再检查 `SKILL.md` 包含 task 链规则。

**Step 3: Commit**

```bash
git add docs/plans/2026-07-15-mcp-task-chain-orchestration-design.md docs/plans/2026-07-15-mcp-task-chain-orchestration.md integrations/agent-skills/ugk/SKILL.md mcp/server.js tests/ugk-host-skill.test.ts tests/ugk-mcp-server.test.ts
git commit -m "feat(mcp): teach hosts to orchestrate task chains"
```
