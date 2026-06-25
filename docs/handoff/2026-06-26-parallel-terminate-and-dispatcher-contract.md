# 并行编排被截断 + dispatcher 解析失败根因分析

> 日期：2026-06-26
> 触发场景：`帮我把这个up主的第一页视频都下载下来`（先抓列表 → 再批量下载的两段式组合任务）
> 关联提交：`d46726b`

## 现象

1. 第一步 `run_task bili-up-homepage-spider` PASS 后，agent 不自动继续做第二步（下载），用户必须手动说"继续吧"。
2. 第二步 `run_task bilibili-downloader` 报：`dispatcher 未能从输入解析出 runtimeInput(字段: bilibili_url）`。

## 根因

### 问题一：第一步 PASS 后 agent loop 退出

**机制确认（不是猜测）**：`terminate` 字段由 `pi-agent-core`（agent loop 真正所在）消费，不在 `pi-coding-agent`：

- `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:119`：
  ```js
  hasMoreToolCalls = !executedToolBatch.terminate;
  ```
- `run_task` 的 tool result 无条件带 `terminate: true`（旧 task.ts:1549）。
- `terminate:true` → `hasMoreToolCalls=false` → 内层循环退出 → 无排队 steering/follow-up → 外层循环退出 → `agent_end` → 控制权交还用户。

**`terminate:true` 的历史**：当初为解决"PASS 后进入 Steering 卡死"加的。那个卡死的根因是工具后的**自动总结轮**若 provider 卡住，Esc 接不住。terminate 避开那轮。但副作用是**截断组合任务**——agent 没机会自动决定下一步。

> 调查教训：第一轮在 `pi-coding-agent` dist 搜 `terminate` 零命中，误判"pi 不读 terminate"。实际在依赖包 `pi-agent-core`。grep 要覆盖整个 `node_modules/@earendil-works/*`。

### 问题二：dispatcher 解析不出 bilibili_url

**根因**：bilibili-downloader 的 contract 写得太"裸"：

```json
// 改前（缺 description）
{
  "runtimeInput": ["bilibili_url"],
  "requiredTools": ["chrome_cdp", "bash"]
}
```

- 只有字段名 `bilibili_url`，**没有 runtimeInputMeta、没有 description**。
- dispatcher（无论 local 正则还是 LLM）拿不到字段格式说明，抽不出来。
- 对比 bili-up-homepage-spider 的 contract 有完整 description，所以那个能解析成功。
- **这是 taskbook 作者的 contract 质量问题，不是框架 bug。**

### 问题三：是否支持并行编排

支持：`{tasks:[{name,input}]}` 格式，最多 8 个（`SUBTASK_MAX`），并发 4（`SUBTASK_CONCURRENCY`，task.ts:47）。40 个视频需分批。但每个 task 的 `input` 都走 dispatcher 解析，contract 质量差时批量解析更易集体失败。

## 修复

### 1. terminate 按 mode 区分（task.ts:1543-1550）

```ts
// single:一次性确定性任务,terminate 避开卡死总结轮(原语义保留)
// parallel:往往是多步骤编排的一部分,terminate 会截断组合任务,不 terminate
terminate: parsed.mode === "single",
```

- single 模式：保留 `terminate:true`（一次性任务该终止，且避开历史卡死问题）
- parallel 模式：**不 terminate**，让 agent 在 PASS 后自动继续编排下一步

### 2. 补 bilibili-downloader contract（user scope，不在仓库）

```json
"runtimeInputMeta": {
  "bilibili_url": {
    "description": "B站视频链接,格式 https://www.bilibili.com/video/BVxxxxxx 或纯 BV号。dispatcher 从用户输入里抽取这个 URL。",
    "required": true
  }
}
```

### 3. 测试（tests/subtask-tool.test.ts）

新增 `run_task parallel does NOT terminate`，断言 parallel 模式 result.terminate 不为 true。现有 single 模式 terminate 断言不变。507/507 全绿。

## 修复后的预期行为

`帮我把这个up主第一页视频都下载下来`：
1. agent `run_task bili-up-homepage-spider`（single，terminate）→ 抓到 40 条 → terminate 退出（合理，这是单步）
2. **agent 自动继续**（无需用户说"继续"）→ 读 JSON → 提取 BV 号
3. agent `run_task {tasks:[...]}`（parallel，不 terminate）→ 分批下载
4. dispatcher 能解析 bilibili_url（contract 补了 description）

## 未决 / 后续

- **框架级 contract 校验**（备选，本次未做）：taskbook 保存时强制每个 runtimeInput 字段必须有 description。防止未来再出现裸 contract。需项目组确认是否要做。
- **组合任务的最优并行度**：40 个视频分批，每批 8 个并发 4，是当前上限。是否要调高 SUBTASK_MAX/CONCURRENCY 需观察实际 CDP/下载负载。
