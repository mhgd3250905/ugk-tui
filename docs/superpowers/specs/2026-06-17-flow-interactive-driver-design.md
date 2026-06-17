# Flow Interactive Driver Design

## 目标

为 Flow 增加可交互 driver 会话，让用户在 Task run 执行过程中可以进入正在工作的 driver，像普通对话一样插嘴、纠正、追问，然后再返回 main agent 复盘。

现有 Flow V0 已经能通过 `/flow task create/prove/run/review/status` 注入严格生命周期提示，但 driver 仍然依赖现有一次性 `subagent` 工具。这个模式能隔离上下文，却让用户只能等待最终摘要，无法在关键步骤及时干预。

Interactive Driver 的目标是解决这个问题：

- 同一个 TUI 对话框中可以从 main 视角切换到 driver 视角。
- attach 后滚动更新 driver 的内容，而不是 main 的内容。
- attach 后用户普通输入发给 driver。
- detach 后用户普通输入回到 main。
- 用户在 driver 中的干预必须记录到 run artifacts，供 main 后续复盘和 skill 写回判断。

## 非目标

- 不在第一版实现多窗口、多 tab 或外部终端。
- 不把普通 `subagent` 工具整体改成可交互会话。
- 不允许 driver 自己决定写回 `SKILL.md`、`todo.template.md` 或 `validator.md`。
- 不让 main agent 吸收 Task 的具体打法。
- 不实现 DAG、并行编排或多个 driver 同屏控制。

## 核心概念

### Main Focus

默认对话焦点。用户输入交给 main agent。main 负责 Flow 调度、状态解释、复盘、写回审批。

### Driver Focus

用户通过 `/flow attach <run-id>` 进入某个正在运行或可恢复的 driver。进入后：

- TUI 仍然是同一个对话框。
- 当前滚动内容显示 driver 事件、tool call、输出和进度。
- 用户普通输入交给 driver，而不是 main。
- `/flow detach` 退出 driver focus，回到 main focus。

### Interactive Driver

一个 Flow run 专属的可交互 agent 会话。它与 main 隔离上下文，但不再是一次性黑箱子进程。

driver 必须加载：

- 当前 Task 的 `SKILL.md`
- 本次 `input.json`
- 本次 `todo.md`
- `validator.md`
- run 目录路径

driver 必须写入：

- `progress.md`：当前步骤、动作、状态、最近证据。
- `feedback.md`：用户在 driver focus 中的插嘴、纠正、补充要求。
- `todo.md`：按最优路径填写实际执行、偏离旧方案、解决过程和证据。
- `status.json`：run 当前状态。

### Focus State

Flow 维护一个很小的焦点状态：

```text
focus = main | driver:<run-id>
```

焦点只影响当前 TUI 输入和展示目标，不改变 Flow 的写回规则。

## 用户交互

### 启动 driver

```text
/flow task prove x-search-post-collector --input "keyword=Medtrum"
```

main 创建 run，并启动 driver。main 显示：

```text
Flow driver running: x-search-post-collector/run-001
Attach: /flow attach run-001
```

### 进入 driver

```text
/flow attach run-001
```

进入后 TUI 状态显示：

```text
Flow focus: driver x-search-post-collector/run-001
```

之后用户输入：

```text
停，先不要滚动，等首屏结果加载出来再提取
```

这条消息发给 driver。driver 必须：

1. 记录到 `feedback.md`。
2. 调整当前执行。
3. 在 `todo.md` 对应步骤记录“偏离旧方案”和“解决过程”。
4. 继续执行或说明阻塞。

### 退出 driver

```text
/flow detach
```

回到 main focus。之后普通输入重新交给 main。

### 查看 driver

```text
/flow driver status
```

显示：

- 当前 focus。
- 活跃 run。
- driver 是否 running / waiting / done / failed。
- 最近步骤。
- 最近用户干预。
- run artifacts 路径。

## 输入路由规则

第一版使用明确的路由规则：

- `focus = main` 时，普通输入走 main agent。
- `focus = driver:<run-id>` 时，普通输入走对应 driver。
- `/flow detach` 始终由 Flow extension 处理，不发给 driver。
- `/flow driver status` 始终由 Flow extension 处理。
- `/flow task review <run-id>` 只能在 main focus 中执行；如果当前在 driver focus，先提示用户 detach。

driver 正在输出时，用户输入语义如下：

- 如果 driver 正在 LLM streaming，输入作为 `steer` 或等价中断修正。
- 如果 driver 正在工具调用，输入作为 `followUp` 或等价排队消息，在工具返回后立刻处理。
- 如果 driver 空闲，输入直接触发 driver 下一轮。

实现不必暴露这些术语给用户，但行为要接近普通对话。

## Run Artifacts

Interactive Driver 需要扩展 run 目录：

```text
.flow/tasks/<task-id>/runs/<run-id>/
  input.json
  prompt.md
  todo.md
  progress.md
  feedback.md
  output/
  evidence/
  validation.md
  status.json
  review.md
```

`progress.md` 最小结构：

```md
# Progress

## Current

- Step:
- Status:
- Last action:
- Last evidence:

## Timeline

- timestamp:
  - step:
  - action:
  - result:
  - evidence:
```

`feedback.md` 最小结构：

```md
# User Feedback

## Intervention 1

- timestamp:
- focus:
- user message:
- driver response:
- affected step:
- should review for skill update: yes/no/unknown
```

## 复盘规则

main agent 复盘时必须读取 `feedback.md` 和 `progress.md`。

复盘时必须区分：

- driver 按现有 skill 独立成功。
- driver 曾失败，但通过自己修复成功。
- driver 依靠用户插嘴才成功。
- 用户插嘴只是澄清输入，不影响 task skill。

只有当用户确认某个干预是“同类任务下次也应该遵守的经验”，才能写回：

- `SKILL.md`
- `todo.template.md`
- `validator.md`

如果 run 依靠用户临场指导才成功，Task 可以标记为 `fixed` 或 `needs-review`，但不能自动宣称 skill 已成熟。

## 架构选择

### 不推荐：继续使用一次性 `subagent`

当前 `subagent` 使用 `--mode json -p --no-session`，stdin 被关闭。它适合一次性委派，不适合 attach 后对话。

### 推荐：Flow 专属 Driver Session

Flow 创建 run 时，为 driver 创建一个可持久化、可路由输入的 session。

main 和 driver 的关系：

```text
main session
  owns Flow lifecycle
  reads/writes Task metadata
  starts driver session
  reviews run artifacts

driver session
  owns one run execution
  receives user input while attached
  writes progress/todo/evidence/output/status
  never writes back Task skill directly
```

这保留了上下文隔离，也允许用户在关键时刻介入。

## 状态机

Driver session 状态：

```text
starting
  -> running
  -> waiting-for-user
  -> validating
  -> done
  -> failed
  -> needs-human
  -> detached
```

Focus 状态：

```text
main
  -> attach(run-id)
driver:<run-id>
  -> detach
main
```

driver 状态和 focus 状态独立：driver 可以继续 running，而用户 focus 在 main；用户也可以 attach 到已经 done 的 run 查看历史。

## 命令设计

新增命令：

```text
/flow attach <run-id>
/flow detach
/flow driver status
```

更新命令行为：

- `/flow task prove <task-id>`：创建 run 后启动 interactive driver，并提示 attach 命令。
- `/flow run <task-id>`：同上，但只允许 verified/active Task。
- `/flow task review <run-id>`：在 main focus 中读取 driver artifacts 复盘。

## UI 表示

TUI 不需要新窗口。第一版只需要清晰标识 focus：

```text
Flow: main
```

或：

```text
Flow: driver x-search-post-collector/run-001
```

driver focus 下的滚动内容显示：

- driver assistant 输出。
- driver tool calls。
- progress 摘要。
- run artifact 路径。

如果 driver 正在工具调用，用户输入可以被排队，并提示：

```text
Driver is running a tool. Your message will be delivered next.
```

## 测试建议

不依赖真实网站或浏览器，先测路由和 artifacts：

- `/flow attach run-001` 把 focus 设置为 `driver:run-001`。
- driver focus 下普通 input 不触发 main Flow prompt，而是路由到 driver。
- `/flow detach` 把 focus 恢复为 main。
- driver focus 下 `/flow task review run-001` 被拒绝并提示先 detach。
- 用户插嘴会写入 `feedback.md`。
- driver progress update 会写入 `progress.md`。
- main review prompt 要求读取 `feedback.md` 和 `progress.md`。
- 普通 `subagent` 工具行为不受影响。

## 风险

- pi extension API 当前提供 session switch/new/fork 能力，但现有 `subagent` 子进程不是可附着 session。实现时可能需要新增 Flow 专属 driver runtime，而不是复用当前 `subagent` 工具。
- 如果 driver 与 main 同时写 Task 文件，可能出现竞争。第一版规定 driver 只写 run 目录，main 才能写 Task 资产。
- 用户 attach 后可能忘记 detach。TUI 必须持续显示当前 focus，避免输入发错对象。
- 如果 driver 长时间运行工具，插嘴可能不能立即生效，只能排队到工具结束后。

## 验收标准

- 用户可以在同一个 TUI 中 `/flow attach <run-id>` 进入 driver focus。
- attach 后滚动展示 driver 内容。
- attach 后普通输入发给 driver。
- `/flow detach` 后普通输入回到 main。
- 用户在 driver 中的输入被记录到 `feedback.md`。
- driver 进度被记录到 `progress.md`。
- main review 会读取 `feedback.md` 和 `progress.md`。
- driver 不能直接写回 `SKILL.md`、`todo.template.md`、`validator.md`。

## 与 Flow V0 的关系

Flow V0 已经定义 Task 生命周期和 run artifacts。Interactive Driver 是下一层能力：把 prove/run 的 driver 从一次性黑箱执行器升级为可观察、可插嘴、可复盘的 run 会话。

Implementation plan: This document intentionally stops at the design stage. Create a separate implementation plan after user approval.
