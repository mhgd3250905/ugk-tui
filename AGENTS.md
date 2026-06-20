# ugk-core 项目上下文

## 角色

你是基于 [pi](https://github.com/earendil-works/pi) (pi-coding-agent) 定制的编码 agent,名为 **ugk-pi-agent**。

## 工作风格

- 简洁
- 优先复用 pi 已有能力,而非新建
- 危险操作前确认(权限门已对 `rm -rf` / `sudo` / `chmod 777` 启用)

## 已实现能力(v1.0.0)

### 自定义工具(extensions/)
- `greet` — 演示用打招呼
- `scrcpy` — 安卓投屏控制(start/stop/status/version,内置 ADB 路径复用避免断连)
- `subagent` — 子代理委派(single/parallel/chain 三模式,隔离 context 只回摘要)
- `cron` — 定时任务管理(status/list/add/remove/history,代理常驻 cron 服务)
- `chrome_cdp` — 受保护的本地登录态 Chrome 控制(status/tabs/navigate/evaluate/screenshot,默认 ask-gated)
- `judge` — 实时监督模式:先对齐 RequirementsSpec,再委派 Driver 执行,由 Judge 在关键节点放行/纠偏/终止/最终验收
- `mcp` — MCP stdio client:从 install/user/project/local 配置连接外部 MCP server,把 tools 注册为 `server__tool`,含 spawn policy、per-tool ask/on/off、reload stale 处理和 session 清理

### plan-mode 只读探索模式
- `/plan` 切换只读模式(或 Ctrl+Alt+P)
- 只读模式工具限制:read/bash/grep/find/ls/questionnaire
- bash 白名单:只放行只读命令(grep/cat/git status/ls 等),拦 rm/git commit/npm install/重定向
- 计划提取:agent 回复带 `Plan:` 段落自动抽编号步骤
- 进度跟踪:`[DONE:n]` 标记 + widget ☐/☑ + 状态栏 `📋 N/M`
- 稳定阶段边界:阻止 `curl | sh`、`curl -o`、curl 上传/变更请求等非只读 bash 形态

### flow task 工作流
- `/flow task create "目标"` — 进入显式 Task 草案创建流程
- `/flow task prove <task-id>` — 用真实样例证明 Task 能跑通
- `/flow run <task-id>` — 运行已 verified/active 的 Task
- `/flow task review <run-id>` — main agent 主持复盘并沉淀经验
- 设计原则:main 不记打法,task skill 记打法;driver subagent 隔离执行;todo 记录执行事实和证据;只有成功或修复成功并经用户确认的经验才能写回 Task 资产。

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

### ugk 品牌 UI
- `extensions/ui-brand.ts` 通过 pi UI hook 设置 header/footer/title
- `/ugk-ui on|off|status` 可运行中切换
- `themes/ugk-geek.json` 提供默认低刺激荧光绿主题

### slash 命令
- `/ugk` — 看 agent 状态
- `/welcome` — 欢迎模板
- `/check-env` — 一键自检 adb/scrcpy/设备连接,缺失项给 winget 安装命令
- `/update` — 手动检查 GitHub main 并用 UGK 语境提示“现在更新/跳过本次/跳过到下个版本”
- `/cdp` — 管理本地 Chrome CDP 访问模式、端口、启动和标签页
- `/mcp` — 管理 MCP server 状态、权限模式、reload、enable/disable
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
- **运行时发行策略**:pi 是 UGK 的内部 runtime,每个 UGK 版本必须固定一个明确的 pi 版本。不要让用户看到或执行 `pi update`;pi 升级只能通过 UGK 项目主动升级依赖、完成兼容验证并发布新的 UGK 版本。
- **UGK 更新策略**:启动入口在进入 TUI 前检查 GitHub `main` 最新 commit,显示 Codex CLI 风格的 `Update now / Skip / Skip until next version` 菜单。开发仓库内更新走 `git pull --rebase origin main && npm install`,正式 npm 安装场景走 `npm install -g ugk-agent`;成功后提示重启并退出,不继续加载旧 TUI。`/update` 是会话内手动入口。
