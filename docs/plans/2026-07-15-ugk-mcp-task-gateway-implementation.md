# UGK MCP Task Gateway Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 Codex 通过一个本机 MCP tool 调用 UGK 已验收 task，并完整处理安装诊断、项目信任、问卷、授权、取消和结构化失败。

**Architecture:** 新增一个薄 STDIO MCP server 和单运行 RPC job manager。MCP 为每次请求启动现有 UGK RPC 模式；gateway 扩展把可用工具硬限制为 `run_task`、`questionnaire` 和结构化 `no_match` 工具。Codex Skill 只负责宿主侧引导与上下文整理。

**Tech Stack:** Node.js ESM、现有 TypeScript 扩展、`@modelcontextprotocol/sdk` 1.29、Node test runner、现有 UGK RPC JSONL 协议。

---

## 实施前约束

- 从干净的独立 worktree 实施，不在当前包含用户改动的 main 工作区直接开发。
- 不新增 npm 依赖；MCP SDK 已在 `package.json`。
- 不使用 `UGK_SKIP_WORKSPACE_TRUST=1` 绕过正式流程。
- 不把 API key 打进日志、命令参数、MCP 返回或 Agent 上下文。
- 每个任务先写失败测试，再写最小实现。
- 每个 commit 只对应一个可验证目标。

## Task 0: 建立隔离 worktree 和基线

**Files:** 无代码修改。

**Step 1: 确认当前工作区状态**

Run:

```powershell
git status --short
git worktree list
```

Expected: 看见当前用户已有改动；记录它们，不修改、不暂存。

**Step 2: 创建实现分支和 worktree**

Run:

```powershell
git worktree add E:/AII/worktrees/ugk-core/mcp-task-gateway -b codex/ugk-mcp-task-gateway
```

Expected: 新 worktree 指向 `codex/ugk-mcp-task-gateway`。

**Step 3: 跑基线**

Run in `E:/AII/worktrees/ugk-core/mcp-task-gateway`:

```powershell
npm test
npm run test:integration
```

Expected: 全部通过。如果基线失败，先记录并停止，不把既有失败归因于新功能。

## Task 1: 给 `run_task` 补稳定失败元数据

**Files:**

- Modify: `extensions/task/task.ts`
- Modify: `tests/subtask-tool.test.ts`

**Step 1: 写失败测试**

在现有 `run_task` 测试旁新增断言，覆盖：

- 缺 required env → `failure.code === "MISSING_ENV"`、`stage === "preflight"`；
- 缺 required binary → `MISSING_BINARY`；
- dispatcher 解析失败 → `INPUT_INVALID`、`stage === "dispatcher"`、`retryable === true`；
- worker 失败 → `WORKER_FAILED`；
- verify 失败 → `VERIFY_FAILED`，并保留 `verifyFailures`；
- protected tool 被拒绝 → top-level `failure.code === "PROTECTED_TOOL_DENIED"`。

预期结构：

```ts
type TaskFailure = {
  code: string;
  stage: "preflight" | "routing" | "dispatcher" | "approval" | "worker" | "verify" | "runtime";
  retryable: boolean;
  message: string;
  suggestedAction?: string;
};
```

Run:

```powershell
node --test tests/subtask-tool.test.ts
```

Expected: 新断言 FAIL，因为当前结果只有文本和 `parseFailed`。

**Step 2: 实现最小结构化字段**

在 `SubtaskResult` 上增加可选 `failure`，在当前已有分支直接填值，不重写执行流程：

- `missingRequiredEnv()` 分支；
- `missingRequiredBinaries()` 分支；
- `resolveRuntimeInput()` catch；
- `runTaskWithRetry()` 返回后，根据 worker/verify 结果分类。

`run_task` 外层 catch 返回：

```ts
details: {
  mode,
  results: [],
  failure: { code, stage, retryable, message, suggestedAction }
}
```

不要删除现有 `workerSummary`、`verifyFailures` 或 `parseFailed`；先保持向后兼容。

**Step 3: 验证**

Run:

```powershell
node --test tests/subtask-tool.test.ts
npm test
```

Expected: 全部通过。

**Step 4: Commit**

```powershell
git add extensions/task/task.ts tests/subtask-tool.test.ts
git commit -m "feat(task): expose structured failure metadata"
```

## Task 2: 增加只允许 task 的 gateway 运行模式

**Files:**

- Create: `extensions/task/task-gateway.ts`
- Modify: `extensions/task/task-registry.ts`
- Modify: `extensions/task/task.ts`
- Modify: `extensions/index.ts`
- Create: `tests/task-gateway.test.ts`

**Step 1: 写 gateway 约束测试**

测试公开 helper 和扩展注册行为：

1. `UGK_TASK_GATEWAY` 未开启时不注册额外工具、不改 active tools；
2. 开启时 active tools 精确等于：

```ts
["run_task", "questionnaire", "task_gateway_result"]
```

3. `task_gateway_result({status:"no_match"})` 返回结构化 details，并终止当前 agent loop；
4. gateway prompt 明确禁止普通工具和无 task 兜底；
5. gateway task 清单包含全部已安装 task，不要求 `read` 工具读取额外索引；
6. 旧 `dedicated` 标签不影响 task 的可见性或执行。

Run:

```powershell
node --test tests/task-gateway.test.ts
```

Expected: FAIL，文件和注册逻辑尚不存在。

**Step 2: 实现 gateway extension**

`extensions/task/task-gateway.ts` 只做三件事：

- 环境变量开关；
- 注册 `task_gateway_result`；
- 在 `session_start` 限制工具，在 `before_agent_start` 追加硬约束 prompt。

`task_gateway_result` 第一版 schema：

```ts
{
  status: "no_match";
  reason: string;
  consideredTasks?: string[];
}
```

不要让这个工具承担 PASS/FAIL；PASS/FAIL 直接来自 `run_task`。

**Step 3: 让 gateway 看见完整 task 清单**

给 `buildTaskbookPrompt()` 增加一个默认关闭的选项，例如：

```ts
buildTaskbookPrompt(cwd, { includeDedicatedDetails: true })
```

只有 `UGK_TASK_GATEWAY=1` 时使用。普通 TUI 不改变。

**Step 4: 注册扩展并验证**

Run:

```powershell
node --test tests/task-gateway.test.ts
npm test
```

Expected: 全部通过。

**Step 5: Commit**

```powershell
git add extensions/task/task-gateway.ts extensions/task/task-registry.ts extensions/task/task.ts extensions/index.ts tests/task-gateway.test.ts
git commit -m "feat(task): add task-only gateway mode"
```

## Task 3: 增加机器可读 doctor 和安全的凭据文件导入

**Files:**

- Create: `bin/ugk-auth-status.js`
- Create: `bin/ugk-auth-cli.js`
- Create: `mcp/doctor.js`
- Modify: `extensions/deepseek-status.ts`
- Modify: `tests/deepseek-status.test.ts`
- Create: `tests/ugk-auth-cli.test.ts`
- Create: `tests/ugk-mcp-doctor.test.ts`

**Step 1: 写 auth 状态测试**

从当前人类文本状态中抽出共享的结构化判断：

```js
{ configured: true, source: "env" | "auth_json", provider: "deepseek" }
```

覆盖 env、BOM auth.json、缺文件、损坏 JSON。现有 `getDeepSeekStatus()` 继续返回原文案。

Run:

```powershell
node --test tests/deepseek-status.test.ts
```

Expected: 新结构化 API 测试 FAIL。

**Step 2: 实现共享 auth 状态**

把纯 Node.js 文件读取逻辑放进 `bin/ugk-auth-status.js`，让 CLI 和 TypeScript 扩展共同调用。不要通过正则解析人类文案。

**Step 3: 写凭据导入安全测试**

测试 `ugk auth import --provider deepseek --file <path>` 的核心函数：

- 只接受存在的普通文件；
- 读取 trimmed plaintext key；
- 写入 `{deepseek:{type:"api_key",key}}`；
- 保留 auth.json 中其他 provider；
- BOM-safe；
- stdout/stderr 和返回对象都不包含完整 key；
- 不删除源文件；
- 无效 key 不写 auth.json；
- 文件权限设置失败不破坏已成功写入（Windows 兼容）。

Run:

```powershell
node --test tests/ugk-auth-cli.test.ts
```

Expected: FAIL。

**Step 4: 实现凭据导入**

保持入口很窄，只支持 DeepSeek 和 `--file`。key 通过 request header 验证，不进入命令参数或输出。写配置是有副作用操作，Skill 必须在调用前取得用户同意。

**Step 5: 写 doctor 测试**

覆盖顺序化、一次一个 blocker：

- cwd 不存在 → `WORKSPACE_NOT_FOUND`；
- workspace 未信任 → `needs_approval / WORKSPACE_UNTRUSTED`；
- 已信任但无模型凭据 → `needs_setup / MODEL_AUTH_MISSING`；
- 全部满足 → `ok: true / ready`；
- 任何结果都包含 `version`、`workspaceRoot`（可解析时）、`nextAction`。

Run:

```powershell
node --test tests/ugk-mcp-doctor.test.ts
```

Expected: FAIL。

**Step 6: 实现只读 doctor**

`mcp/doctor.js` 复用 `bin/workspace-trust.js` 和结构化 auth 状态。doctor 只检查、不写信任、不写凭据。

**Step 7: 验证与 commit**

Run:

```powershell
node --test tests/deepseek-status.test.ts tests/ugk-auth-cli.test.ts tests/ugk-mcp-doctor.test.ts
npm test
```

Expected: 全部通过。

```powershell
git add bin/ugk-auth-status.js bin/ugk-auth-cli.js mcp/doctor.js extensions/deepseek-status.ts tests/deepseek-status.test.ts tests/ugk-auth-cli.test.ts tests/ugk-mcp-doctor.test.ts
git commit -m "feat(mcp): add setup diagnostics and safe auth import"
```

## Task 4: 实现单运行 RPC job manager

**Files:**

- Create: `mcp/rpc-job.js`
- Create: `tests/fixtures/ugk-rpc-task-stub.mjs`
- Create: `tests/ugk-rpc-job.test.ts`

**Step 1: 写状态机测试**

fixture 用 JSONL 模拟现有 RPC，不调用真实模型。覆盖：

1. trusted + configured → spawn，状态 `running`；
2. untrusted → 不 spawn，状态 `needs_approval`；
3. `respond(confirmed:true)` 后调用 `trustWorkspace()` 并 spawn；
4. `select/input/editor` → `needs_input`；
5. `confirm` → `needs_approval`；
6. `respond` 生成正确 `extension_ui_response`；
7. `tool_execution_end` 的 `run_task` details 被保留；
8. `task_gateway_result` → `no_match`；
9. child 异常退出 → `internal_error / RPC_CRASHED`；
10. cancel 先发 `abort`，最终 `cancelled`；
11. active run 存在时第二次 start → `busy`；
12. server dispose 会终止 child；
13. 进展只保留最后固定数量，避免无限增长。

Run:

```powershell
node --test tests/ugk-rpc-job.test.ts
```

Expected: FAIL。

**Step 2: 实现最小 job manager**

建议公开接口：

```js
createRpcJobManager({ packageRoot, doctor, spawnImpl, maxEvents })
manager.start({ cwd, request })
manager.status(runId)
manager.respond({ runId, interactionId, value, confirmed, cancelled })
manager.cancel(runId)
manager.dispose()
```

真实 child：

```text
node bin/ugk.js --mode rpc --no-session
```

环境增加 `UGK_TASK_GATEWAY=1`，`cwd` 通过 spawn option 传入。不要设置正式 trust bypass。

发送 prompt：

```json
{"id":"gateway-prompt","type":"prompt","message":"<compiled request>"}
```

监听现有 RPC 的：

- `extension_ui_request`；
- `tool_execution_end`；
- `agent_end`；
- `response`；
- child `exit/error`。

**Step 3: 将 `run_task` details 映射为业务结果**

- 全部结果 pass → `pass`；
- 任一 fail → `task_failed`；
- 从 `failure`、`workerSummary`、`verifyFailures`、`artifacts`、`outputDir`、`attempts` 组成结构化结果；
- 不从人类文本猜 stage/code。

**Step 4: 验证与 commit**

Run:

```powershell
node --test tests/ugk-rpc-job.test.ts
npm test
```

Expected: 全部通过。

```powershell
git add mcp/rpc-job.js tests/fixtures/ugk-rpc-task-stub.mjs tests/ugk-rpc-job.test.ts
git commit -m "feat(mcp): bridge UGK RPC jobs and interactions"
```

## Task 5: 暴露单一 `ugk` MCP tool 和 CLI 入口

**Files:**

- Create: `mcp/server.js`
- Create: `bin/ugk-mcp-cli.js`
- Modify: `bin/ugk.js`
- Create: `tests/ugk-mcp-server.test.ts`
- Create: `tests/ugk-mcp-cli.test.ts`

**Step 1: 写 MCP contract 测试**

使用 SDK 的 `InMemoryTransport.createLinkedPair()` 和 `Client` 测试：

- list tools 只有 `ugk`；
- input schema 是 `action` union；
- `start/status/respond/cancel` 正确委托 job manager；
- 正常业务状态同时放入 `structuredContent` 和 JSON text content；
- `no_match/task_failed/needs_setup/busy` 不设置 `isError`；
- 未知 action、缺必填字段设置 `isError`；
- server close 调用 manager.dispose。

Run:

```powershell
node --test tests/ugk-mcp-server.test.ts
```

Expected: FAIL。

**Step 2: 用 SDK 低层 Server 实现一个工具**

复用项目已有模式：

```js
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
```

不用为了 schema 新增 `zod` 直接依赖。server instructions 前 512 字符内讲清：UGK 只运行已有 task、必须传当前项目绝对 `cwd`、状态通过 `status` 查询。

**Step 3: 写 CLI dispatch 测试**

覆盖：

- `ugk mcp doctor --json` 在 update preflight 和 workspace trust 之前分流；
- `ugk mcp serve` 在全局 workspace trust 之前分流；
- `ugk auth import ...` 同样使用专用 CLI 分流；
- 其他参数仍进入现有 pi main；
- doctor JSON 的 stdout 只有 JSON，诊断文字走结构字段。

Run:

```powershell
node --test tests/ugk-mcp-cli.test.ts
```

Expected: FAIL。

**Step 4: 实现 CLI 入口**

在 `bin/ugk.js` 当前 task install/remove/update 分流附近增加：

```text
ugk mcp doctor --json
ugk mcp serve
ugk auth import --provider deepseek --file <path>
```

`serve` 才连接 `StdioServerTransport`。不要在 import module 时自动启动，便于测试。

**Step 5: 验证真实握手**

Run:

```powershell
node --test tests/ugk-mcp-server.test.ts tests/ugk-mcp-cli.test.ts
node bin/ugk.js mcp doctor --json
```

Expected: 测试通过；doctor 输出一个合法 JSON 对象，不弹 TUI 信任提示。

**Step 6: Commit**

```powershell
git add mcp/server.js bin/ugk-mcp-cli.js bin/ugk.js tests/ugk-mcp-server.test.ts tests/ugk-mcp-cli.test.ts
git commit -m "feat(mcp): expose the UGK task gateway over stdio"
```

## Task 6: 创建 Codex companion Skill

**Files:**

- Create: `integrations/agent-skills/ugk/SKILL.md`
- Create: `integrations/agent-skills/ugk/references/codex.md`
- Create: `integrations/agent-skills/ugk/agents/openai.yaml`
- Create: `tests/ugk-host-skill.test.ts`

**Step 1: 写 Skill 静态验收测试**

测试：

- frontmatter 只有必要字段且 name 为 `ugk`；
- description 只在用户明确提到 UGK、安装/配置 UGK、或继续 runId 时触发；
- 明确写“普通任务不自动交给 UGK”；
- 必须传当前项目绝对 `cwd`；
- 必须整理自包含 request；
- 包含 doctor → start → status → respond/cancel 流程；
- 自动纠错最多一次且 request 必须实质变化；
- API key 不读取进上下文、不放命令参数、不回显；
- `references/codex.md` 包含 Codex MCP 检查/注册方式；
- `openai.yaml` 不声明 MCP 为硬依赖，因为 Skill 必须能在 MCP 尚未安装时完成 bootstrap。

Run:

```powershell
node --test tests/ugk-host-skill.test.ts
```

Expected: FAIL。

**Step 2: 编写最小 Skill 主流程**

`SKILL.md` 只放跨宿主核心流程：

1. 判断是否为明确 UGK 意图；
2. 取得当前 workspace；
3. 编译 request；
4. 读取对应宿主 reference；
5. 检查/安装/doctor；
6. 调 MCP 状态机；
7. 展示问题并回传；
8. 解释结构化结果；
9. 应用一次纠错规则。

不要把所有 Codex 命令塞进主 Skill。

**Step 3: 编写 Codex reference**

包含：

```text
codex mcp list
codex mcp add ugk -- ugk mcp serve
```

以及 GUI 中添加本地 STDIO server 的等价说明。配置写入和安装都先向用户说明并取得同意。

如果 MCP 刚注册后当前任务看不到工具，明确提示重启/新建 Codex 任务，不伪装成 UGK 故障。

**Step 4: 验证与 commit**

Run:

```powershell
node --test tests/ugk-host-skill.test.ts
npm test
```

Expected: 全部通过。

```powershell
git add integrations/agent-skills/ugk tests/ugk-host-skill.test.ts
git commit -m "feat(skill): add Codex workflow for the UGK gateway"
```

## Task 7: 增加集成测试和真实 smoke

**Files:**

- Create: `tests/integration/ugk-mcp-gateway.test.ts`
- Create: `scripts/smoke-ugk-mcp.mjs`
- Modify: `package.json`
- Modify: `.npmignore`

**Step 1: 写无模型集成测试**

启动真实 `mcp/server.js` + STDIO transport，但通过依赖注入让 RPC 使用 fixture。覆盖完整链路：

```text
MCP client → start → needs_approval → respond → running
→ questionnaire → respond → run_task PASS → status(pass)
```

再覆盖 `no_match` 和 `task_failed`。

Run:

```powershell
node --test tests/integration/ugk-mcp-gateway.test.ts
```

Expected: 先 FAIL，实现测试接线后 PASS。

**Step 2: 新增 opt-in 真实 smoke**

`scripts/smoke-ugk-mcp.mjs` 连接真实 `ugk mcp serve`，接受：

```text
--cwd <project>
--request <natural language>
```

它记录 JSONL 事件和最终 report 到 `.tmp/smoke-mcp/latest/`，不在普通 `npm test` 中调用真实模型。

新增 script：

```json
"smoke:mcp-task": "node scripts/smoke-ugk-mcp.mjs"
```

**Step 3: 检查 npm 包内容**

确保以下运行时文件未被 `.npmignore` 排除：

- `mcp/`
- `integrations/agent-skills/ugk/`
- 新增 `bin/` 文件

Run:

```powershell
npm pack --dry-run
```

Expected: tarball 清单包含上述文件，不包含 tests 和 smoke 脚本。

**Step 4: 跑全部自动测试**

```powershell
npm test
npm run test:integration
```

Expected: 全部通过。

**Step 5: 跑真实 x-search 验收**

在已经安装 `x-search` task、配置凭据并允许相关权限的本机执行：

```powershell
npm run smoke:mcp-task -- --cwd E:/AII/ugk-core --request "使用 x-search 查询关键词 X 最近 24 小时的讨论，返回摘要和来源"
```

Expected:

- MCP 返回 runId；
- 中间确认/问题可通过 respond 完成；
- 最终状态为 pass；
- 返回 task 名、attempts、artifacts/outputDir；
- report 不包含 API key。

**Step 6: Commit**

```powershell
git add tests/integration/ugk-mcp-gateway.test.ts scripts/smoke-ugk-mcp.mjs package.json .npmignore
git commit -m "test(mcp): cover the task gateway end to end"
```

## Task 8: 更新用户和开发者文档

**Files:**

- Modify: `README.md`
- Modify: `PROJECT-GUIDE.md`
- Modify: `docs/DEVELOPMENT.md`

**Step 1: 更新 README**

用非程序员能理解的语言增加：

- UGK 是已验收 task 执行器；
- Codex 用户如何安装 Skill；
- 首次诊断和 MCP 注册；
- 一条“用 UGK 查询 X”的示例；
- 明确无匹配 task 时不会让 UGK 通用执行。

**Step 2: 更新项目结构和开发说明**

记录：

- `mcp/` 的职责；
- `UGK_TASK_GATEWAY` 只由本机 MCP 子进程设置；
- RPC interaction 映射；
- 稳定状态码；
- 一次 active run 限制；
- smoke 命令。

**Step 3: 文档与全套回归**

Run:

```powershell
npm test
npm run test:integration
git diff --check
```

Expected: 全部通过，无空白错误。

**Step 4: Commit**

```powershell
git add README.md PROJECT-GUIDE.md docs/DEVELOPMENT.md
git commit -m "docs: explain the UGK MCP task gateway"
```

## 最终验收清单

- [ ] MCP 只暴露一个 `ugk` tool。
- [ ] gateway 模式无法调用普通工具。
- [ ] 没有匹配 task 时返回 `no_match`。
- [ ] Codex 当前项目绝对 `cwd` 被传入并回显 `workspaceRoot`。
- [ ] workspace trust 没有 bypass。
- [ ] questionnaire 和 protected tool confirm 可以往返。
- [ ] API key 不进入 Agent 上下文、命令参数或日志。
- [ ] `run_task` 失败有稳定 `stage/code/retryable`。
- [ ] 正常业务失败不作为 MCP transport error。
- [ ] 上层自动纠错最多一次。
- [ ] MCP 退出会终止 RPC 子进程。
- [ ] npm tarball 包含 MCP runtime 和 Skill source。
- [ ] unit、integration、真实 x-search smoke 全部通过。

## 实施完成后的对比实验

功能上线后，不立刻宣传“更省 token”。先固定 3 个 task 和输入，各运行至少 20 次，对比 Codex 直接执行与 Codex → UGK：

```text
首次 verify 通过率 / 最终成功率 / 人工介入次数
总 token / P50 与 P95 时延 / 可诊断失败比例
```

把原始运行记录和汇总结果保留到独立 eval 报告，再决定是否扩大自动触发范围或增加其他宿主适配。
