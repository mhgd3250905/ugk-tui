# MCP CDP Approval Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 MCP task gateway 在路由工具被隐藏时，仍能识别 task 声明的 `chrome_cdp`，把一次性授权交给上层 agent，并传入 worker。

**Architecture:** gateway 主 agent 继续只暴露 task 路由工具。`run_task` 在 gateway 模式下用全部已注册工具判断 task 的受保护工具依赖；现有 RPC `needs_approval/respond` 协议和 worker 环境授权机制保持不变。

**Tech Stack:** TypeScript、Node.js test runner、现有 UGK RPC/MCP 权限链路。

---

### Task 1: 修复 gateway 下的 CDP 授权发现

**Files:**
- Modify: `tests/subtask-tool.test.ts`
- Modify: `extensions/task/task.ts`

**Step 1: Write the failing test**

扩展测试 `makePi`，让它同时模拟 active tools 和 all registered tools。新增用例：active tools 只有 gateway 三工具、all tools 包含 `chrome_cdp`，task contract 声明 `requiredTools: ["chrome_cdp"]`；断言只确认一次且 worker 收到 `UGK_TASK_ALLOW_CHROME_CDP=1`。

**Step 2: Run test to verify it fails**

Run: `node --test tests/subtask-tool.test.ts`

Expected: 新用例失败，因为当前 `getActiveTaskTools()` 只返回 gateway active tools，确认次数为 0、worker 未收到授权。

**Step 3: Write minimal implementation**

在 `registerTask` 内仅调整工具来源：

```ts
function getActiveTaskTools(): string[] {
	if (process.env.UGK_TASK_GATEWAY === "1" && typeof pi.getAllTools === "function") {
		return pi.getAllTools().map((tool) => tool.name);
	}
	return typeof pi.getActiveTools === "function" ? pi.getActiveTools() : TASK_NORMAL_TOOLS;
}
```

**Step 4: Run tests to verify they pass**

Run: `node --test tests/subtask-tool.test.ts tests/task-gateway.test.ts tests/ugk-rpc-job.test.ts`

Expected: 全部 PASS；既有 RPC confirm 转发用例继续通过。

Run: `npm test`

Expected: 全量测试 PASS。

**Step 5: Commit**

```bash
git add docs/plans/2026-07-15-mcp-cdp-approval.md tests/subtask-tool.test.ts extensions/task/task.ts
git commit -m "fix(mcp): surface task CDP approval"
```
