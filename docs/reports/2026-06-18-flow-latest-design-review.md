# Flow 模块最新设计方案与审核说明

日期：2026-06-18

分支：`codex/flow-driver-init-message`

代码基线：`2f1e85a Improve flow task menu and review state`

## 审核目的

本文档面向需要审核 UGK Flow 更新的协作部门，说明 Flow 模块当前最新版的设计目标、用户流程、运行时边界、风险控制和验证证据。

Flow 不是普通的聊天增强功能。它是 UGK 中用于把一次自然语言任务沉淀为可复用能力的工作流模块。它解决的问题是：用户不应反复解释同类任务怎么做，agent 也不能只靠口头总结声称任务完成。Flow 要把任务定义、执行过程、证据、验证、复盘和复用沉淀成一套可审计的生命周期。

## 最新目标

Flow 当前版本的目标是建立一个可重复、可验证、可复盘的 Task 生命周期：

1. 用户用 `/flow` 显式进入严格任务流程，普通聊天不受影响。
2. 用户的一句话目标先被创建为 Task 草案，而不是立即执行。
3. 每个 Task 拥有自己的执行说明、输入输出约束、验证标准和运行历史。
4. 每次执行由隔离的 driver agent 完成，main agent 不吸收具体打法。
5. 每次执行必须留下结构化产物、证据和进度记录。
6. runtime 负责固定契约和生命周期门禁，不能把内部文件规范抛给用户判断。
7. 只有通过验证且经用户确认的成功经验，才能沉淀回 Task。
8. 用户界面必须告诉用户下一步做什么，不能在任务已接受后继续提示无意义的 review。

## 非目标

当前 Flow 仍然保持小核心范围：

- 不做 DAG、跨 Task 编排、并行 fan-out/fan-in。
- 不把普通对话自动纳入 Flow。
- 不让 driver 自己决定更新 Task 设计资产。
- 不让用户理解或修复 `task.json`、schema、`validation.json`、`review.json` 等内部契约。
- 不用 prompt 替代必须由 runtime 执行的硬门禁。
- 不强制 agent 必须使用某个具体工具，例如 CDP。runtime 只负责保证应有工具被注入。

## 核心对象

### Task

Task 是一个可复用任务类型，不是一次运行结果。每个 Task 存在于：

```text
.flow/tasks/<task-id>/
```

典型资产包括：

- `task.json`：Task 元数据、状态、版本、最近 review/run。
- `SKILL.md`：该 Task 的专属执行方法。
- `todo.template.md`：每次 run 的执行清单模板。
- `input.schema.json`：输入结构约束。
- `output.schema.json`：输出结构约束。
- `validator.md`：验收规则。
- `runs/`：历史运行记录。

### Run

Run 是某个 Task 的一次执行。每次 run 位于：

```text
.flow/tasks/<task-id>/runs/run-001/
```

典型产物包括：

- `input.json`
- `prompt.md`
- `todo.md`
- `progress.md`
- `output/result.json`
- `evidence/`
- `status.json`
- `validation.json`
- `validation.md`
- `review.json`
- `review.md`
- `feedback.md`

### Main Agent

main agent 负责与用户对话、创建 Task、解释状态、主持复盘和在用户确认后沉淀经验。main 不应该学习每个 Task 的具体执行细节。

### Driver Agent

driver agent 负责执行单次 run。driver 读取当前 Task 的专属资产和本次输入，写入执行产物、证据和进度。driver 不负责最终复盘，也不能决定是否把经验写回 Task。

## 用户工作流

### 创建 Task

用户进入 `/flow`，选择 `Create task`，输入自然语言目标。Flow 让 main agent 创建 Task 草案，并由 runtime 检查固定资产是否齐全。

### 证明 Task 可运行

草案 Task 需要先 prove。用户从 `/flow -> Tasks -> <task>` 选择 `Prove <task-id>`。runtime 创建 run，启动 driver。driver 执行后，runtime 校验输出和证据。

### 复盘与接受

run 通过 runtime 验证后进入 review。main agent 向用户解释业务结果是否可接受，并询问是否把成功路径保存为以后复用流程。

用户确认后，runtime 写入 canonical accepted review，并更新 Task 状态与下一步。

### 再次运行

已通过 review 的 Task 可以再次执行。当前版本同时支持：

```text
/flow run <task-id>
/flow task start <task-id>
```

`task start` 是对用户更自然的别名，内部等价于 `run`。

## 最新菜单设计

早期 `/flow` 菜单把 Create、Prove、Run、Review 混在一个扁平列表里。Task 变多后，用户很难知道下一步做什么。最新版改为分层菜单：

```text
Flow
  Create task
  Tasks
  Attach driver
  Show status
  Exit
```

选择 `Tasks` 后展示所有 Task：

```text
Flow tasks
  cdp-twitter-search-medtrum [approved]
  readme-extract-summary [draft]
  Back
```

选择单个 Task 后，只展示该 Task 当前可执行操作：

```text
Flow task: cdp-twitter-search-medtrum
  Run cdp-twitter-search-medtrum
  Delete cdp-twitter-search-medtrum
  Back
```

如果某个 run 已经 accepted，不再继续显示 `Review <task>/<run>`。这是本轮重点修复点：用户不应该在任务已接受后继续看到 review 操作。

## Task 状态模型

当前 runtime 支持以下核心状态：

| 状态 | 含义 | 允许动作 |
| --- | --- | --- |
| `draft` | 刚创建，尚未证明可复用 | `prove` |
| `proving` | 正在证明 | 等待 driver |
| `proved` | 已通过 run validation，等待 review | `review` |
| `reviewing` | main 正在主持复盘 | `accept` 或 `reject` |
| `verified` | 用户已接受，可复用 | `run` / `task start` |
| `approved` | 已批准，可复用，兼容远端现有状态 | `run` / `task start` |
| `active` | 可正式复用 | `run` / `task start` |
| `needs-human` | 需要用户指导或重新证明 | `prove` |

`approved` 是本轮为远端状态兼容补齐的运行状态。之前 runtime 只认 `verified/active`，导致用户看到“已批准”后仍不知道如何继续。

## Runtime Gates

Flow 的关键原则是：固定契约由 runtime gate 执行，不靠 agent 自觉遵守 prompt。

### Task Asset Gate

触发时机：

- `/flow task create` 后。
- `/flow task prove <task-id>` 前。

检查 Task 必须包含固定资产：`task.json`、`SKILL.md`、`todo.template.md`、`validator.md`、`input.schema.json`、`output.schema.json`。

失败处理：

- runtime 让 main agent 自动修复 Task 资产。
- 用户不需要理解缺少哪个内部文件。

### Prove/Run Start Gate

`prove` 启动前必须满足：

- task id 合法。
- task 存在。
- Task Asset Gate 通过。

`run` 或 `task start` 启动前必须满足：

- task id 合法。
- task 存在。
- task status 是 `verified`、`approved` 或 `active`。
- 存在可接受的 latest review。

不满足时，runtime 阻止创建新 run。

### Run Output Gate

driver 完成后，runtime 验证：

- `output/result.json` 存在且是合法 JSON。
- 如果存在 `output.schema.json`，结果必须满足轻量 schema 检查。
- `evidence/` 至少包含一个非空证据文件。
- `progress.md` 存在。

失败处理：

- runtime 让 driver 自动修复一次输出契约。
- 修复后再次验证。
- 仍失败才标记为失败。

### Review Gate

review 只能在 run validation 为 `PASS` 后开始。driver 仍在运行、validation 缺失或 validation 失败时，runtime 阻止进入 review。

### Accept Review Gate

用户接受后，runtime 写入 canonical `review.json`，包含：

- `status: "accepted"`
- `userConfirmed: true`
- `taskDesignDecision`
- `taskVersion`
- `acceptedAt`
- `decisions`
- `updatedFiles`

这保证后续 `run` 不依赖 agent 手写的不完整状态。

## Driver 工具注入设计

Flow driver 是自由执行主体。runtime 不限制 driver 必须使用哪个工具，也不在 prompt 中强制“必须使用 CDP”。

但 runtime 必须保证 driver 环境具备主环境中应有的 UGK 扩展能力。之前远端暴露过问题：主会话有 `chrome_cdp`，driver 只有基础 read/bash/edit/write，导致 driver 绕过工具层写 raw CDP 脚本。

最新设计：

- driver session 显式加载 UGK 包内 `extensions/index.ts`。
- driver 环境继承 UGK 自定义工具，如 `chrome_cdp`、`cron`、`subagent`、`scrcpy`、`greet`。
- 如果主环境有关键工具而 driver 缺失，runtime 失败并给用户友好提示。
- 不通过 prompt 强制工具选择，不禁止 agent 自行写脚本。

## 用户边界

Flow review 阶段必须避免把内部实现抛给用户。用户只需要回答业务问题：

- 结果是否可接受。
- 是否要把本次成功路径保存为以后复用流程。
- 输出口径或阈值是否需要调整。

不应要求用户理解：

- schema
- `output/result.json`
- `validation.json`
- `review.json`
- `SKILL.md`
- `validator.md`
- lifecycle 字段

如果用户说“不懂”，agent 应解释这个问题和用户决策的关系，而不是跳过或要求用户确认内部细节。

## 删除能力

最新版在 Task 操作菜单中新增 `Delete <task-id>`。

删除规则：

- 删除前必须弹确认。
- 删除 `.flow/tasks/<task-id>` 及其历史 runs。
- 如果该 Task 有正在运行的 live driver，runtime 阻止删除。
- 删除已保留的 driver 视图状态，避免 UI 指向不存在的 Task。

## 状态展示修正

本轮修复了用户完成任务后仍被误导的问题：

旧行为：

- run 已 accepted。
- task 已 approved。
- Activity 仍显示 `next: main reviewing <task>/<run>`。
- `/flow` 菜单仍显示 `Review <task>/<run>`。

新行为：

- accepted review 不再出现在待 review 操作中。
- approved Task 显示 `Run <task-id>`。
- Activity 下一步显示 `/flow run <task-id>`。
- `/flow task start <task-id>` 作为自然语言别名可直接执行。

## 主要文件

| 文件 | 职责 |
| --- | --- |
| `extensions/flow/index.ts` | `/flow` 命令入口、生命周期调度、driver 管理、runtime gates 串联 |
| `extensions/flow/flow-console.ts` | `/flow` 分层菜单和下一步操作生成 |
| `extensions/flow/parser.ts` | Flow 命令解析，包括 `task start` 和 `task delete` |
| `extensions/flow/task-store.ts` | Task 元数据读写、状态更新、删除 |
| `extensions/flow/driver-session.ts` | driver session 创建、UGK 扩展注入、工具缺失 gate |
| `extensions/flow/driver-store.ts` | run artifacts、status、feedback、driver 摘要 |
| `extensions/flow/run-validation.ts` | Run Output Gate |
| `extensions/flow/review-store.ts` | review lifecycle 与 canonical accepted review |
| `extensions/flow/status-presenter.ts` | Flow Activity 卡片 |
| `extensions/flow/prompts.ts` | main/driver/review/repair prompt |

## 审核关注点

建议审核部门重点看以下问题：

1. 用户是否能从 `/flow` 菜单自然理解下一步。
2. 已 accepted 的 run 是否不再诱导用户重复 review。
3. approved/verified/active 三种可运行状态是否符合业务命名预期。
4. 删除 Task 是否需要额外的归档或回收站，而不是直接删除。
5. runtime gate 是否覆盖了必须稳定的内部契约。
6. driver 工具注入策略是否满足安全边界：不强制工具选择，但环境缺工具必须暴露为 runtime 初始化失败。
7. review 阶段是否仍有 prompt 约束过多、硬门禁不足的问题。

## 已知限制

- Task 资产 gate 是事后检查，不是文件写入时拦截。
- Run output gate 目前只做结构、schema 和证据存在性检查，不判断报告业务质量。
- Review 问法仍主要靠 prompt 控制，尚未完全结构化成 runtime 表单。
- Driver output contract 自动修复目前只尝试一次。
- Task 删除是物理删除，尚未提供回收站、归档或撤销。
- `.flow/` 当前是项目本地产物，不参与本次代码提交。

## 验证证据

本轮最新代码提交前执行：

```text
npm test
```

结果：

```text
270 pass / 0 fail
```

同时执行：

```text
git diff --check
```

结果：无输出。

覆盖的新增关键场景包括：

- `/flow` 顶层菜单改为 `Create task / Tasks / Attach driver / Show status / Exit`。
- Task 子菜单按当前状态展示 `Prove`、`Run`、`Review`、`Delete`。
- accepted review 不再作为待 review 操作出现。
- approved Task 可以运行。
- Activity 卡片对 accepted + approved 状态显示 `/flow run <task-id>`。
- `/flow task start <task-id>` 解析为运行 Task。
- `/flow task delete <task-id>` 删除前确认，并阻止删除正在运行的 Task。
- driver 缺关键工具时给用户友好的初始化失败提示。

## 当前结论

Flow 最新版本已经从“命令驱动的实验流程”推进到“面向用户的分层工作台”。它的核心设计方向是正确的：用户只处理业务判断，runtime 处理内部契约，driver 负责执行，main 负责复盘和沉淀。

下一阶段建议优先投入：

1. 把 review 用户输入进一步结构化，减少 prompt 失控风险。
2. 为 Task 删除增加归档或回收站策略。
3. 固化一个端到端 smoke，验证 driver 启动后拥有完整 UGK 自定义工具。
4. 将 approved/verified/active 的命名收敛为产品层一致术语，避免远端和本地显示不一致。
