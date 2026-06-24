# ugk-core 项目上下文

## 角色

你是基于 [pi](https://github.com/earendil-works/pi) (pi-coding-agent) 定制的编码 agent,名为 **ugk-pi-agent**。

## 工作风格

- 简洁
- 优先复用 pi 已有能力,而非新建
- 危险操作前确认(权限门已对 `rm -rf` / `sudo` / `chmod 777` 启用)

## 已实现能力(v2.0.0)

### 自定义工具(extensions/)
- `scrcpy` — 安卓投屏控制(start/stop/status/version,内置 ADB 路径复用避免断连)
- `subagent` — 子代理委派(single/parallel/chain 三模式,隔离 context 只回摘要)
- `cron` — 定时任务管理(status/list/add/remove/history,代理常驻 cron 服务)
- `chrome_cdp` — 受保护的本地登录态 Chrome 控制(status/tabs/navigate/evaluate/screenshot,默认 ask-gated)
- `judge` — 实时监督模式:先对齐 RequirementsSpec,再委派 Driver 执行,由 Judge 在关键节点放行/纠偏/终止/最终验收
- `mcp` — MCP stdio client:从 install/user/project/local 配置连接外部 MCP server,把 tools 注册为 `server__tool`,含 spawn policy、per-tool ask/on/off、reload stale 处理和 session 清理
- `run_task` — subtask 工具:让 main agent 像调 subagent 一样复用已机器验收的 taskbook,返回 PASS/FAIL + 产物路径(确定性、可验收,区别于 subagent 的灵活探索)

### plan-mode 只读探索模式
- `/plan` 切换只读模式(或 Ctrl+Alt+P)
- 只读模式工具限制:read/bash/grep/find/ls/questionnaire
- bash 白名单:只放行只读命令(grep/cat/git status/ls 等),拦 rm/git commit/npm install/重定向
- 计划提取:agent 回复带 `Plan:` 段落自动抽编号步骤
- 进度跟踪:`[DONE:n]` 标记 + widget ☐/☑ + 状态栏 `📋 N/M`
- 稳定阶段边界:阻止 `curl | sh`、`curl -o`、curl 上传/变更请求等非只读 bash 形态

### Chrome CDP 本地浏览器控制
- `/cdp status|ask|on|off|port|launch|tabs`
- 默认 `ask` 模式,控制本地登录态 Chrome 前需要说明原因并经过用户确认
- 仅用于 SSO/cookie/CAPTCHA/私有工作区/本地 Chrome 状态,不替代普通联网检索
- 详见 `skills/chrome-cdp-guide/SKILL.md` 与 `extensions/chrome-cdp/README.md`

### MCP tools 接入
- `/mcp status|ask|on|off|reload|enable <server>|disable <server>`
- 配置路径:install `<ugk安装目录>/mcp.json`,user `~/.config/ugk/mcp.json`(Win `%APPDATA%\ugk\mcp.json`),project `.mcp.json`,local `.mcp.local.json`
- scope 合并:install < user < project < local;同名 server 高 scope 完全覆盖低 scope
- install/user scope 视为 UGK 级可信配置;project/local scope 连接前必须确认;非交互模式 fail-closed,只允许 install/user scope
- 工具名统一 `server__tool`,server/tool 名会 provider-safe 规范化
- `/mcp reload` 不调用不存在的 unregisterTool;消失 server 的工具从 active tools 下线,stale 工具被调用时返回 disconnected
- `/doctor` 的 MCP 项只读配置和当前 registry 状态,绝不 spawn server
- 详见 `skills/mcp-guide/SKILL.md`

### Judge 实时监督模式
- `/judge` 打开 Judge 菜单;`/judge toggle` 开关;`/judge check-bash-window` 检查 bash 新窗口 live log;`/judge ack` 接受等待确认的 PASS 交付。
- 三阶段:aligning(用 questionnaire 对齐 Spec) → driving(Driver 执行 + Judge 监督纠偏) → delivering(最终验收和用户确认)。
- Driver 完成必须调用 `judge_complete`;Judge 会对照 `RequirementsSpec.acceptance` 做最终 PASS/FAIL。
- 过程日志写入 `<cwd>/.judge/<runId>/live.log`;Windows 使用 Git Bash + `cmd start "" ... tail -f`,不做 Windows Terminal 特殊适配。
- 详见 `docs/judge.md`。旧 `docs/handoff/` 和早期设计文档只作历史材料,不得覆盖 `docs/judge.md` 的当前事实。

### task 固定任务委托系统
- `/task` 打开 task 菜单(中文,零命令记忆);`/task list|show|new|run|edit|rename|save|delete|toggle|exit`
- 四阶段创造:`planning`(探索性只读对齐 RequirementsSpec)→ `executing`(task-creator 亲手做一遍,放开环境工具但禁 subagent/run_task)→ `reviewing`(产 skill+verify+contract)→ `landed`(taskbook 就绪)
- **planning 探索性 bash(C-3)**:write/edit 禁用,但 bash 可跑脚本/测试/构建验证方案可行性(`node`/`npm test`/`python` 等),只拦留持久副作用的命令(写盘、`npm install`、git 变更、重定向 `>`)。判定走 `isPlanningAllowedCommand`(`task-utils.ts`),非破坏即放行。planner 若需真正产出/改代码,仍由 prompt 引导先用 questionnaire 确认进入 executing 阶段(不污染 planning 的对齐 context)。reviewing 阶段保持只读不动。要改成放开全部工具(C-2)需用户拍板并同步改 spec 2.1/4.1。
- `/task rename <old> <new>` 改 taskbook 名(目录 + `taskbook.json:name` 一起搬,保留 `runs[]`/`createdAt`);仅原 scope 内改名,目标名已存在或同名则拒绝。
- 复用流程:`/task run <name> <自然语言>` → dispatcher 翻译 input(走 `ctx.model`,可选 `contract.dispatcherModel` 覆盖)→ worker 子进程 spawn 执行 → verify.mjs 机器验收 → PASS/FAIL
- taskbook = `spec.json` + `skill.md` + `verify.mjs` + `contract.json`(artifacts/runtimeInput/requiredTools),user scope 存 `~/.pi/agent/tasks/`,project scope 存 `<cwd>/.tasks/`
- `run_task` 工具:LLM 可调,与 `subagent` 平级。**两条铁律:需求驱动(任务确定才匹配 taskbook,不是逛商店);责任归 LLM(dispatcher 工具场景翻译失败直接报错,不弹 UI 兜底,headless 标志)。task 是最小单位,不可嵌套。**
- system prompt 注入 taskbook 清单(name + description),由 `buildTaskbookPrompt`(`task-registry.ts`)解耦生成
- 详见 `docs/design/task-extension-spec.md`(taskbook 创造+复用)和 `docs/design/subtask-extension-spec.md`(run_task 编排)

### ugk 品牌 UI
- `extensions/ui-brand.ts` 通过 pi UI hook 设置 header/footer/title
- header/footer 组件不得在 render 阶段持有或读取 `ExtensionContext`;必须在 `session_start` 时抽取普通 session 数据,避免 session replacement/reload 后 stale ctx 崩溃
- `/ugk-ui on|off|status` 可运行中切换
- `themes/ugk-geek.json` 提供默认低刺激荧光绿主题

### slash 命令
- `/ugk` — 看 agent 状态
- `/welcome` — 欢迎模板
- `/check-env` — 一键自检 adb/scrcpy/设备连接,缺失项给 winget 安装命令
- `/update` — 手动检查 GitHub main 并用 UGK 语境提示“现在更新/跳过本次/跳过到下个版本”
- `/cdp` — 管理本地 Chrome CDP 访问模式、端口、启动和标签页
- `/mcp` — 管理 MCP server 状态、权限模式、reload、enable/disable
- `/task` — 固定任务委托(taskbook 创造/复用/编排)
- `/ugk-ui` — 开关 ugk 品牌 UI
- `/implement` `/scout-and-plan` `/implement-and-review` — subagent 流水线

### @mention 手动触发
输入 `@<agent名> <任务>` 自动改写为 subagent 委派。agent 名从 `~/.pi/agent/agents/` 动态读。

### cron 定时服务(独立常驻进程,非 ugk 内)
- `npm run cron:start` 启动,监听 127.0.0.1:17741
- 到点自动起 `ugk --print` 子进程跑 agent 任务,结果存 `~/.pi/agent/cron-output/`
- 任务持久化到 `~/.pi/agent/cron-jobs.json`,重启不丢
- 详见 `skills/cron-guide/SKILL.md`

### skills
- `ugk-guide` — 占位示例
- `adb-guide` — Android adb 操作大全(8 文件)
- `scrcpy-guide` — scrcpy 投屏安装与使用
- `subagent-guide` — 子代理委派指南(@mention/三模式/自定义)
- `cron-guide` — 定时任务指南(服务启动/crontab 速查/安全说明)
- `chrome-cdp-guide` — 本地登录态 Chrome/CDP 使用边界与安全流程
- `mcp-guide` — MCP server 配置、权限、命令和排障指南
- `skill-creator` — 创建、改进和评测 agent skill(来自 Anthropic skills)
- `docx` — 创建、读取、编辑 Word `.docx` 文档(来自 Anthropic skills)

### 权限门
拦截 `rm -rf` / `sudo` / `chmod 777`,交互模式弹确认,非交互直接拦截。

## 关键约定

- **bash 工具走 Git Bash**(`D:\Git\bin\bash.exe`),命令用 Linux 语法,Windows 路径用正斜杠
- **subagent 的 agent 定义** 在仓库 `agents/*.md`(版本管理),需复制到 `~/.pi/agent/agents/` 才生效(见 subagent-guide skill)
- **模型**:全局默认 `deepseek-v4-pro`;`agents/*.md` 的 frontmatter 记录角色意图,但当前 pi 运行时不靠修改这些 frontmatter 来切换 Judge/Driver 的实际模型。需要更换模型时必须改 session 创建/模型选择代码并补测试。
- **任务书**:存 `.judge/taskbooks/<name>/`,project scope。Judge+Driver 跑通一次可存为任务书,`/judge run <name>` 跳过 ALIGN 直接开跑但保留完整 Judge 监督。改 Judge/Driver 的 agent 定义或 taskbook schema 必须同步更新 `docs/judge.md` 任务书章节。
- **taskbook**:`/task` 的固定任务沉淀,存 user scope(`~/.pi/agent/tasks/<name>/`)或 project scope(`<cwd>/.tasks/<name>/`),每个含 `spec.json`+`skill.md`+`verify.mjs`+`contract.json`+`taskbook.json`。`run_task` 工具和 `/task run` 共用同一套复用链路(dispatcher→worker→verify)。改 task 模块的核心函数签名或 task 状态机必须同步更新 `docs/design/subtask-extension-spec.md`。
- **运行时发行策略**:pi 是 UGK 的内部 runtime,每个 UGK 版本必须固定一个明确的 pi 版本。不要让用户看到或执行 `pi update`;pi 升级只能通过 UGK 项目主动升级依赖、完成兼容验证并发布新的 UGK 版本。
- **pi runtime patch**(`bin/ugk-*.js`,在 `bin/ugk.js` 启动时安装,仿 `installUgkSessionViewPatch` 的 idempotent 范式:`Symbol.for()` 守卫 + proto 包装 + 返回 false 时 `console.warn`):`installUgkSessionViewPatch`(session 视图/autocomplete)、`installUgkPackageUpdatePatch`(压制 `pi update` 提示)、`installUgkExtensionOverlayPatch`(扩展 overlay 打开时暂停 `Working...` spinner,消除 questionnaire 等输入框的闪烁)。pi 升级后每个 patch 的 descriptor/方法检查可能失效,需回归。
- **UGK 更新策略**:启动入口在进入 TUI 前检查 GitHub `main` 最新 commit,显示 Codex CLI 风格的 `Update now / Skip / Skip until next version` 菜单。开发仓库内更新走 `git pull --rebase origin main && npm install`,正式 npm 安装场景走 `npm install -g ugk-agent`;成功后提示重启并退出,不继续加载旧 TUI。`/update` 是会话内手动入口。
