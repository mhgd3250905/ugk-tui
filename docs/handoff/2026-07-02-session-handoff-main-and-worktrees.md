# 会话交接:main 状态同步 + worktree 全景

> **交接日期**:2026-07-02
> **会话范围**:PR #34 审查 → main 同步 → 线上部署 → worktree 治理交接
> **目的**:把当前仓库的真实状态(本地 / 远端 / 线上 / worktree)一次性交接清楚,供新会话专门管理分支与 worktree。
> **前置阅读**:`docs/PROJECT-GUIDE.md`(项目全景,本文不重复其内容,只补"当前快照 + worktree 治理")。

---

## 1. 三方对齐快照(本次会话已核验)

| 维度 | 状态 | commit |
|---|---|---|
| 本地 `main` | ✅ 在 `main` 分支,工作区**干净** | `50d5cf2` |
| 远端 `origin/main` | ✅ 与本地**完全一致**(领先 0 / 落后 0) | `50d5cf2` |
| 线上 production | ✅ 已部署(本次会话执行) | `50d5cf2` |

**结论**:本地 = 远端 = 线上,三方同一个 commit。任何人此刻 clone/checkout `main` 拿到的就是生产环境跑的代码。

`50d5cf2` = Merge PR #34 `feat: polish task share frontend`(浅色主题 + cli-auth i18n + 此前累积的 marketplace 升级)。

---

## 2. 本次会话做了什么

1. **PR #34 审查**(对抗式):在 origin/main 真实树上跑 `npm test` → 572/572 全绿;i18n 四语言 key parity 对齐(en/zh-CN/ja/ko 各 20 cli.* + 5 theme.*);改动范围仅前端静态页+测试,无越界。质量合格。
2. **本地 main 同步**:`git pull --ff-only`,旧 HEAD `879e531` → `50d5cf2`。
3. **线上部署**:发现 production 落后 main 5 个 PR(停在 `8b98174`),执行完整部署:
   - D1 migration `0007/0008/0009`:实证**远端已应用**(三表 `cli_auth_pending`/`cli_tokens`/`debug_log` + `state` 列均在),本次无需操作。
   - `wrangler pages deploy`(仓库根,`--branch=main`):前端 + functions 一并上线,新 deployment `eb2d6fdd`。
   - 验证:首页/i18n/styles/cli-auth 200;后端 session/manifest 仍 200;新端点 cli/auth/start 返回 400(参数校验,endpoint 健康);assets 图片 200。

---

## 3. ⚠️ 部署的两个硬契约(踩坑来源,务必传下去)

线上是 **Cloudflare Pages 项目 `ugk-task-share`**,配置见 `wrangler.toml`。

### 契约 A:必须从**仓库根**跑 deploy,不能 `wrangler pages deploy docs/task-share`

官方原文:"If a `functions` folder exists where the Wrangler command is run, it will be uploaded with the project."

- ✅ 对:`npx wrangler pages deploy --project-name=ugk-task-share --branch=main`(cwd = 仓库根,`functions/` 自动随上)
- ❌ 错:`npx wrangler pages deploy docs/task-share`(positional directory 改变查找基准,`functions/` 不被识别 → **线上 API 全挂**)

### 契约 B:migration 先于部署

若 `migrations/` 有新文件,**先** `npx wrangler d1 migrations apply ugk-task-share-db --remote`,**再** deploy。否则新 functions 引用不存在的表/列,API 500。

当前远端已应用的 migration:`0007_cli_auth` / `0008_debug_log` / `0009_cli_auth_state`(均已落地)。

---

## 4. worktree 全景(本会话末状态)

**布局约定**:主仓在 `E:/AII/ugk-core`(= `main`),worktree 一律在 `E:/AII/worktrees/ugk-core/<工作目录名>/`。注意:**worktree 目录名与分支名不一致**(见下表)。

### 当前 6 个 worktree(全部实测 ahead/behind vs main)

| 工作目录(`worktrees/ugk-core/…`) | 分支 | behind | **ahead** | 状态判断 |
|---|---|---:|---:|---|
| `codex-frontend-new-features` | `codex-frontend-new-features` | 1 | **0** | 🔴 已全合入 main,死分支,可删 |
| `codex-frontend-ui-optimization` | `codex/task-marketplace-ui-followup` | 30 | **0** | 🔴 已全合入 main,死分支,可删 |
| `codex-official-tasks-polish` | `codex-official-tasks-polish` | 3 | **0** | 🔴 已全合入 main,死分支,可删 |
| `codex-scratch-20260702` | `fix/publish-scripts-and-ref-check` | 9 | **0** | 🔴 已全合入 main,死分支,可删 |
| `codex-code-audit-main-20260626` | `codex/code-audit-main-20260626` | 148 | **2** | 🟢 活,有 2 个未合并 commit |
| `codex-ugk-logo-polish` | `codex/ugk-logo-polish` | 121 | **2** | 🟢 活,有 2 个未合并 commit |

**ahead=0 的 4 个**:分支内容已在 main 里(对应 PR #30/#31/#32/#33/#34 已 merged),worktree 是残留,可安全清理。
**ahead=2 的 2 个**:有未并入 main 的 commit,删前必须确认内容是否还需要(可能已废弃,也可能待处理)。

> `/tmp/ugk-pr34-review` 临时 worktree 已被 `git worktree prune` 清除,无需处理。

---

## 5. worktree 治理建议(交给新会话决策)

### 清理 ahead=0 的 4 个(低风险,内容已在 main)

每个执行:
```bash
git worktree remove E:/AII/worktrees/ugk-core/<工作目录名>
git branch -d <分支名>          # 已合并分支,-d 安全删除
# 若远端也已合并,可选:git push origin --delete <分支名>
```

### 处理 ahead=2 的 2 个(需人工判断)

对 `codex/code-audit-main-20260626` 和 `codex/ugk-logo-polish`:
1. 先 `git log main..<branch> --oneline` 看那 2 个 commit 是什么、是否还有价值。
2. 若有价值 → 评估是否 rebase/PR 进 main;若已过时 → 直接删。
3. 这两个分支 behind 100+ commit,rebase 前先确认无冲突或单独开 PR。

### 命名约定(供未来创建 worktree)

- **目录名**:`E:/AII/worktrees/ugk-core/<feature-名>/`(短,用连字符)
- **分支名**:`codex/<feature>` 或 `feat/<feature>` 或 `fix/<feature>`(仓库现有惯例,codex/feat/fix 三前缀并存)
- 创建:`git worktree add -b <新分支> E:/AII/worktrees/ugk-core/<目录名> main`(基于最新 main)
- **避免**:目录名与分支名不一致(当前历史遗留如此,新创建应保持一致,减少认知负担)

---

## 6. 测试口径(发布前必跑)

```bash
npm test                  # 单元/逻辑(572 pass / 0 fail,当前 main)
npm run test:integration  # 集成(需真实 MCP/进程环境)
```

**注意**:`npm test` 通过数随环境浮动(`environment-doctor-skill` 的 2 个 `realBash` 守卫测试在 bash 不可用时 skip,两者都算全绿)。**别写死具体数字**,看 `fail 0` 即可。

---

## 7. 待办与遗留(承自 PROJECT-GUIDE §8,本次无新增)

- **结构债(P2)**:危险命令策略三处重复、LLM JSON 提取四处重复、taskbook contract 校验三处不一致、cron daemon 反向依赖、extension 反向 import bin/update-core.js。详见 `docs/handoff/2026-07-02-boundary-cleanup-plan.md` 附录。
- **x-search JSON 截断**:偶发,等第二次复现确认。见 `docs/handoff/2026-07-02-x-search-json-truncation-diagnosis.md`。
- **`/task publish` 体验缺陷**:一路回车易误发。非 bug,留待决策。
- **`debug_log` 表(本次部署带上线)**:0008 migration 是 DEV-ONLY 临时调试日志,已随部署上生产。flow 稳定后应删表 + 移除 `marketplace.js` 中的 `debugLog()` 调用点。**本次新增的待办项。**

---

## 8. 新会话起手清单

接手 worktree 治理的人,按顺序:

1. `cd E:/AII/ugk-core && git status`(确认在 main、干净)
2. 读本文 §4 表,决定清理范围
3. ahead=0 的 4 个:逐个 `git worktree remove` + `git branch -d`(安全)
4. ahead=2 的 2 个:`git log main..<branch>` 评估,再决定合并/删除
5. 清理后 `git worktree prune && git worktree list` 确认只剩 main + 保留的活分支
6. (可选)清理远端已合并分支:`git push origin --delete <branch>`(需逐个确认远端状态)

---

## 9. 关键文件指针

| 想了解 | 看哪 |
|---|---|
| 项目全景 | `docs/PROJECT-GUIDE.md` |
| 改代码硬规则 | `docs/DEVELOPMENT.md` + `docs/extension-contracts.md` |
| 本次部署契约 | 本文 §3 + `wrangler.toml` |
| 历史交接(按日期) | `docs/handoff/` |
| worktree 当前状态 | 本文 §4(快照,会变,以 `git worktree list` 实测为准) |
