# 交接:Judge Agent 实现

日期:2026-06-19
分支:从 `main` 新建(当前 `main` HEAD = `f21d484`,PR #9 已合并)

## 一、这个任务是什么

造一个 **Judge Agent**——一个"项目经理" agent,复刻人类用户盯着干活 agent 实时纠偏的行为。

**起因**:Flow(`extensions/flow/`)越做越歪。它用 `prove → validation → review → accept` 五段仪式 + 签名链 + 状态机,想保证 agent 产出质量。但:

1. agent 是最不可靠的组件,Flow 却把越来越多义务(写签名、推进状态、填模板)压给 agent——让最不可靠组件做更多事换可靠性,方向错。
2. 事后质检救不回已走完的死路。知乎热榜例子:driver 撞反爬 → 撞无 cookie API → 用第三方聚合拿到过时数据 → validation 才判 FAIL。判 FAIL 时整条死路已走完,重跑又从零开始。
3. 真实场景里人能做到且高效得多:在 driver 迈错第一步(没用 cdp)就打断它说"启动 cdp",在它返回第三方过时数据时打回说"我要官方最新的"。**人是实时纠偏,不是事后判。**

**结论**:把那个"不断纠偏、知道我要什么的人"抽出来变成一个 agent。Judge 不是质检员,是**你本人的替身**。

## 二、根本原则(用户确认的铁律)

1. **agent 不感知状态机**。agent(driver)只管干活 + 报告"我做完了"。状态推进、判定、签名全归 runtime/Judge 内部。这叫剥掉 agent-tax。
2. **实时纠偏 > 事后质检**。Judge 在 driver 走错的当下 steer,不等它跑完整条死路。
3. **底座复用,不重写**。`extensions/flow/driver-session.ts` 的 in-process session + subscribe + steer 恰好是 Judge 需要的物理底座(代码勘察已验证)。Flow 歪的是上层仪式,不是底座。
4. **Judge 与 Driver 必须不同模型**。防共谋(同模型会共享盲区,一起错)。
5. **不改 pi runtime 内核**(`node_modules/@earendil-works/*` 只读)。全部在 `extensions/` 层。

## 三、Judge 怎么工作(三阶段循环)

```
用户提任务
 │
 ▼ 阶段 0 对齐需求(Aligning)
 │  Judge 用 plan mode 范式 + questionnaire 把需求逼清楚
 │  产出 RequirementsSpec(goal / hardConstraints / acceptance / forbidden / context)
 │  ui.select: [委派 driver / 继续澄清 / 改需求]
 │
 ▼ 选"委派" → 阶段 1 驱动+纠偏(Driving)
 │  Judge 起 in-process driver session,喂 [任务 + Spec]
 │  driver 跑 turn:
 │   ├ 只读/纯思考 turn → 不唤醒 Judge(零成本)
 │   ├ 关键节点(网络/写文件/报错/声明完成)→ 唤醒 Judge
 │   │   Judge 看 [Spec + transcript tail + 结构化摘要]
 │   │   ├ 放行 → Judge 睡回去,driver 继续
 │   │   ├ 纠偏 → Judge 调 driver.sendUserInput(方向) → steer → driver 下 turn 吃到
 │   │   └ 不可行 → abort + 报告
 │  出口:steer ≥ 5 次 → 上报用户接手
 │
 ▼ driver 声明完成 → 阶段 2 交付(Delivering)
    Judge 对照 Spec 的 acceptance 逐项最终判定
    ├ PASS → 摆给用户 [产出 + 走过的路径 + 证据],用户 ack
    └ FAIL → 回阶段 1 或超限上报
```

**知乎热榜完整时序**(验证用):
1. User:"搜最新的知乎热榜 top 20"
2. Judge 阶段0:问官方?热榜还是热搜?top 多少?时效? → Spec:goal=知乎热榜top20,hard=[官方最新],acceptance=[时间戳<1h],forbidden=[第三方聚合]
3. Judge 委派 driver
4. driver turn1:调 http 访问 zhihu.com → 反爬报错 → 硬规则唤醒 → steer"知乎有反爬,用 cdp"
5. driver turn2:撞无 cookie API → steer"用 cdp"
6. driver turn3:调 tophub.today(第三方聚合)拿到数据 → 硬规则唤醒(网络+写文件)→ Judge 看 Summary 的 pathsTried 命中 forbidden + 数据时间戳过期 → steer"这是第三方聚合且过期,违反 forbidden 和 hard,用 cdp 走官方要最新"
7. driver turn4:启动 cdp → 拿到官方最新热榜
8. driver 声明完成 → Judge 阶段2:对照 acceptance 逐项过 → PASS → 摆给用户

## 四、运行模型的关键约束(必读,否则做歪)

- **串行交替,不是并行**。Judge 和 Driver 不并行跑两个 LLM。driver 跑 turn → turn 结束若命中唤醒规则 → 暂停 driver 推进,唤醒 Judge → Judge 判定 → 放行/steer/abort。这与 pi 协作式 loop 天然契合(pi 的 event listener 是 `for (const listener) await listener(...)`,串行)。
- **steer 是 turn 级,不是逐 token**。pi 的 `steer` 在当前 turn 的 tool calls 跑完后、下一次 LLM call 前生效。driver 卡在长 tool 里时,steer 要等 tool 跑完。要真打断当前流只能 `abort()`。这是已知边界,**不要试图 hack 成逐 token 打断**。
- **唤醒规则两层**:硬规则(runtime 代码,必须唤醒:网络/写文件/报错/完成声明)+ Judge 可选(每次看完返回 keepWatching)。硬规则保证关键节点必醒,Judge 可选避免纯思考 turn 浪费。
- **Judge 视野 = tail + 结构化摘要,不是全量 transcript**。全量会让 Judge context 也越积越重,重蹈 driver 覆辙。

## 五、给执行 agent 的资源

**两份必读文档**(都在 `docs/superpowers/specs/`):
1. `2026-06-19-judge-agent-design.md` — 完整设计(为什么这么设计)。重点读 §3 概念、§4 运行模型、§6 勘察结论、§7 架构、§8 决策记录。
2. `2026-06-19-judge-agent-implementation-plan.md` — 7 阶段实现拆解(怎么做)。每阶段有目标/做什么/入口/出口(验收 checkbox)/注意。

**实现规划的阶段依赖图**:
```
阶段1 抽底座 → 阶段2 阶段0骨架 → 阶段3 阶段1骨架 → 阶段4 tail+摘要 → 阶段5 出口 → 阶段6 交付 → 阶段7 删Flow
```
阶段1-2 可并行(阶段2 用 stub driver),3-6 严格顺序,7 最后且需真实任务验证。

## 六、待决策项

### 已决策(用户 2026-06-19 拍板,执行 agent 照做)

1. **driver 声明完成的信号机制 = 注册 `judge_complete` 工具**。理由:工具调用是结构化事件,subscribe 精确捕获;文本标记要正则解析,不可靠(被 markdown 包裹/截断/相似字符串误判)。工具还可带参数(产出文件路径、完成理由),Judge 拿结构化数据。
   - **兜底逻辑(必做)**:driver 可能不调 `judge_complete` 就 turn 跑完(pi loop 无更多 tool call → 自然 `agent_end`)——可能真完成但忘调 / 在等输入 / 卡住。处理:
     - `judge_complete` 被调用 → **强信号**,直接进阶段 2。
     - `agent_end` 但本轮没调过 `judge_complete` → **弱信号**,也唤醒 Judge 判一次(Judge 决定:steer 继续 / 接受为完成进阶段 2 / abort)。
   - 把 `judge_complete` 工具加到 driver 的工具集(driver session 起来时配置)。
2. **阶段 1 抽底座:`createFlowDriverSession` 改名 `createDriverSession`,Flow 侧 re-export 兼容**。理由:共享底座不带 Flow 业务前缀,Judge import 干净;re-export 保证 Flow 现有 import 点不崩。
   - **执行注意**:重构时全局搜 `createFlowDriverSession` 的所有 import 点(主要在 `extensions/flow/index.ts` 等),确认都解析到 re-export 的新位置。Flow 存活到阶段 7,这段时间两套名字指向同一实现,**re-export 的类型签名必须与原导出一致**。
3. **Judge 和 Driver 使用独立 agent 定义,模型暂同源**。用户已确认:P0 要求的是角色/system prompt 隔离,不是模型源隔离。当前 `agents/judge.md` 与 `agents/driver.md` 都使用 `model: deepseek-v4-pro`,但 session 创建处必须显式加载各自 agent 定义。以后如需换不同 API 源,只改对应 agent frontmatter 的 `model:` 字段。

## 七、代码勘察结论(证明这事能做,且底座现成)

来自三份只读勘察(subagent / session 模型 / plan-mode):

**subagent 工具做不了 Judge**:它是子进程,stdin 关闭,父 agent 只能等子进程跑完拿最终摘要,中途只能 SIGTERM 杀。放弃这条路。

**Flow driver-session 恰好是 Judge 需要的底座**(`extensions/flow/driver-session.ts`):
- in-process session:`:160-165` `createAgentSession({cwd, agentDir, resourceLoader, sessionManager})`
- 实时订阅:`:210-226` `session.subscribe` 收 `message_update` 的 `text_delta` 和 `tool_execution_start/end`
- 中途注入:`:237-243` `sendUserInput` → if `isStreaming` then `steer` else `prompt`
- 现成测试:`tests/flow-driver-session.test.ts:170-200` 验证 steer
- 导出可 import:`DriverSessionLike`(`:34-43`)暴露 `subscribe/prompt/steer/followUp/isStreaming/dispose`

**plan mode 范式可复用**(`extensions/plan-mode.ts`):
- 工具白名单切换:`:84-86` `pi.setActiveTools(PLAN_MODE_TOOLS)`
- bash 命令级白名单:`plan-mode-utils.ts:100` `isSafeCommand`(纯函数,可直接 import)
- 提示词注入:`:162-188` `before_agent_start`
- 批准菜单:`:264-268` `ctx.ui.select`
- 纯状态机:`plan-mode-state.ts`(抄结构)

**⚠️ questionnaire 必须自己注册**:ugk 没注册 questionnaire 工具(只列在 plan-mode 白名单)。从 `node_modules/@earendil-works/pi-coding-agent/examples/extensions/questionnaire.ts` 搬进 `extensions/judge/questionnaire.ts` 并 `pi.registerTool`。**不依赖 pi 是否默认加载示例**。

**pi runtime 原语齐全**:`ExtensionAPI`、`createAgentSession`、`SessionManager`、`registerTool`、`registerCommand`、`setActiveTools`、`before_agent_start`、`tool_call` hook、`ctx.ui.select`、`pi.sendMessage`、事件流(`agent_start/turn_*/message_update/tool_execution_start/end`)、注入语义(`steer`/`followUp`/`sendCustomMessage`/`abort`)。

## 八、防共谋(必做,否则 Judge 跟 driver 一起错)

Judge 自己也是 LLM,可能跟 Driver 共享盲区。三道防御:
1. **模型隔离**:Judge 用不同家/更强模型(待决策项 2)。
2. **过程证据优先**:Judge 看 `DriverSummary`(已走路径 + 已试方法 + 时间戳等客观字段),不 only 看 driver 的"结果叙述"。driver 会粉饰,过程证据不会。
3. **硬规则兜底**:关键节点唤醒由 runtime 代码决定,不依赖 Judge 自己"觉得该看"。

残余风险:Judge 仍可能错判。兜底是阶段 2 PASS 后用户 ack(99% 时候点头,因为前面 Judge 已过滤 N 轮)。

## 九、目录结构(目标态)

```
extensions/
├── judge/                      ← 新增
│   ├── judge.ts                主 extension,export default
│   ├── judge-state.ts          纯状态机(抄 plan-mode-state 结构)
│   ├── judge-session.ts        Judge 自己的 in-process session 包装
│   ├── judge-driver.ts         包装 driver-session(createDriver + subscribe + steer)
│   ├── judge-prompts.ts        三阶段提示词(align / decide / finalize)
│   ├── judge-utils.ts          白名单 + tail 截取 + Summary 构建 + Spec 提取
│   └── questionnaire.ts        自己注册(从 pi 示例搬)
├── shared/                     ← 新增(阶段1)
│   └── driver-session.ts       从 flow 搬出的底座
├── flow/                       ← 暂留,Judge 跑通后删上层(阶段7)
├── plan-mode.ts                ← 范式参考,不改
└── index.ts                    ← 加一行 registerJudge(pi)
```

## 十、每阶段验收通用清单

开工前:
- [ ] 读过设计文档 §3-§7
- [ ] 读过实现规划对应阶段
- [ ] `git status` 干净,在分支上

提交前:
- [ ] `npm test` 全绿(当前基线 382 pass)
- [ ] `npm run build` 通过
- [ ] 新增代码有测试
- [ ] 没改 pi runtime 内核
- [ ] commit message:`Judge阶段N:<动词><对象>`
- [ ] 改动严格在本阶段定义内

遇到设计没覆盖的情况:**不要自行扩大改动**。回设计文档看是否有依据;若无,记到设计文档 §10 开放项,与设计者确认后再动。

## 十一、阶段性里程碑

- **阶段 1-2 完**:Judge 能和用户对齐出 RequirementsSpec(`/judge` 命令 + questionnaire 可用)。
- **阶段 3-4 完**:知乎场景能复现"Judge 发现走第三方聚合 → steer 换 cdp"。
- **阶段 5-6 完**:循环有出口,完整跑通知乎热榜交付官方最新数据。
- **阶段 7 完(需用户验收)**:Flow 上层删除,Judge 在 ≥3 个真实任务上跑通后才做。

## 十二、注意事项

- **阶段 7 是破坏性操作**(删 Flow)。必须在分支上做,跑通后再合。
- **不要默默加回 Flow 的能力**。若 Judge 跑通后发现某场景确实需要签名/状态机,回设计文档讨论,不要私自补。
- **当前 main 干净**:除了 `docs/handoff/`、`nul`、`skills/wang-nuanwei-style/`、`wangnuanwei-*.md` 几个未跟踪文件(与本任务无关),没有未提交改动。新分支从 `main` 切。
- **本交接 + 两份 spec 文档自包含**,执行 agent 不需要本设计讨论的历史对话上下文。

---

## 附:用户对执行 agent 的一句交代模板

> 读 `docs/handoff/2026-06-19-judge-agent-handoff.md`(本文件)+ `docs/superpowers/specs/2026-06-19-judge-agent-design.md` + `2026-06-19-judge-agent-implementation-plan.md` 三份。按实现规划的 7 阶段做。第六节"已决策"两条照做(driver 完成信号 = `judge_complete` 工具 + agent_end 兜底;底座改名 `createDriverSession` + Flow re-export)。"待用户确认"那 1 条(Judge/Driver 模型)开工前先问我。每阶段 `npm test` 全绿才提交。
