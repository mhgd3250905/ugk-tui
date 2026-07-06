# 2026-07-06 项目开发导览与对抗式审计报告

## 范围

本轮审计覆盖当前工作树 `feat/0706-project-review` 的入口、运行路径、模块边界、文档有效性和已核实修复。入口级导览以 `docs/PROJECT-GUIDE.md` 为长期维护页,本报告记录本轮推理、发现、修复和验收。

## 入口级运行路线图

| 路线 | 入口 | 主路径 | 关键依赖 | 验收点 |
|---|---|---|---|---|
| CLI 启动 | `package.json` bin `ugk` | `bin/ugk.js` -> runtime policy/patch -> workspace trust -> pi `main()` + `-e extensions` | `bin/ugk-cli-args.js`, `bin/update-preflight.js`, `extensions/index.ts` | `tests/ugk-command.test.ts`, `tests/runtime-policy.test.ts` |
| 扩展注册 | `extensions/index.ts` | 注册工具/命令/事件钩子/resources | `builtin-tool-render`, `subagent`, `task`, `chrome-cdp`, `web-search`, `mcp`, `compaction`, `ui-*` | `tests/*extension*.test.ts`, `/ugk` 状态 |
| task 创建/复用 | `/task`, `run_task` | `extensions/task/task.ts` -> dispatcher/worker/verify/checker -> taskbook 存储 | `task-book`, `task-worker`, `task-verify`, `task-share-*`, `shared/taskbook-schema.js` | `tests/task-*.test.ts`, `tests/subtask-tool.test.ts` |
| task 市场发布 | `/task publish` | `task-share-publish.ts` 打 zip -> `functions/api/tasks/submit.js` -> `functions/_lib/marketplace.js` -> D1/R2 | `fflate`, D1 migrations, R2 `TASK_UPLOADS` | `tests/task-share-publish.test.ts`, `tests/task-marketplace-functions.test.ts` |
| task 市场安装 | `ugk task install/update/remove` | `bin/task-install.js` -> `/api/manifest` -> `/api/tasks/:name/files` | `shared/taskbook-schema.js`, R2 loose files | `tests/task-install.test.ts` |
| Web 搜索 | `web_search`, `web_read`, `/web-search` | `extensions/web-search/index.ts` -> launcher/client/search/read | Chrome 9223, isolated profile `~/.ugk/web-search-profile` | `tests/web-search.test.ts` |
| 本地 Chrome CDP | `chrome_cdp`, `/cdp` | `extensions/chrome-cdp/index.ts` -> launcher/client/tab-session | user Chrome profile, ask/on/off policy, autopilot carve-out | `tests/chrome-cdp-*.test.ts` |
| MCP tools | `/mcp`, MCP dynamic tools | `extensions/mcp/index.ts` -> config/registry/tools/permissions | `.mcp*.json`, stdio servers, permission state | `tests/mcp-*.test.ts`, `tests/integration/mcp-*.test.ts` |
| cron | `npm run cron:start`, `cron` tool | `cron/service.ts` HTTP daemon -> spawn `ugk --print` | `cron/agent-bin.ts`, `extensions/cron-contract.ts` | `tests/cron-*.test.ts` |
| UI/语言/状态 | `extensions/ui-*`, `/language`, `/ui-language` | session hooks -> header/footer/statusline/settings | `shared/settings-io.ts`, `shared/ui-language.ts` | `tests/ui-*.test.ts`, `tests/language.test.ts` |

## 审计发现与处理

| 优先级 | 发现 | 核实结果 | 处理 |
|---|---|---|---|
| P0 | 已发布 submission 的网页 zip 下载断链 | `submitTask` 把 zip 拆成 R2 loose files,`downloadSubmissionArtifact` 却读取 `artifact_key` 本身 | 已修:按 `file_list` 读取 loose files 并重建 zip |
| P1 | 同 name/version 的 pending submission 可覆盖 R2 loose files | 原逻辑只拒绝已发布版本,待审同版本可再次上传同前缀 | 已修:上传前拒绝非 rejected 的同版本 submission |
| P1 | 审核发布同版本冲突会静默错位 | `task_versions` 有唯一约束,但 `reviewSubmission` 先更新 task 再 `ON CONFLICT DO NOTHING` | 已修:发布前确认同版本未被其他 submission 占用 |
| P1 | manifest 可能暴露不可安装条目 | `file_list` 坏 JSON、缺核心文件或路径非法时仍可能进入任务列表/触发异常 | 已修:manifest 生成时 fail closed,只返回可安装任务 |
| P2 | `serveTaskFile` 非法路径抛异常 | `assertSafePath()` 直接抛出,Worker 会表现为 500 | 已修:返回 400 `invalid_file` |
| P2 | 入口文档过期 | README/AGENTS/PROJECT-GUIDE 漏 `/doctor`、`web_read`、`/web-search restart`、prompt 命令和真实更新菜单 | 已修:同步用户文档、运行时上下文、项目导览和 welcome prompt |
| P2 | 历史报告未标历史 | 2026-06-24/27 报告引用已不存在的 judge/skill/主题结论,易被后续 agent 当当前待办 | 已修:文件顶部加历史快照提示 |
| P2 | `settings.json` 契约清单过期 | `docs/extension-contracts.md` 漏 language/uiLanguage/compaction/builtin-tool-render 读取点 | 已修:补读取点列表 |
| P1 | 供应链审计 high severity | `npm audit` 指向 `@earendil-works/pi-coding-agent@0.79.4` 间接依赖 `undici/protobufjs/ws` | 未修:pi runtime 升级是独立兼容任务 |
| P2 | `extensions/task/task.ts` 仍是巨型协调文件 | 命令分发、工具注册、事件钩子、渲染、run_task 内核混在一起 | 不拆:当前无必要重构触点 |
| P2 | 跨层依赖仍存在 | `extensions/update-check.ts -> bin/update-core.js`;`cron/service.ts -> extensions/cron-contract.ts` | 不动:抽共享层会扩大 diff,收益不覆盖本轮目标 |

## 已执行修复

1. `functions/_lib/marketplace.js`
   - `downloadSubmissionArtifact()` 按 `submission.file_list` 重建 zip。
   - `submitTask()` 拒绝非 rejected 的同 name/version submission。
   - `reviewSubmission()` 发布前拒绝被其他 submission 占用的同版本。
   - `buildManifest()` 跳过坏 `file_list`、缺核心文件或非法路径的任务。
   - `serveTaskFile()` 对非法路径返回 400 JSON。

2. `tests/task-marketplace-functions.test.ts`
   - 覆盖 published artifact zip 重建。
   - 覆盖 duplicate pending submit 不覆盖 R2。
   - 覆盖 review 阶段同版本冲突。
   - 覆盖 manifest 跳过不可安装任务。
   - 覆盖 `serveTaskFile` path traversal 400。

3. 文档与入口
   - 更新 `README.md`, `AGENTS.md`, `docs/PROJECT-GUIDE.md`, `docs/extension-contracts.md`, `prompts/welcome.md`。
   - `/ugk` 状态面板补齐 `web_search/read`, `run_task` 和主要 slash 命令。
   - 给两份历史报告加过期提示,避免误导后续审查。

## 剩余风险

1. pi runtime 依赖审计风险仍在。应单独开分支验证 `@earendil-works/*` 升级,不能混在普通修复里。
2. `task` 主协调文件仍大。只有在碰相关流程时才拆一条边界,不为“好看”重构。
3. marketplace upload 仍是 D1 + R2 两阶段写入。当前修复解决顺序重复提交,高并发竞态需要另一个以唯一 artifact prefix 或事务化提交为目标的设计任务。

## 验收记录

- `node --test tests/task-marketplace-functions.test.ts tests/ugk-command.test.ts`: 54 pass。
- `npm test`: 670 pass, 2 skip。
- `npm run test:integration`: 37 pass。
- `npm pack --dry-run --json`: 通过,`entryCount=148`;包内无 `functions/`、`migrations/`、`scripts/`、`docs/`、`wrangler.toml`。
- `npm audit --json`: 仍有 4 个 high。根因是 `@earendil-works/pi-coding-agent@0.79.4` 间接依赖 `undici/protobufjs/ws`;audit 建议升到 `@earendil-works/pi-coding-agent@0.79.10`。本轮按项目契约不混改 pi runtime。
