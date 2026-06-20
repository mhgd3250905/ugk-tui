# Judge 模块现状与接手指南

更新时间: 2026-06-20

本文是 Judge 模块的当前权威入口。`docs/handoff/` 和 `docs/superpowers/specs/` 中的 Judge 早期文档只作为历史材料;如果与本文或代码冲突,以本文和测试为准。

## 一句话概览

Judge 是 UGK 的实时监督模式:先把用户需求对齐成 `RequirementsSpec`,再委派隔离的 Driver 执行,由 Judge 在关键节点根据过程证据放行、纠偏、终止或最终验收。

核心目标不是替代 Driver 干活,而是把人类在旁边盯 agent 时的实时判断固化到 runtime 里。

## 用户入口

- `/judge`:打开 Judge 操作菜单。
- `/judge toggle`:开关 Judge 模式。
- `/judge check-bash-window`:检查能否打开一个 bash 新窗口并实时 tail `live.log`。
- `/judge ack`:接受一个等待用户确认的 PASS 交付。

Judge 开启后 footer 显示:

- `⚖ judge`:需求对齐阶段。
- `⚖ driving`:Driver 执行和 Judge 监督阶段。
- `⚖ delivering`:最终交付确认阶段。

关闭 Judge 会清理 footer/widget,并恢复普通工具集 `read,bash,edit,write`。

## 三阶段流程

1. `aligning`
   - Judge 使用 `questionnaire` 和用户确认假设。
   - 产出可解析 `RequirementsSpec`:`goal`,`hardConstraints`,`acceptance`,`forbidden`,`context`。
   - 如果没有调用过 `questionnaire`,选择委派会被 C-2 闸拒绝。

2. `driving`
   - Runtime 创建隔离 Driver session,加载 `agents/driver.md`。
   - Driver 必须在认为完成时调用 `judge_complete`。
   - Judge 根据 `DriverSummary`、`TranscriptTail` 和 Spec 判定 `pass`、`steer`、`abort` 或 `parse_failed`。

3. `delivering`
   - Driver 成功调用 `judge_complete` 后进入最终判定。
   - Judge 对每条 `acceptance` 做最终 PASS/FAIL。
   - PASS 报告显示产出、验收证据、走过的路径。
   - 如果 TUI 支持 confirm,可立即接受;否则进入 pending ack,用户后续用 `/judge ack` 接受。

## 关键实现文件

- `extensions/judge/judge.ts`:注册 `/judge`、`questionnaire`、`judge_complete`;管理三阶段状态、footer、widget、delivery report、live-log 终端。
- `extensions/judge/judge-driver.ts`:包装 Driver session 事件;维护 `DriverSummary`;在工具开始/结束、错误、`judge_complete`、`agent_end` 时唤醒 Judge;写 `<cwd>/.judge/<runId>/live.log`。
- `extensions/shared/driver-session.ts`:Flow/Judge 共用 Driver session 底座;提供 `ask(text)` 收集当前 Judge 决策响应,避免再靠 transcript diff。
- `extensions/judge/judge-prompts.ts`:`ALIGN_PROMPT`、`DECIDE_PROMPT`、`FINALIZE_PROMPT`。
- `extensions/judge/judge-state.ts`:Judge 状态机和 `DriverSummary` 类型。
- `extensions/judge/judge-utils.ts`:Spec/verdict 解析、tail 提取、工具摘要、artifact 提取。
- `agents/judge.md`:Judge agent 的角色定义。
- `agents/driver.md`:Driver agent 的角色定义和 `judge_complete` 约束。

## 当前重要行为

### Judge 决策采集

旧方案用 `sliceNewTranscript(before, after)` 从 decider transcript 中切当前轮输出。这个方案已经删除,因为 transcript window 可能裁剪导致前缀失配,从而复用旧 verdict。

当前方案:

- `DriverSession.ask(text)` 在发送 prompt/steer 时注册一次性 capture。
- 优先收集当前响应的 `text_delta`。
- 如果没有 delta,在 `message_end` 中读取 assistant message text。
- Judge 只解析本次响应,不再从全局 transcript diff。

### 长工具运行识别

`DriverSummary.runningTools` 记录正在运行的工具: `toolName`、`argsSummary`、`startedAtMs`、`elapsedMs`。

Judge prompt 明确要求:当 `runningTools` 非空时,这是 Driver 正在等工具结果,不能把缺少产出误判为空转。最终交付时如果仍有 running tool,不得 PASS。

### stale wakeup 防护

Driver 完成并成功 `judge_complete` 后,旧的 guarded wakeup 不能再 abort/steer 已完成 Driver。

实现要点:

- `wakeupGeneration` 在成功 `judge_complete` 后递增。
- queued wakeup 执行前后都检查 generation。
- 过期 wakeup 直接返回。

### live.log 终端

Judge 委派 Driver 后会自动尝试打开一个新终端窗口显示 `live.log`。失败不影响主流程。

Windows 当前策略:

- 通过 `resolveBashCommand()` 使用项目配置或 Git Bash。
- 使用 `cmd.exe /d /s /c start "" <bash> --noprofile --norc -lc <command>`。
- bash command 会先 `mkdir -p` 和 `touch live.log`,再 `tail -n +1 -f live.log`。
- 不使用 Windows Terminal 特殊适配,不检测 `WT_SESSION`,不调用 `wt.exe`。

测试必须 mock opener,不能真实打开系统终端。

### delivery report

PASS/FAIL 报告结构:

1. `✅/❌ Judge PASS|FAIL`
2. 最终理由
3. `📦 产出`
4. `🔍 验收证据`
5. `🛣️ 走过的路径`

产出来源优先级:

1. `DriverSummary.artifacts`
2. 最终验收证据中的明确文件路径
3. Driver 最终摘要
4. live.log 兜底提示

这样可以避免 Driver 通过 bash 生成文件但 summary artifacts 为空时,报告误写"未产出"。

## 与 Flow 的关系

Judge 复用 Flow 抽出的 shared driver session 底座,但不删除 Flow 上层。

当前状态:

- Flow 仍保留 prove/validation/review/accept/signing 工作流。
- Judge 是并行的新模式,不是 Flow 的直接替换。
- 删除 Flow 上层不是本版本目标。

## 已知边界

- `steer` 是 turn 级注入,不能逐 token 打断正在运行的工具。
- 真正打断长任务只能 abort Driver。
- pi runtime 目前没有 per-session 工具 allowlist;Driver 工具边界主要靠 agent 定义和 Judge 监督。
- Widget 行数有限,完整过程看 `live.log`。
- `summary.steerCount` 与 `JudgeState.steerCount` 仍是两个概念,不要混用。

## 合并前后验证

推荐最小验证:

```powershell
node --test tests/judge-extension.test.ts tests/judge-delivery.test.ts tests/judge-exit.test.ts
npm test
git diff --check
```

Windows 上还应确认测试不会残留 Judge live-log 进程:

```powershell
Get-CimInstance Win32_Process |
  Where-Object {
    ($_.Name -in @('bash.exe','tail.exe')) -and
    ($_.CommandLine -match 'E:/AII/ugk-core/\.judge/.*/live\.log')
  } |
  Select-Object ProcessId,Name,CommandLine
```

正常结果应为空。

## 后续开发建议

1. 优先把 Judge 的真实任务回归样本沉淀成可复跑 smoke。
2. 为完全离线任务增加 Spec 约束模板,明确是否允许 pip/network dependency install。
3. 如果要更强工具隔离,需要 pi runtime 支持 per-session tool allowlist,不要在 Judge 层硬 hack。
4. 如果要减少 bash 工具唤醒噪声,应按工具输入/命令风险分级,不要简单关闭所有 bash wakeup。
