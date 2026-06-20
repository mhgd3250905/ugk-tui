# Flow 当前状态

更新时间: 2026-06-20

Flow 是 UGK 中仍然保留的任务工作流。Judge 已合并,但本版本没有删除 Flow。

## 当前定位

Flow 适合需要显式 task 资产、prove/review/accept 生命周期、签名记录和可复盘运行证据的工作。

Judge 适合需要实时监督和快速纠偏的委派工作。

两者共享底层 Driver session 能力,但可靠性模型不同:

- Flow:事后结构校验、review gate、签名记录。
- Judge:实时观察、steer/abort、最终验收。

不要把 Flow 的签名链和状态机要求套到 Judge 上;也不要把 Judge 的实时监督语义反向改写到 Flow task 资产里。

## 用户入口

- `/flow task create "目标"`
- `/flow task prove <task-id>`
- `/flow run <task-id>`
- `/flow task review <run-id>`
- `/flow attach`
- `/flow detach`
- `/flow status`

## 代码入口

- `extensions/flow/index.ts`
- `extensions/flow/task-store.ts`
- `extensions/flow/task-state.ts`
- `extensions/flow/run-validation.ts`
- `extensions/flow/review-store.ts`
- `extensions/flow/driver-session.ts`

`extensions/flow/driver-session.ts` 是兼容 re-export。新的共享实现位于 `extensions/shared/driver-session.ts`。

## 文档状态

以下文档仍可作为 Flow 背景材料,但不是 Judge 规范:

- `docs/design/2026-06-18-flow-signed-records-design.md`
- `docs/superpowers/plans/2026-06-17-flow-task.md`
- `docs/superpowers/plans/2026-06-17-flow-interactive-driver.md`
- `docs/superpowers/specs/2026-06-17-flow-task-design.md`
- `docs/superpowers/specs/2026-06-17-flow-interactive-driver-design.md`
- `docs/reports/*flow*.md`

如果这些历史文档提到 `extensions/flow/driver-session.ts` 是主体实现,按当前代码理解为历史说法。当前主体实现是 `extensions/shared/driver-session.ts`,Flow 文件只保留兼容导出。

## 合并/发布前验证

Flow 仍在主测试套件中。发布前至少运行:

```powershell
npm test
```

如果改动触及 Flow 状态机或签名链,还应重点关注:

- `tests/flow-task-state.test.ts`
- `tests/flow-signing.test.ts`
- `tests/flow-run-validation.test.ts`
- `tests/flow-extension.test.ts`
- `tests/flow-driver-session.test.ts`
