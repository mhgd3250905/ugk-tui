# Flow 状态机中心化重构

> 这是底层重构 PR。动的是 Flow 模块的状态机——task 生命周期的根基。
> PR 描述把**为什么改、改了什么、设计决策、风险、验证**全部讲清楚。
> 审核重点请放在"设计语义是否正确",而非逐行 diff。

## TL;DR

Flow 模块功能正确,但状态机没有中心:状态转换规则散落在 5+ 处,且 `verified/active/approved` 三个状态做同一件事。这是维护性隐患——每加一个状态都要在多处找全,漏一处就是隐蔽 bug。本 PR 把状态机收敛成单一模块,独占 task 状态写权,并修复了重构中暴露的 2 个真实语义 bug。

- **每个 commit 都通过完整测试**,独立小步,可单独 review(commit 数见 `git log --oneline main..HEAD`;不含已移出的 UI 闪烁修复 e050137)。
- **270 → 323 pass / 0 fail**,新增 53 个测试。
- **行为兼容**:旧数据(verified/active/approved)自动归一为新状态 `ready`。

> **审核反馈修复(v2)**:首轮审核发现 3 个问题,已全部修复——见下方第十二节。

---

## 一、设计初衷(为什么要改)

审核 Flow 模块时发现的核心问题,**不是文件长(那是症状),而是状态语义没有单一真相**:

1. **状态转换规则散落 5+ 处**。`task-store` 的可运行判定、`lifecycle-gates` 的 prove/run 校验、`review-actions` 的 accept/reject、`index.ts` 的 prove 编排、`prompts.ts` 的隐含状态预期——每处各写一段。改一条规则要在 5 处找全。

2. **verified/active/approved 三状态等价**。在可运行判定上完全相同,是历史包袱,无任何产品层区分。却要每次新增逻辑时考虑"这三个是不是都要改"。

3. **结构合法被当成业务可复用**。prove 通过只看结构(文件齐、JSON 对、有证据),但用同一个 PASS 信号推进到"可被 review",造成"结构对 = 可推进"的假象。

4. **status 写入分散**。driver-store、index.ts、review-actions 都能直接 `updateFlowTaskStatus`,靠自律保证合法性,没有硬约束。

5. **物理文件可绕过状态机**。driver agent 能 `writeFileSync` 直接改 SKILL.md 等,状态机只管住了"通过 API 的写入"。

这是"屎山入口"——不是现在不能跑,而是每加一个状态、每加一道转换,都会比它应有的更痛,且容易出错。

## 二、需求与产品决策

重构前与产品方确认了 3 个决定(均按推荐执行):

| 决定 | 选择 | 含义 |
|---|---|---|
| 状态机几个状态 | **6 个** | draft / proving / proved / reviewing / ready / needs-work |
| 信号是否分层 | **拆双信号** | 结构 pass(能跑通)≠ 业务 accept(可复用),不串联 |
| 写权是否收口 | **状态机独占** | 只有 task-state 能改 task.json 的 status |

关键产品语义:
- **三个等价状态合并为 `ready`**;来源用 `ready_origin` 字段(local-proved/remote-sync/manual)表达,而非用状态名。
- **prove 只判结构,review 是唯一质量关卡**。这是诚实的职责划分——prove 不假装判断业务质量。
- **needs-work 修复后必须重新 prove**(不能直接跳回 proved),因为信任需要重新验证。

## 三、状态机定义

完整转换表(`extensions/flow/task-state.ts` 的 `TRANSITIONS`),这是状态机的**单一真相**:

```
draft ──prove-start──▶ proving ──prove-pass──▶ proved ──review-start──▶ reviewing
  ▲                        │                                   ├─review-accept──▶ ready
  │ prove-fail             │                                   └─review-reject──▶ needs-work
  │                        ▼                                          │ prove-start
  └──                 (回 draft)                                       ▼
                                                                   proving

ready ──prove-start──▶ proving    (再次 run / 演进 task 后重新证明)
ready ──review-start──▶ reviewing (再次 run 完成后复盘这次执行)
ready ──run-fail──▶ needs-work    (再次 run 连结构都过不了 → 复用链路断,需重新证明)
```

事件是状态机的唯一输入(`FlowTaskEvent`):prove-start/pass/fail、run-fail、review-start/accept/reject、remote-mark-ready。

## 四、实现思路(改了什么)

分三阶段(A 清理 / B 中心化 / C 语义收口与安全),按时间顺序:

### 阶段 A:清理与 deepening(消除重复,建立测试网)
- `de08f13` 状态谓词合一 + JSON 原语(flow-fs)+ 路径解析合一。删 isRecord ×23、readJsonFile ×4
- `e7bd9dc` 提取 `lifecycle-gates.ts`(纯 gate 判断)
- `375b888` lifecycle-gates 补 11 个测试
- `6334fce` 删 prompts.ts 6 个永远不会发送的 dead prompt 分支
- `67b655a` 提取 `review-actions.ts`(纯 review 决策)
- `207e5b4` review-actions 补 10 个测试

### 阶段 B:状态机中心化(根治)
- `ae57304` 新增 `task-state.ts`:6 状态 + transition() 独占写权 + 18 测试(纯增量)
- `71ee386` review-actions / lifecycle-gates 迁移到 transition()
- `2b145e0` index.ts prove 路径迁移到 transition()
- `6aba679` 清理旧 isRunnableFlowTaskStatus,task 层全部走 task-state

### 阶段 C:语义收口与安全(俯瞰后发现的问题)
- `f9890b8` prove validation 标为 structural-only,review 是唯一质量关卡
- `27be3a2` `.flow/` 进 .gitignore
- `b3ffa1c` 删 task-prove/task-run/task-review 的 dead prompt 分支(也是永不发送的)
- `7aad81a` **修复 run-fail bug**:ready task run 失败不再保持 ready,转 needs-work
- `4f25a9a` driver 期间 task 设计资产 OS 只读(物理写入保护)

## 五、重构中抓到的 2 个真实语义 bug

状态机中心化的价值直接兑现——测试系统性覆盖,缺口立刻暴露:

### Bug 1:ready 状态再次 run 后无法 review
**发现方式**:`PASS run completion` 集成测试失败。
**原因**:原设计 review-start 只从 proved 来,但 ready task 再次 run 完成后 task 还是 ready,无法进 review。
**修复**:加 `ready → reviewing` 转换。

### Bug 2:ready task run 失败仍保持 ready
**发现方式**:俯瞰状态机时发现(run 路径只 prove 走 transition,run 失败什么都不做)。
**原因**:一个"可复用"的 task 连结构 validation 都过不了,却仍是 ready——用户下次还能 run,以为它可复用。
**修复**:加 `run-fail` 事件,ready → needs-work。

这两个在旧架构(规则散落)里都会是**隐蔽的运行时 bug**。

## 六、模块边界(重构后)

```
index.ts (1159行)              ← 命令路由 + driver 进程胶水 + UI 副作用
  ├─ task-state.ts (185行,新)   ← 中心状态机:transition() 独占写权 + 完整转换表
  ├─ lifecycle-gates.ts (127行) ← 纯 gate:prove/run 前置校验
  ├─ review-actions.ts (148行)  ← 纯决策:review start/accept/reject(走 transition)
  ├─ flow-fs.ts (40行,新)       ← 共享原语:JSON 读取
  ├─ flow-write-guard.ts (70行,新) ← driver 期间 task 资产只读保护
  ├─ task-store.ts              ← task 元数据读写(类型保留旧值仅供读旧数据)
  ├─ review-store.ts            ← review 记录读写
  ├─ run-validation.ts          ← run 输出 gate(scope: structural)
  └─ driver-store / driver-session / flow-console / status-presenter / ...
```

**写权独占验证**:`updateFlowTaskStatus` 在 task-store/task-state 之外**零调用**。

## 七、保护范围(物理写入安全模型)

| 文件 | 保护方式 |
|---|---|
| SKILL.md / todo.template.md / validator.md / schema | **driver 期间 OS 只读**(chmod 444) |
| task.json | 状态机独占写权 + normalizeLegacyState(不锁,runtime 要写 status) |
| status.json / validation.json / review.json | prompt + 状态机读取归一(runtime 持续写,不锁) |

威胁模型:防 agent **不小心**写,不是防恶意绕过。task.json 不锁是因为 runtime 在 driver 期间自己要写(prove-pass transition)——这是文件系统层无法区分调用者的本质限制,第一次实现时锁了 task.json 导致 8 个测试炸,收窄后通过。

## 八、行为兼容性

- 旧 `task.json` 的 `verified/active/approved` 状态读取时自动归一为 `ready`(`normalizeLegacyState`)。
- 旧 `validation.json` 无 `scope` 字段时默认 `structural`。
- `FlowTaskStatus` 类型保留旧状态名,**仅为读旧数据**;新代码一律写新 6 状态。
- run 路径不改 task 状态(原代码的有意行为,完整保留)。

## 九、验证

```bash
npm test          # 323 pass / 0 fail
git log --oneline main..HEAD   # 列出全部 commit
```

- 测试 270 → 323(+53):状态机 20、lifecycle-gates 11、review-actions 10、flow-fs 4、write-guard 5、其他调整。
- 每个 commit 都是通过完整测试的独立小步,可单独 revert。
- 新增测试覆盖:所有合法转换 + 代表性非法转换 + run-fail bug + ready_origin 落盘清除 + 写保护 EPERM + shutdown 锁释放 + review 失败不落盘。

## 十、已知未做(留给后续 PR)

本次只做状态机中心化这条线。以下明确**不在本 PR**,留作后续:

- **DriverViewPort**:driver 编排的 UI 副作用(transcript/focus/session-view,~150 行)收进端口接口。这是独立的 UI 架构改造,风险更高,单独一轮做。
- **prompt 与 runtime 规则进一步归位**:物理写入保护落地后,部分 prompt 硬指令可继续撤回 runtime,但需逐条判断。

## 十一、审核建议

重点看:
1. **状态机转换表**(task-state.ts `TRANSITIONS`)是否覆盖所有业务场景,有无遗漏的合法/非法转换。
2. **run-fail 语义**(ready → needs-work)是否符合产品预期。
3. **保护范围**(task.json 不锁)的取舍是否认可。
4. **兼容性归一**(normalizeLegacyState)对未知值的保守归位(needs-work)是否合适。

不需要逐行看 diff——每个 commit 都有清晰的 commit message 说明意图。

## 关键文件导航

| 文件 | 看什么 |
|---|---|
| `extensions/flow/task-state.ts` | 状态机定义 + 转换表(最核心) |
| `extensions/flow/flow-write-guard.ts` | 物理写入保护 |
| `extensions/flow/run-validation.ts` | scope: structural |
| `tests/flow-task-state.test.ts` | 状态机完整测试(理解语义最快) |
| `docs/reports/2026-06-18-flow-state-machine-rework.md` | 阶段总结文档 |

## 十二、审核反馈修复(v2)

首轮审核提出 3 个问题,**全部属实,已全部修复**:

### P1:driver 被外部 dispose 时只读锁泄漏(必修)
**问题**:`lockTaskAssets` 创建的 guard 只在 `liveDriver.start()` 的 then/catch 释放。但 driver 输入转发失败(直接 `dispose()`)和 `session_shutdown`(遍历 dispose)这两条路径不释放 guard,导致 SKILL.md / schema / validator 等文件可能**永久保持 0444 只读**,后续修 task 或资产修复失败。

**修复**:guard 改为按 `driverKey` 存入 `writeGuards: Map`,新增统一释放函数 `releaseWriteGuard(driverKey)`(幂等)。所有 driver 终态路径统一调用:
- `.then` 的 3 个终态 return
- `.catch`
- input 转发失败 dispose 前
- `session_shutdown` 的 clear 前(遍历释放所有未释放 guard)

**测试**:新增 `session_shutdown releases task asset readonly locks held by live drivers`——driver start 永不 resolve(锁持有中)→ shutdown → 验证 SKILL.md 恢复可写。

### P2:review 记录先写、状态机 transition 后执行,失败留半提交(必修)
**问题**:`startReview/acceptReview/rejectReview` 原本先 `startFlowReview/acceptFlowReview/rejectFlowReview` 写 review.json,再 `transition()`。若 transition 因 task 状态不合法失败,会出现 **review 文件已变更、task 状态没推进** 的半提交状态。

**修复**:三个函数全部调整为**先 transition 后写 review 记录**。transition 失败则 review 不落盘(或保持原状)。

**测试**:
- `startReview is rejected...and leaves no review.json`:draft task 调 startReview → transition 失败 → review.json 不存在。
- `acceptReview leaves review.json unchanged when state machine rejects`:proved task(非 reviewing)调 acceptReview → transition 失败 → review.json 保持 in-review(未被改成 accepted)。

### P3:PR 范围含无关 commit(必修)
**问题**:PR 报告写"16 个 commit",但实际 PR 含 18 个,包括 `e050137 Reduce flow driver background widget refreshes`(UI 闪烁修复),它不属于状态机中心化 PR,会误导审核方判断范围。

**修复**:`git rebase --onto main e050137` 将 e050137 移出分支(它仍保留在 `codex/flow-ui-flicker-investigation` 分支不受影响)。移出后 PR 全部 commit 都属于状态机中心化主题,无无关改动混入。

### 修复后状态
- **323 pass / 0 fail**(新增 1 个 shutdown 释放测试 + 2 个失败不落盘测试)
- 审核者指出的"半提交""锁泄漏""范围不一致"全部消除
