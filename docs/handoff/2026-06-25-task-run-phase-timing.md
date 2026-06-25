# task 运行分段耗时记录

> **交接对象**:接手 task 模块的同事。
> **背景**:用户反馈某次 `/task run`(bili-up-homepage-spider)从开始到打开 CDP 感觉等了 1 分钟,实际总耗时 224.9s。但系统只记总耗时,没有分段数据,"到底慢在哪"只能猜。本次加分段计时,纯诊断、不改执行逻辑。
> **基线**:`npm test` 497 pass / 0 fail。
> **状态**:已实现 + 单测覆盖,已 commit 推送。

---

## 1. 为什么要做

之前 taskbook run 记录只有 `duration`(总秒数)。worker 子进程启动、首轮 LLM、造脚本/连 CDP、verify、重试——各占多少,全无数据。同事分析"慢在 worker 启动+首轮模型+造脚本"是**合理推断,但无证据**。要定位真瓶颈,得先有数据。

## 2. 改了什么(纯诊断,零执行逻辑改动)

在 `runTaskWithRetry` 的关键节点打时间戳,记进 run 记录的可选 `phases` 字段:

| 字段 | 含义 | 回答什么 |
|---|---|---|
| `workerFirstOutputMs` | runTaskWithRetry 进入 → worker 子进程首次产出 | "启动慢不慢"(子进程冷启动 + 首轮 LLM 延迟,即用户感受的"开始运行就卡") |
| `workerMs` | 所有 worker dispatch 累计 | worker 整体(含造脚本/连 CDP/跑脚本) |
| `verifyMs` | 所有 verify 累计 | 校验阶段 |

**不改任何执行流程**:worker 该怎么跑还怎么跑、结果一模一样。只是顺手在 await 前后 `Date.now()` 记一下差值。

### 数据流

`runTaskWithRetry` 返回 `outcome.phases` → 两条路径:
- `executeSubtask`(run_task 工具)→ `SubtaskResult.phases` + `appendRunToTaskbook` 的 `phases`
- `handleTaskRun`(/task run)→ `appendRunToTaskbook` 的 `phases`

phases 最终落盘进 `taskbook.json` 的 `runs[].phases`。

### 报告展示

`formatRunResult` 在"耗时"行下加"耗时分解"段,例如:
```
耗时: 224.9s

耗时分解:
  worker 启动+首轮: 58.0s
  worker 整体: 180.0s
  verify: 8.0s
```

用户在 PASS/FAIL 报告里直接看到分段,不用翻 taskbook.json。

## 3. 向后兼容

- `TaskRun.phases` 是**可选**字段,`isTaskRun` 不强制校验它。
- 老 run 记录(无 phases)照常加载、照常显示(报告里"耗时分解"段不出现)。

## 4. 测试

- `formatPhaseBreakdown` 导出单测:无 phases 空、有时输出可读秒数。
- 现有 PASS 测试加断言:`run.phases.workerMs` / `verifyMs` 是 number(落盘生效)。

## 5. 这个粒度够不够

回答"是不是 worker 阶段慢"——够(workerMs vs verifyMs)。
回答"worker 里是启动慢还是 CDP 慢"——**部分够**:workerFirstOutputMs 能区分"启动+首轮LLM"和"工具执行",但"工具执行里 CDP 连接多久"还要 worker 子进程内部配合(subagent 层),那是后续。本次先拿到 task 层能看见的最细粒度。

## 6. 后续(本次不做)

- **worker 子进程内部细分**(CDP 连接 / 脚本执行 / 单次 sleep):需 subagent 层在子进程事件流里加时间戳,改动面更大,留待数据证明 workerMs 是大头后再做。
- **taskbook 内容沉淀**(同事说的机制问题:bilibili_scraper.py 没进 taskbook、相对时间没写):那是 taskbook 质量问题,不是计时能解决的,属另一个方向。
