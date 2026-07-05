# 项目审查整改报告

日期: 2026-07-05
分支: `feat/codex-0703`
状态: 已完成本轮整改,待 main 审核验证

## 本轮结论

本轮没有做大重构。只处理一个已经造成真实漂移的问题: taskbook 包校验在 CLI、runtime、Marketplace 三处各写一份,服务端会接受 CLI 安装端拒绝的坏包。

## 已直接修改

- 新增 `shared/taskbook-schema.js`,集中校验 `taskbook.json`、`spec.json`、`contract.json`。
- `bin/task-install.js` 改用共享 schema,删除本地重复校验。
- `extensions/task/task-book.ts` 改用共享 schema,保持现有 TypeScript 类型出口不变。
- `functions/_lib/marketplace.js` 改用共享 schema,服务端提交校验与 CLI 安装校验一致。
- `tests/task-marketplace-functions.test.ts` 增加回归:缺 `createdAt` / `updatedAt` 的 taskbook 必须被 Marketplace 拒绝。
- `extensions/task/task.ts` 修正 publish 注释,避免继续暗示只打 5 个核心文件。
- `README.md` 同步 `/ugk`、`/plan`、workspace trust、skills、`user-skills/` 等当前事实。
- `docs/PROJECT-GUIDE.md` 同步 v2.3.0 后续状态、compaction 能力、测试说明和 debug_log 现状。
- `docs/DEVELOPMENT.md` 修正默认模型与 doctor shell path 说明。
- `skills/ugk-guide/SKILL.md`、`skills/skill-guide/SKILL.md` 删除/替换过期 Judge 和不存在 skill 说明。
- `docs/design/subtask-extension-spec.md` 标记 subtask/run_task 已实现。
- `docs/design/task-extension-spec.md` 标记 Judge 引用为历史设计上下文。
- `docs/design/2026-07-01-task-publish-from-tui.md` 标记 scripts 打包逻辑已经修正。

## 已验证

- `npm run test:all`
  - 单元测试: 636 tests, 634 pass, 2 skipped, 0 fail
  - 集成测试: 36 pass, 0 fail
- `npm pack --dry-run --json`
  - `shared/taskbook-schema.js` 已进入 npm 包
  - entryCount: 141

## 审查发现但本轮未改

- `smoke:rpc` / `smoke:task` 还没有进入默认 `test:all`;建议作为 release gate 或 nightly。
- Marketplace 仍缺 Miniflare/Pages + D1 真实链路测试;当前测试 fake 较强。
- cron service 真实 HTTP/持久化/调度测试不足。
- bash command-policy 有重复;下次改权限规则时抽共享 primitive。
- cron contract/formatter 有反向依赖;下次碰 cron 时拆纯 contract。
- `update-core.js` 位于 `bin/`,extension 反向 import;下次改 update 时移到 shared/core。
- `extensions/task/task.ts` 仍大;只在下次 task 改动横跨 run/command/hooks 时拆。
- `debug_log` 是历史开发表;远端已应用旧 migration,如要清理应新增 cleanup migration,不改历史 migration。

## main 审核建议

合并前在 main 或 PR CI 上至少跑:

```bash
npm run test:all
npm pack --dry-run --json
```

如果准备发布,再补跑:

```bash
npm run smoke:rpc
npm run smoke:task
```
