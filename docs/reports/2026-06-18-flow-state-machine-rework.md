# Flow 状态机中心化重构 · 阶段总结

日期:2026-06-18

分支:`review/flow-architecture-deepen`(基于 main `e050137` 切出)

测试基线:270 → **315 pass / 0 fail**

## 一、起因:为什么要做这次重构

Flow 模块在功能上是对的(生命周期沉淀、driver 隔离、全留痕),但骨架有一个根本缺陷:**状态机没有中心**。

审核时发现的具体问题:

1. **状态转换规则散落在 5+ 处**。`task-store` 的可运行判定、`lifecycle-gates` 的 prove/run 校验、`review-actions` 的 accept/reject、`index.ts` 的 prove 编排、`prompts.ts` 的隐含状态预期——每处各写一段,改一条规则要在 5 处找全,漏一处就是隐蔽 bug。
2. **verified / active / approved 三个状态做同一件事**(在可运行判定上完全等价),只是历史包袱,没有任何产品层区分。
3. **结构合法被当成业务可复用**。prove 通过的标准只看"文件齐、JSON 对、有证据",不判断业务质量,但用同一个 PASS 信号把它和"可推进到可复用"串了起来。
4. **status 写入权限分散**。driver-store、index.ts、review-actions 都能直接 `updateFlowTaskStatus`,靠自律保证合法性。
5. **大量重复代码**:`isRecord` 复制 7 文件 / 23 处,`readJsonFile` 复制 4 份,可运行状态谓词复制 3 份,task 路径解析有逐字双胞胎。

这是"屎山入口"——不是文件长(那只是症状),而是状态语义没有单一真相。每加一个状态、每加一条转换,都会让模块比它应有的更痛。

## 二、本次重构的三个产品级决定

重构前与产品方确认了三个决定(均按推荐执行):

| 决定 | 选择 | 含义 |
|---|---|---|
| 状态机几个状态 | **6 个** | draft / proving / proved / reviewing / ready / needs-work;三个等价状态合并为 ready |
| 信号是否分层 | **拆双信号** | 结构 pass(能跑通)与业务 accept(可复用)是独立信号,不串联 |
| 写权是否收口 | **状态机独占** | 只有 task-state 能改 task.json 的 status,其他地方只能请求转换 |

来源(origin)用字段而非状态名表达:`ready` 的 `ready_origin` 记录是 local-proved / remote-sync / manual。

## 三、状态机定义

完整转换表(单一真相,见 `extensions/flow/task-state.ts` 的 `TRANSITIONS`):

```
draft ──prove-start──▶ proving ──prove-pass──▶ proved ──review-start──▶ reviewing
  ▲                        │                              ├─review-accept──▶ ready
  │ prove-fail             │                              └─review-reject──▶ needs-work
  │                        ▼                                      │
  └──                 (回 draft)                                  │ prove-start
                                                              (修复后必须重新证明)
                                                                   ▼
                                                               proving

ready ──prove-start──▶ proving    (再次 run / 演进 task 后重新证明)
ready ──review-start──▶ reviewing (再次 run 完成后复盘这次执行)
```

**关键语义**:
- `needs-work` 修复后**必须重新 prove**,不能直接跳回 proved——信任需要重新验证。
- `ready` 可被 prove-start 再次触发(演进 task 后重新证明),也可被 review-start 触发(再次 run 完成后复盘)。
- `run` 路径(对已 ready task 的执行)**不改 task 状态**——run 不重新证明可复用性,task 保持 ready;只有 run 后的 review 临时把它移到 reviewing。

## 四、架构:重构后的模块边界

```
index.ts (1159行)              ← 命令路由 + driver 进程胶水 + UI 副作用
  ├─ task-state.ts (177行,新)   ← 中心状态机:transition() 独占写权 + 完整转换表
  ├─ lifecycle-gates.ts (127行) ← 纯 gate:prove/run 前置校验(用 isRunnable + normalizeLegacyState)
  ├─ review-actions.ts (148行)  ← 纯决策:review start/accept/reject(走 transition)
  ├─ flow-fs.ts (40行,新)       ← 共享原语:readJsonStrict/Optional/Record + isRecord
  ├─ task-store.ts              ← task 元数据读写(FlowTaskStatus 类型保留旧值仅供读旧数据)
  ├─ review-store.ts            ← review 记录读写
  ├─ run-validation.ts          ← run 输出 gate
  └─ driver-store / driver-session / flow-console / status-presenter / ...
```

**核心规矩的落地验证**:`updateFlowTaskStatus` 在 task-store / task-state 之外**零调用**——所有 task 状态变更只能通过 `transition()` 走合法转换。

## 五、改动清单(10 个 commit)

按顺序分两阶段:

### 阶段 A:清理与 deepening(消除重复,建立测试网)

| commit | 内容 |
|---|---|
| `de08f13` | 状态谓词合一 + JSON 原语合一(flow-fs)+ 路径解析合一。删 isRecord ×23、readJsonFile ×4、可运行谓词 ×3 |
| `e7bd9dc` | 提取 `lifecycle-gates.ts`(纯 gate 判断),index.ts 1315→1212 |
| `375b888` | lifecycle-gates 补 11 个测试 |
| `6334fce` | 删 prompts.ts 6 个永远不会发送的 dead prompt 分支 |
| `67b655a` | 提取 `review-actions.ts`(纯 review 决策) |
| `207e5b4` | review-actions 补 10 个测试 |

### 阶段 B:状态机中心化(根治)

| commit | 内容 |
|---|---|
| `ae57304` | 新增 `task-state.ts`:6 状态 + transition() 独占写权 + 18 个测试(纯增量,不动现有代码) |
| `71ee386` | review-actions / lifecycle-gates 迁移到 transition()。抓到并修复状态机缺口(ready→reviewing) |
| `2b145e0` | index.ts prove 路径迁移到 transition(prove-start/pass/fail) |
| `6aba679` | 清理旧 isRunnableFlowTaskStatus,task 层全部走 task-state |

## 六、重构中抓到的真问题

状态机中心化的价值直接兑现——测试系统性覆盖,缺口立刻暴露:

1. **状态转换缺口**:ready 状态再次 run 完成后无法 review(原设计 review-start 只从 proved 来)。集成测试 `PASS run completion` 失败暴露,补了 `ready → reviewing` 转换。
2. **文案回归**:prove-start 的 next_step 丢了 taskId(写成 `waiting for run-001` 而非 `waiting for x/run-001`)。activity-card 测试精确抓到。
3. **行为漂移**:review-actions 迁移时,accept 在 task 不可读的情况下会先改 review 记录再发现转换失败——原版是先拒绝。修正为 accept 前先校验 task 存在。

这些在旧架构(规则散落)里都会是隐蔽的运行时 bug。

## 七、刻意保留的东西

- **driver 状态空间**(FlowDriverStatus:starting/running/validating/done/failed/needs-human/paused)与 **task 状态空间**是两个独立概念,不混淆。driver 的 `needs-human` 保留,不改名。
- **task-store 的 FlowTaskStatus 类型保留 verified/active/approved/needs-human 旧值**,仅为读取旧数据;`normalizeLegacyState` 自动归一为 ready/needs-work。新代码一律写新 6 状态。
- **run 路径不改 task 状态**:这是原代码的有意行为(run 不重新证明可复用性),迁移时完整保留。
- **lifecycle-gates 的 `task.status` 文案**显示原始值(可能是旧名),而非归一名——对用户更准确。

## 八、数字对比

| 指标 | 改前 | 改后 |
|---|---|---|
| index.ts 行数 | 1315 | 1159 |
| 状态转换规则定义处 | 5+ 处分散 | **1 处**(task-state 的 TRANSITIONS 表) |
| task status 写入点 | 6 处直接调 updateFlowTaskStatus | **1 处**(transition,task-store 外零调用) |
| 可运行状态名 | verified/active/approved(三等价) | **ready**(单一) |
| isRecord 副本 | 7 文件 / 23 处 | 0(flow-fs) |
| readJsonFile 副本 | 4 文件 | 0(flow-fs) |
| dead prompt 分支 | 6 个 | 0 |
| 测试数 | 270 | **315** |

## 九、已知遗留 / 下一步

本次只做状态机中心化(治本第一步)。以下问题已在审核中指出,留待后续:

1. **prove 的结构 gate 不判业务质量**。结构 pass ≠ 可复用,但状态机已把两者表达为不同事件(prove-pass 用 structural-pass,review-accept 才进 ready)。下一步可进一步把 prove 的 gate 拆成结构层 / 业务层。
2. **prompt 和 runtime 抢方向盘**。`buildFlowTaskReviewPrompt` 里大量"你必须/不能"的硬指令,这些本该是 runtime gate。状态机收口后,这些规则可以逐步从 prompt 收回到 transition。
3. **gate 是事后检查,不是写入拦截**。`.flow/` 全明文,谁都能手写 status.json。状态机收口了"通过 API 的写入",但物理文件仍可被绕过。这需要更深的安全模型。
4. **DriverViewPort(候选④)**。index.ts 的 driver 编排(transcript/focus/session-view)仍是 UI 副作用胶水,集中一处但有 locality。要进一步治理需把 UI 副作用收进端口,属于另一个 deepening 主题。
5. **`.flow/` 未进 .gitignore**。`.flow/` 当前不被 track,但 `.gitignore` 无规则,存在被误 `git add .` 提交的风险。建议补一条规则。

## 十、交付状态

- 分支 `review/flow-architecture-deepen`,10 个 commit,每个都是通过完整测试的独立小步。
- 315 pass / 0 fail,工作区干净。
- 随时可合并回 main,或继续在分支上推进下一步。

## 附:如何验证

```bash
npm test          # 315 pass / 0 fail
git log --oneline main..HEAD   # 查看本次 10 个 commit
```

状态机完整性测试:`tests/flow-task-state.test.ts`(18 个,覆盖所有合法转换 + 代表性非法转换)。
