# Shared Driver Session 架构

更新时间: 2026-06-20

`extensions/shared/driver-session.ts` 是 Judge 使用的 in-process Driver session 底座;它来自早期 Flow/Judge 共用抽象,Flow 已移除。

## 为什么抽到 shared

Judge 需要这一组底层能力:

- 创建隔离 agent session。
- 注入专用 agent definition。
- 订阅运行时事件。
- 把 text delta、tool start/end、agent end 等事件转成可展示 transcript。
- 在 streaming 时 `steer`,空闲时 `prompt`。
- 暴露 widget lines 和 transcript tail。

这些能力不是 Judge 的业务逻辑,因此保留在 `extensions/shared/`。

## 当前文件关系

- `extensions/shared/driver-session.ts`
  - 主实现。
  - 导出 `createDriverSession`、`defaultDriverSessionFactory`、`DriverSession`。
  - 提供 `ask(text)` 用于一次性收集当前 assistant 响应。

- `extensions/shared/driver-view.ts`
  - `DriverTranscriptTail`。
  - 负责 transcript 累积、截断、widget 展示格式。

- `extensions/judge/judge-driver.ts`
  - 使用 shared session 创建 Judge Driver。
  - 叠加 Judge 专属 wakeup、runningTools、live.log、stale wakeup 防护。

## `ask(text)` 的语义

`ask(text)` 是给 Judge decider/finalizer 用的当前轮响应采集 API。

它会:

1. 注册一次 capture。
2. 如果 session 正在 streaming,调用 `steer(text)`;否则调用 `prompt(text)`。
3. 收集本轮 `message_update.text_delta`。
4. 如果没有 delta,在 `message_end` 读取 assistant text。
5. 返回本轮文本并移除 capture。

它取代了早期的 transcript diff 方案。不要重新引入 `sliceNewTranscript(before, after)` 作为 Judge 判定依据。

## 工具边界

当前 pi runtime 支持 `getActiveTools()` / `setActiveTools()` 管理主会话 active tools,但 Driver session 尚没有 per-session tool allowlist 的产品化封装。

因此:

- 主会话模式切换可以保存并恢复 active tool 快照。
- Driver 的工具约束主要来自 agent definition、expected tool 检查和 Judge 监督。
- 如果要做严格 Driver 工具隔离,应优先扩展 runtime/session 层能力,不要在 Judge 层靠 prompt 或字符串过滤硬补。

## 测试入口

- `tests/shared-driver-session.test.ts`
- `tests/judge-driver.test.ts`
- `tests/judge-extension.test.ts`

发布前完整运行:

```powershell
npm test
```
