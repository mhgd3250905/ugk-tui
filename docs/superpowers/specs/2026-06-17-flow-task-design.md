# Flow Task Design

## 目标

新增一个 `flow` extension，用显式 `/flow` 入口把自然语言目标沉淀为可复用的 Task 能力。

第一版只做最小核心单元 Task，不做 DAG、并行编排、跨 Task 工作流。目标是把一个 Task 从“用户的一句话目标”推进到“至少成功跑通过一次，并形成 task 专属 skill”的闭环。

核心原则：

- 普通聊天不进入这套严格流程。
- 只有显式使用 `/flow` 时，才启用 Task 生命周期。
- main agent 不学习具体打法，只负责创建、归纳、复盘和汇报。
- 具体打法沉淀在 task 专属 `SKILL.md`。
- 每次 Task 由隔离 driver subagent 执行，driver subagent 只加载当前 Task 的专属 skill 和本次输入。
- 每次运行都必须归档、填写 todo、保存证据、验证结果。
- 失败未解决时不能写回 skill，只能标记为 `needs-human`。
- 只有通过验证且经用户复盘确认的经验，才能沉淀回 `SKILL.md`、`todo.template.md` 或 validator。

## 非目标

- 不实现复杂编排、DAG、并行 fan-out/fan-in。
- 不把 `/flow` 做成普通 plan mode 的改名。
- 不让 main agent 加载所有细分任务经验。
- 不在第一版追求完全自动证明或强安全沙箱。
- 不默认把所有对话任务都纳入 Flow 生命周期。
- 不把失败但未解决的经验写回 task skill。

## 核心概念

### Flow Extension

负责命令入口、Task 目录管理、状态机、run 归档、driver subagent 启动、验证结果记录和文件更新。

### Task

一个可被训练、可被验证、可由隔离 subagent 执行的精确任务类型。

Task 不是一次运行，也不是通用 skill。Task 的价值在于把同类任务成功跑通后的精确执行方法长期沉淀下来。

### Task Skill

Task 专属 `SKILL.md`，只在执行对应 Task 的 driver subagent 中加载。

它记录这类 Task 的最优路径、每一步动作、注意事项、证据要求和失败处理。它不是给 main agent 学习的通用知识。

### Todo Template

`todo.template.md` 是 task skill 中“最优路径”的可填写执行表单。每次 run 都从它复制出 `runs/<run-id>/todo.md`。

`todo.md` 不只是进度表，还要记录实际执行、偏离旧方案、解决过程和证据索引，用来防止 driver subagent 只口头声称完成。

### Driver Subagent

执行单次 Task 的隔离 agent。它只拿到：

- 当前 Task 的 `SKILL.md`
- 本次 `input.json`
- 本次 `todo.md`
- 输出和证据目录

driver subagent 不负责最终复盘，也不决定是否更新 skill。

### Main Agent

对话主 agent。它负责：

- 根据用户自然语言目标创建 Task 草案。
- 解释 Task 当前状态和下一步。
- 在 run 后主持复盘。
- 根据用户确认更新 `SKILL.md`、`todo.template.md` 和 validator。

main agent 不应该吸收每个 Task 的具体执行细节。

## 目录结构

第一版使用项目内 `.flow/` 目录：

```text
.flow/
  tasks/
    <task-id>/
      task.json
      SKILL.md
      todo.template.md
      input.schema.json
      output.schema.json
      validator.md
      runs/
```

每次运行创建一个 run 目录：

```text
.flow/tasks/<task-id>/runs/run-001/
  input.json
  prompt.md
  todo.md
  output/
  evidence/
  validation.md
  feedback.md
  status.json
  review.md
```

V0 中 `validator.md` 可以先是验证说明或人工门禁说明。后续在 Task 成熟后，再沉淀为 `validator.py` 或其他可执行验证器。

## `task.json`

最小字段：

```json
{
  "id": "x-search-post-collector",
  "status": "draft",
  "version": 1,
  "goal": "在 X 上搜索指定关键词，收集相关帖子并总结",
  "created_at": "2026-06-17T00:00:00Z",
  "updated_at": "2026-06-17T00:00:00Z",
  "skill_path": "SKILL.md",
  "todo_template_path": "todo.template.md",
  "input_schema_path": "input.schema.json",
  "output_schema_path": "output.schema.json",
  "validator_path": "validator.md",
  "runs_dir": "runs"
}
```

Task 状态：

```text
draft        刚创建，不能正式复用
proving      正在用真实样例跑通
verified     至少成功过一次，已经形成可复用 task skill
active       可正式复用
needs-human  当前卡住，需要用户指导
deprecated   不再推荐使用
```

## Task Skill 标准结构

`SKILL.md` 采用“最优路径 + 分步骤注意事项”的结构。

```md
# <task-id>

## 目标

## 适用范围

## 输入

## 输出

## 最优路径

A. 准备环境
B. 提交任务
C. 等待关键状态
D. 提取首批结果
E. 增量执行
F. 整理输出
G. 自检提交

## A. 准备环境

### 动作

### 注意事项

### 证据

### 失败处理
```

每次复盘后的经验必须尽量落在具体路径步骤下面，而不是追加成散乱规则。

例如 X 搜索 Task：

- `B. 提交关键词搜索` 下面记录不要擅自把用户关键词改写为高级搜索语法。
- `C. 等待首批结果加载` 下面记录首批结果出现前禁止滚动。
- `D. 提取首批结果` 下面记录第一次滚动前必须提取首屏结果。

## Todo Template 标准结构

`todo.template.md` 和 `SKILL.md` 的最优路径一一对应。

每个步骤至少包含：

- 原计划
- 实际执行
- 是否偏离旧方案
- 解决过程
- 证据
- 复盘候选

模板示例：

```md
# Run Todo

Task: <task-id>
Run: <run-id>
Input: input.json

## A. 准备环境

- [ ] 状态：pending / done / failed

### 原计划

按照 `SKILL.md` 的 A 步准备执行环境。

### 实际执行

待填写。

### 偏离旧方案

- 是否偏离：否 / 是
- 偏离说明：

### 解决过程

待填写。

### 证据

- 页面 URL：
- 截图：
- DOM 摘要：

### 复盘候选

- 是否建议沉淀：否 / 是 / 待判断
- 建议：
```

driver subagent 必须在执行中填写 `todo.md`。只勾选完成但没有证据，不视为可靠完成。

## 命令设计

### `/flow task create "<目标>"`

用户只输入自然语言目标，不需要提前知道 Task 名称。

Flow 注入创建流程上下文，由 main agent 生成 draft Task：

- 推断 task id 候选。
- 写入 `task.json`。
- 起草 `SKILL.md`。
- 起草 `todo.template.md`。
- 起草 `input.schema.json` 和 `output.schema.json`。
- 起草 `validator.md`。
- 状态必须是 `draft`。
- 结尾必须引导用户进入 prove。

创建完成不代表 Task 可用。

### `/flow task prove <task-id>`

用真实样例输入跑通 Task。

行为：

1. 将 Task 状态设为 `proving`。
2. 创建 run 目录。
3. 从 `todo.template.md` 复制本次 `todo.md`。
4. 启动隔离 driver subagent。
5. driver subagent 加载当前 Task 的 `SKILL.md` 并执行。
6. driver subagent 填写 `todo.md`，保存 output 和 evidence。
7. Flow 记录 validation。
8. 根据结果进入 `passed`、`failed`、`resolving` 或 `needs-human`。

如果 prove 成功，Task 进入 `verified`。是否进入 `active` 可由用户确认或后续策略决定。

### `/flow run <task-id>`

正式运行已经 `verified` 或 `active` 的 Task。

V0 必须阻止运行 `draft` Task，并提示先 `/flow task prove <task-id>`。

### `/flow task review <run-id>`

复盘必须由 main agent 主持，不能由 driver subagent 自评。

main agent 读取：

- `SKILL.md`
- `todo.template.md`
- 本次 `todo.md`
- output
- evidence
- validation
- feedback
- status

然后按 A/B/C/D 每个路径步骤向用户核对：

- 这一步是否遇到问题？
- 是否偏离旧方案？
- 最后怎么修正？
- 这个修正是否应该沉淀？
- 应该更新 `SKILL.md`、`todo.template.md`、validator，还是只归档？

复盘输出写入 `review.md`。

只有用户确认且本次 run 已成功或修复成功，Flow 才能写回 Task 文件并 bump version。

## Run 状态机

```text
running
  -> validating
  -> passed
  -> failed
  -> resolving
  -> fixed
  -> needs-human
```

状态含义：

- `passed`：一次通过。
- `failed`：验证失败，已经保留证据。
- `resolving`：正在尝试基于失败证据修复。
- `fixed`：曾失败，但修复后通过。
- `needs-human`：自动修复失败，需要用户指导。

写回规则：

- `passed` 可以进入复盘，但不一定修改 skill。
- `fixed` 可以进入复盘，并优先考虑是否沉淀新经验。
- `failed` 和 `needs-human` 不能写回 skill。
- 任何写回都需要用户确认。

## 复盘与沉淀

复盘的目的不是总结，而是决定哪些经验应进入 Task 资产。

复盘产物 `review.md` 应按步骤输出：

```md
# Review run-001

## C. 等待首批结果加载

结论：需要更新 task skill

原因：
本次出现搜索后空白加载，旧方案没有规定等待超时如何处理。

修改建议：
- SKILL.md：C 步注意事项增加等待超时处理。
- todo.template.md：C 步增加等待超时证据记录。
- validator：如果发生刷新，检查 before/after evidence。
```

沉淀规则：

- 只沉淀同类 Task 下次也应该遵守的经验。
- 不把偶发现象写成强规则。
- 不把 driver subagent 的自评当作复盘结论。
- 不把未验证修复写进 skill。
- 修改 skill 时优先更新具体路径步骤。
- 修改 todo 时必须对应 `SKILL.md` 的最优路径步骤。
- 修改 validator 时必须对应可检查证据。

## X 搜索示例

用户输入：

```text
/flow task create "在 X 上搜索指定关键词，收集最近相关帖子并总结"
```

Flow 创建 Task：

```text
.flow/tasks/x-search-post-collector/
```

`SKILL.md` 的最优路径可能是：

```text
A. 准备已登录 X 搜索环境
B. 使用用户原始关键词提交搜索
C. 等待首批结果加载
D. 第一次滚动前提取首屏结果
E. 滚动并增量采集
F. 去重整理并输出
G. 自检并提交
```

关键经验沉淀位置：

- `B`：不要擅自把关键词改写成 `since/to` 高级搜索语法，除非 input 明确要求。
- `C`：首批结果元素出现前禁止滚动。
- `D`：第一次滚动前必须保存首屏结果。

`todo.md` 需要记录：

- 实际搜索词。
- 搜索框证据。
- 首批结果加载证据。
- 首批结果文件。
- 是否偏离旧方案。
- 如果偏离，如何解决。

## 与现有能力的关系

### 与 `subagent`

Flow 使用 subagent 作为 driver 执行器，但不把普通 subagent 直接暴露为 Task 生命周期。

Flow 需要包装：

- task skill 加载
- run 目录创建
- todo 文件复制
- output/evidence 路径约束
- validation 记录
- review 和写回

### 与 `plan-mode`

`plan-mode` 是只读规划和计划执行跟踪。

Flow 是可沉淀 Task 能力的生命周期系统。它需要 driver subagent、Task skill、todo、run 归档和复盘写回。

### 与普通 skill

普通 skill 是通用能力。

Task skill 是精确任务类型的执行方法，只在对应 Task 的 driver subagent 中加载，不污染 main agent。

## 测试建议

第一版测试应覆盖纯状态和文件生成逻辑，不依赖真实 X 或浏览器。

建议测试：

- `/flow task create "<目标>"` 能创建 Task 目录和必需文件。
- 新 Task 默认状态为 `draft`。
- `todo.template.md` 包含最优路径步骤。
- `prove` 会创建 run 目录并复制 `todo.md`。
- `draft` Task 不能被正式 `/flow run`。
- run 状态转换遵守 `passed`、`failed`、`fixed`、`needs-human`。
- 未解决失败不会更新 `SKILL.md`。
- 复盘写回会 bump `task.json.version`。
- main agent 可见的是摘要和状态，不需要加载所有 Task 细节。

## 实现顺序

1. 定义 Task 状态、Run 状态和文件路径 helper。
2. 实现 `/flow task create` 的命令入口和上下文注入。
3. 生成 Task 目录、`task.json`、`SKILL.md`、`todo.template.md`、schema 和 validator 草案。
4. 实现 `/flow task prove` 的 run 目录创建和 todo 复制。
5. 接入 driver subagent 执行。
6. 记录 validation 和 run status。
7. 实现 `/flow task review` 的复盘上下文注入。
8. 实现用户确认后的写回和 version bump。

## 第一版验收标准

- 用户可以通过 `/flow task create "目标"` 创建 draft Task。
- 创建输出不要求用户提前提供 task id。
- Task 文件结构稳定，能够被后续命令读取。
- Task skill 采用最优路径 A/B/C/D 结构。
- `todo.template.md` 与最优路径对应，并包含偏离旧方案和解决过程记录。
- prove 会创建独立 run 目录。
- 每次 run 都有 `todo.md`、output、evidence、validation、status。
- 复盘由 main agent 主持，不能由 driver subagent 自评。
- 只有成功或修复成功并经用户确认的经验能写回 Task 资产。

## 暂缓决策

- DAG 和并行编排。
- Task marketplace 或跨项目共享。
- 自动 validator 脚本生成的完整策略。
- 多模型、多 driver 类型选择。
- 独立外部门禁 agent。
- 可视化 Flow UI。
