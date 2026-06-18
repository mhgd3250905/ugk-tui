# Flow Driver UI 编排抽取(DriverViewPort)

> 这是 driver UI 层的 deepening PR。把散落在 index.ts 的 8 个 driver 界面编排函数
> 收进一个有边界的模块 `driver-viewport.ts`(DriverView)。审核重点:模块边界是否
> 干净、行为是否等价、子 agent 发现的 P1 是否真修了。

## TL;DR

Flow 的 driver UI 编排(focus 切换、session view attach、activity widget、session switcher)原本是 8 个函数散在 index.ts 的 1159 行闭包里,被 56 处调用,和 driver 生命周期代码混在一起,没有边界,也无法脱离真实 TUI 测试。本 PR 把它们抽进 `driver-viewport.ts`(DriverView 模块),通过注入回调解耦进程表,让 UI 编排有了 locality 和可测性。

- index.ts **967 行**(从 ~1194 减 ~227)
- driver-viewport.ts **355 行**(完整 UI 编排)
- 测试 **334 pass / 0 fail**(新增 9 个 headless 单元测试 + 1 个 shutdown 回归测试)
- 行为兼容:56 个调用点通过薄转发保持不变

---

## 一、设计初衷(为什么改)

上轮状态机 PR 合并后,index.ts 仍有 ~1194 行,其中 ~230 行是 driver UI 编排:8 个函数(focusState 管理、session-view attach/detach、activity widget 渲染、session switcher)被 56 处调用,混在 driver 生命周期代码里。问题:

1. **没有 locality**:改一个 UI 细节(比如 widget 刷新条件)要在 index.ts 里穿行,和 driver 进程管理代码交织。
2. **无法独立测试**:这些函数埋在 index.ts 闭包里,只能靠 mock 整个 ctx.ui 间接测,碰不到 focus/session-view 的状态流转本身。
3. **状态散落**:focusState、activeSessionViewDriverKey 是闭包变量,UI 编排函数和事件 handler 都直接读写,边界模糊。

这是 deepening 机会:把 UI 编排收进一个有接口的模块,behind 一个小接口藏住 banner/widget/switcher 的渲染细节。

## 二、设计决策

| 决定 | 选择 | 含义 |
|---|---|---|
| 抽成什么 | **DriverView 模块**(不是端口接口) | 当前只有一个 TUI 实现,但测试需要 headless stub——这坐实了 seam |
| 怎么解耦进程表 | **注入回调**(getSession/isLiveSession/getViewableDrivers/listSummaries) | UI 层不持有 liveDrivers/retainedDrivers,通过回调按需读 |
| 调用点怎么处理 | **index.ts 保留薄转发** | 56 个调用点不改,只改函数体为 driverView.xxx,降低 churn |
| focusState 归属 | **迁进 DriverView** | 它是 UI 状态,归 UI 模块;事件 handler 改读 driverView.focusState |

关键设计点:
- **DriverView 持有 focusState + activeSessionViewDriverKey**(纯 UI 状态),不持有进程表。
- **通过构造注入的回调**访问进程表,UI 层不耦合进程管理。
- **focusState getter 浅拷贝**:返回拷贝而非内部引用,防外部 aliasing 污染状态(子 agent P3 建议)。

## 三、模块边界(改了什么)

```
index.ts (967行)                ← 命令路由 + driver 生命周期 + 事件 handler
  └─ driver-viewport.ts (355行,新)  ← DriverView: focus/session-view/widget/switcher 编排
       构造:接收 ctx + getSession/isLiveSession/getViewableDrivers/listSummaries/persistFocus/getDriverKey
       持有:focusState, activeSessionViewDriverKey
       暴露:focus / clear / refreshActivity / refreshFocus / updateSwitcher /
             detachSessionView / restoreFromEntries / focusState(getter) /
             activeSessionViewDriverKey(getter)
```

**index.ts 保留薄转发**(renderFocus/clearFocusedDriver/attachDriverBySummary/updateSessionSwitcher/renderMainDriverActivity),所以 56 个调用点不用改。

**事件 handler 改动**:session_start 用 driverView.restoreFromEntries/clear;input handler 用 driverView.focusState/clear;session_shutdown 用 driverView.detachSessionView。

## 四、子 agent review 发现的 P1(关键)

合并前派了独立 subagent review,发现一个测试绿但真实会崩的 bug:

**P1:session_shutdown ReferenceError**
- index.ts:936 调 `detachVisibleSessionView(ctx)`,但 refactor 时该函数搬进 driver-viewport.ts 且变模块私有(未 export)。
- **330 pass 测试没抓到**:现有 shutdown 测试都用 `await handler()` 无参调用,ctx 为 undefined,`if(ctx)` 跳过那行。真实框架传 ctx 时 ReferenceError,整个 shutdown 路径(driver pause/dispose/writeGuard 释放)全断。
- **修复**:DriverView 加 `detachSessionView(ctx)` 方法,index.ts 改用它。补回归测试:attach driver → 带 ctx 调 shutdown → 断言 detach 发生 + 不抛错。该测试在修复前会炸 ReferenceError。

这正是"测试绿 ≠ 没 bug"的活例子,也是独立 review 的价值。

## 五、验证

```bash
npm test          # 334 pass / 0 fail
git diff --check  # 通过
```

- **新增 9 个 headless 单元测试**(tests/flow-driver-viewport.test.ts):focus/clear/refresh、attached-vs-opened 文案、summary-only、restoreFromEntries、updateSwitcher(2)、focusState getter 不可变。
- **新增 1 个 shutdown 回归测试**(tests/flow-extension.test.ts):带 ctx 调 shutdown,堵住"无参调用"盲区。
- **行为等价性**:子 agent 逐行对比 git 历史确认 focus/clear/renderFocus/attachDriverBySummary 主路径逻辑等价,widget 刷新条件、session view attach/detach 时机、notify 文案一致。

## 六、已知的行为差异(有意改进,已注明)

子 agent 指出 input handler 的 "focused driver 找不到" 分支:原版只 renderFocus,新版 clear() 会多调一次 updateSwitcher。这是**有意改进**(避免 stale switcher),commit message 已注明。

## 七、审核建议

重点看:
1. **driver-viewport.ts 的 createDriverView 接口**:回调注入是否干净,UI 层有没有意外耦合进程表。
2. **P1 回归测试**(tests/flow-extension.test.ts 的 "session_shutdown detaches..." ):是否真的堵住了盲区(回退修复会炸)。
3. **focusState getter 浅拷贝**:防 aliasing 是否到位。
4. **薄转发是否完整**:index.ts 的 5 个转发函数是否覆盖所有外部调用点。

不需要逐行看 diff——4 个 commit 每个都有清晰 message。

## 八、与状态机 PR 的关系

本 PR 基于上轮状态机 PR 合并后的 main。两者正交:
- 状态机 PR 管 task 生命周期状态(task-state)
- 本 PR 管 driver UI 编排(driver-viewport)
- 唯一交集:index.ts 的事件 handler 同时用两者(driverView.focusState + transition)

## 关键文件导航

| 文件 | 看什么 |
|---|---|
| `extensions/flow/driver-viewport.ts` | DriverView 模块(createDriverView + 接口) |
| `tests/flow-driver-viewport.test.ts` | headless 单元测试(理解模块行为最快) |
| `tests/flow-extension.test.ts` 的 shutdown 回归测试 | P1 修复的验证 |
