# ugk

**ugk** — 一个开箱即用的终端编码 agent。一条命令安装,打 `ugk` 即用。

> 基于 [pi](https://github.com/earendil-works/pi) 构建,但用户无需关心 pi——`npm i -g ugk-agent` 装完就拥有全部能力(投屏、子代理、定时任务、plan 模式、judge 委托验收、MCP tools 接入等)。

---

## 🚀 安装(2 步,约 2 分钟)

### 第 1 步:安装

```cmd
npm i -g ugk-agent
```

> 需要先有 Node.js 18+。没有的话去 [nodejs.org](https://nodejs.org) 装 LTS 版。
> ugk 内置 pi 作为依赖,**不用单独装 pi、不用 clone 本仓库、不用 pi install**。
> pi 是 UGK 的内部运行时依赖,版本由 UGK 发行版固定管理;用户不要单独运行 `pi update`。

### 第 2 步:配置 API key

ugk 默认用 DeepSeek。去 [platform.deepseek.com](https://platform.deepseek.com) 申请 key:

```cmd
:: 永久生效(推荐,新开窗口才生效)
setx DEEPSEEK_API_KEY sk-你的key
```

**装完。** 任意目录打 `ugk` 就进对话。

```cmd
ugk
```

> 也可以用其他模型(OpenAI/Claude 等),见 [pi 官方文档](https://github.com/earendil-works/pi)。

---

## ⚙️ Windows 用户:修复 bash 工具(重要,不做会报错)

ugk 在 Windows 上默认找 bash,但**只查 `C:\Program Files\Git`** 两个标准路径。
若你的 Git for Windows 装在别处(如 `D:\Git`),会退到 PATH 上的 WSL `bash.exe`,
导致 `bash` 工具报错:`WSL ERROR: execvpe /bin/bash failed 2`

**解法**:找到你的 Git Bash 路径(通常 `<Git安装目录>\bin\bash.exe`),
写进 `%USERPROFILE%\.pi\agent\settings.json`:

```json
{
  "shellPath": "D:\\Git\\bin\\bash.exe"
}
```

> 用 Git Bash 优于 PowerShell:agent 更熟悉 Linux 命令语法,出错率更低。

---

## 🤖 安装 subagent 预设 agent(可选,但强烈推荐)

subagent 工具随包自动加载,但 4 个预设 agent(`scout`/`planner`/`reviewer`/`worker`)
需要复制到用户目录才生效。**不装也能用 subagent 工具,只是没有现成的 agent 可调。**

**Windows(cmd / PowerShell)**:
```cmd
mkdir "%USERPROFILE%\.pi\agent\agents" 2>nul
xcopy /Y agents\*.md "%USERPROFILE%\.pi\agent\agents\"
```

**Git Bash**:
```bash
mkdir -p ~/.pi/agent/agents
cp agents/*.md ~/.pi/agent/agents/
```

验证:进 ugk 后输入 `@scout 列出当前目录`,能调起 scout 就说明装好了。可用 `/subagent` 查看所有 subagent,并给单个 subagent 设置模型。
详见 `skills/subagent-guide/SKILL.md`。

---

## ✅ 验证安装

进 ugk 后依次试这些,全部正常说明装好了:

| 输入 | 期望 |
| --- | --- |
| `/ugk` | 弹出状态(列全部能力) |
| `/check-env` | 自检 adb/scrcpy/设备(没装会提示安装命令) |
| `帮我看看当前目录结构` | agent 正常读取并总结项目 |
| `@scout 列出项目目录` | 调 `subagent` 委派 scout(需先装预设 agent) |
| `/subagent` | 列出所有 subagent,选择后设置该 subagent 的模型 |
| `/plan` | 切换只读探索模式 |
| `/judge` | 查看 judge 委托验收菜单 |
| `/mcp status` | 查看已配置/已连接的 MCP server |
| `rm -rf /tmp/test` | 触发权限门(弹确认) |

---

## 🎬 开始使用

```cmd
:: 任意目录,直接进对话
ugk

:: 一次性非交互模式(脚本/cron 用)
ugk --print "总结当前目录结构"

:: 指定模型
ugk --model deepseek-reasoner
```

进对话后,直接用自然语言或 `/命令` 即可。例:
- `帮我看看这个项目的结构` — agent 自己探索
- `@scout 找一下认证代码` — 委派给 scout 子代理
- `/subagent` — 查看 subagent 并设置单个 subagent 的模型
- `/implement 加个 Redis 缓存` — scout→planner→worker 全链路
- `/plan` — 先只读规划再执行
- `/judge` — 打开 judge 委托验收菜单
- `/mcp status` — 查看外部 MCP tools 连接状态

---

## 🔄 更新 UGK

UGK 会在进入 TUI 前检查 GitHub `main` 是否有新版本。发现更新时会像 Codex CLI 一样先停在启动入口,只显示 UGK 自己的选择:

```text
✨ Update available! 1.0.0 (aaaaaaa) -> bbbbbbb

Release notes: https://github.com/mhgd3250905/ugk-tui/commits/main

› 1. Update now (runs `git pull --rebase origin main && npm install`)
  2. Skip
  3. Skip until next version

  Press enter to continue
```

选择 `1` 或直接回车会执行更新,成功后提示重启并退出,不会继续加载旧 TUI。开发仓库内运行时执行 `git pull --rebase origin main && npm install`;正式 npm 安装场景执行 `npm install -g ugk-agent`。`2` 只跳过当前启动,`3` 会跳过当前远端版本直到下个版本出现。

也可以在会话中手动输入:

```text
/update
```

`--print`、`--version`、非交互终端和 `UGK_SKIP_UPDATE_CHECK=1` 会跳过启动前更新检查。UGK 不暴露 pi 更新。pi 是内部 runtime,版本只随 UGK 发布策略变化。

---

## 包含的能力

### 自定义工具

| 工具 | 作用 |
| --- | --- |
| `scrcpy` | 安卓投屏控制(start/stop/status/version) |
| `subagent` | 子代理委派(single/parallel/chain 三模式) |
| `cron` | 定时任务管理(status/list/add/remove/history) |
| `chrome_cdp` | 受保护的本地登录态 Chrome 控制(status/launch/tabs/navigate/evaluate/screenshot) |
| `mcp` | 外部 MCP stdio server 的 tools 接入,注册为 `server__tool` |
| `run_task` | subtask 工具:复用已机器验收的 taskbook,返回 PASS/FAIL + 产物路径(single/parallel,确定性区别于 subagent 的灵活探索) |

### ugk 品牌 UI

ugk 默认通过 `extensions/ui-brand.ts` 加载一层独立的品牌 UI,只使用 pi 官方 extension API:

- `ctx.ui.setHeader()` 替换启动顶部说明为 `ugk` 品牌区
- `ctx.ui.setFooter()` 替换底部状态栏,保留 cwd/branch/token/model/轮次信息
- `ctx.ui.setTitle()` 把终端标题改成 `ugk - <session> - <cwd>`
- 新会话启动时清理当前终端视口和 scrollback,用字符特效启动页填满当前终端高度
- 对话开始后自动回到紧凑 header,不长期占用消息区域
- header/footer 组件在 `session_start` 时抽取普通 session 数据,render 阶段不持有或读取 `ExtensionContext`,避免 session replacement/reload 后 stale ctx 崩溃
- 不替换消息渲染、不替换 editor、不改 pi 内部运行逻辑

临时关闭:

```bash
UGK_UI=0 ugk
UGK_CLEAR_STARTUP=0 ugk
```

运行中切换:

```text
/ugk-ui off
/ugk-ui on
/ugk-ui status
```

随包还提供 `themes/ugk-geek.json` 默认主题(低刺激荧光绿):首次启动 `ugk` 时会在 `~/.pi/agent/settings.json` 缺少 `theme` 字段时自动补上 `"theme": "ugk-geek"`;如果用户已经显式设置过其他主题,ugk 不会覆盖。

### slash 命令

| 命令 | 作用 |
| --- | --- |
| `/ugk` | 看 agent 状态 |
| `/welcome` | 欢迎模板 |
| `/check-env` | 一键自检 adb/scrcpy/设备连接 |
| `/subagent` | 列出 subagent 并设置单个 subagent 模型 |
| `/update` | 检查并更新 UGK |
| `/cdp` | 管理本地 Chrome CDP 访问模式、端口、启动和标签页 |
| `/mcp` | 管理 MCP server 状态、权限模式、reload、enable/disable |
| `/ugk-ui` | 开关 ugk 品牌 UI |
| `/plan` | 切换 plan-mode 只读探索模式(或 Ctrl+Alt+P) |
| `/todos` | 查看 plan-mode 计划进度 |
| `/judge` | 管理 judge 委托验收、live.log 过程终端和 driver 运行状态 |
| `/task` | 固定任务委托(taskbook 创造/复用/编排) |
| `/implement` | scout→planner→worker 全链路实现 |
| `/scout-and-plan` | scout→planner(只到方案) |
| `/implement-and-review` | worker→reviewer→worker |

### plan-mode 只读探索模式

`/plan` 进入只读模式:工具限制为 read/bash/grep/find/ls,bash 命令过白名单(只放行只读命令,拦 rm/git commit/npm install,并阻止 `curl | sh`、`curl -o`、curl 上传/变更请求等非只读形态)。agent 产出 `Plan:` 编号计划后,可选择执行(恢复全部工具)/继续规划/精炼。执行阶段用 `[DONE:n]` 跟踪进度,状态栏显示 `📋 N/M`。

### Chrome CDP 本地浏览器控制

`chrome_cdp` 用于需要本地登录态 Chrome 的场景:SSO、cookies、CAPTCHA、私有工作区、本地应用截图或 DOM 检查。它不是普通联网检索或文档查询的默认路径。

```text
/cdp status
/cdp ask      # 默认:每次浏览器操作前确认
/cdp on       # 当前会话允许浏览器操作
/cdp off      # 禁用浏览器操作
/cdp port 9222
/cdp launch
/cdp tabs
```

默认模式是 `ask`。非 status 操作需要提供原因并说明普通访问是否已经尝试或不适用。详见 `skills/chrome-cdp-guide/SKILL.md` 和 `extensions/chrome-cdp/README.md`。

### MCP tools 接入

UGK 可以作为 MCP client 连接外部 stdio MCP server,把 server 暴露的 tools 注册成 `server__tool`。一期只支持 stdio + tools;resources、prompts、sampling、HTTP transport 暂不启用。

配置文件按四档合并:

- install: UGK 安装目录 `mcp.json`(全局安装目录下的 `ugk-agent/mcp.json`;npm link 开发时即仓库根目录 `mcp.json`),由 UGK 包/项目维护者背书
- user: `~/.config/ugk/mcp.json`(Windows 为 `%APPDATA%\ugk\mcp.json`)
- project: 当前项目 `.mcp.json`
- local: 当前项目 `.mcp.local.json`(已进 `.gitignore`,用于本机 token/path)

示例:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

install/user scope 视为 UGK 级可信配置,默认直接连接;project/local scope 第一次 spawn 前默认弹确认;非交互模式只允许 install/user scope,project/local 会 fail-closed。工具调用权限复用 `ask/on/off`:

```text
/mcp status
/mcp ask
/mcp on
/mcp off
/mcp reload
/mcp enable filesystem
/mcp disable filesystem
```

`/mcp reload` 会断开并重连 server。pi 当前没有 unregisterTool,所以消失 server 的旧工具会从 active tools 下线;如果 stale 工具被调用,会返回 server disconnected,不会自动重连。`/doctor` 的 MCP 项只读配置和当前 registry 状态,不会 spawn 任意 MCP server。详见 `skills/mcp-guide/SKILL.md`。

### Judge 委托验收

`/judge` 用于把任务交给 driver 执行,由 judge 按验收标准判定 PASS/FAIL。judge 不是替代 `/plan` 的只读规划模式,而是面向明确验收标准的委托执行模式。运行过程写入 `.judge/judge-*/live.log`,Windows 上可通过 `/judge check-bash-window` 检查外部 bash 日志窗口是否能持续显示更新。

```text
/judge
/judge toggle
/judge check-bash-window
/judge ack
```

详见项目仓库的 [`docs/judge.md`](https://github.com/mhgd3250905/ugk-tui/blob/main/docs/judge.md)。

### cron 定时服务(独立常驻进程)

```bash
npm run cron:start   # 启动常驻服务(127.0.0.1:17741)
```

到点自动起 `ugk --print` 子进程跑 agent 任务,结果存 `~/.pi/agent/cron-output/`。在 ugk 对话里用 `cron` 工具增删改查任务。详见 `skills/cron-guide/SKILL.md`。

### @mention 手动触发

输入 `@<agent名> <任务>` 自动改写为 subagent 委派:

```
@scout 找一下认证逻辑在哪
@reviewer 审一下这次改动
@worker 重构 utils.ts
```

### skills

| skill | 作用 |
| --- | --- |
| `ugk-guide` | 占位示例 |
| `adb-guide` | Android adb 操作大全(8 文件) |
| `scrcpy-guide` | scrcpy 投屏安装与使用 |
| `subagent-guide` | 子代理委派指南 |
| `cron-guide` | 定时任务指南 |
| `chrome-cdp-guide` | 本地登录态 Chrome/CDP 使用边界与安全流程 |
| `mcp-guide` | MCP server 配置、权限、命令和排障指南 |
| `skill-creator` | 创建、改进和评测 agent skill(来自 Anthropic skills, Apache-2.0) |
| `docx` | 创建、读取、编辑 Word `.docx` 文档(来自 Anthropic skills,见随包 LICENSE.txt) |

### 权限门

危险 bash(`rm -rf` / `sudo` / `chmod 777`)弹确认;非交互模式直接拦截。

---

## 目录结构

```
ugk-core/
├── package.json              # npm 包 manifest(name=ugk-agent, bin=ugk)
├── bin/
│   └── ugk.js                # CLI 入口(薄壳:调 pi main + -e 注入扩展)
├── AGENTS.md                 # 人设 + 项目上下文(给 agent 看)
├── extensions/
│   ├── index.ts              # 主入口:工具/命令注册 + @mention + 权限门 + resources_discover
│   ├── deepseek-status.ts    # /ugk 状态里识别 DEEPSEEK_API_KEY 和 pi /login auth
│   ├── device-env.ts         # adb/scrcpy 探测 + getUgkBin(命令自适应)
│   ├── scrcpy-tool.ts        # scrcpy 投屏工具
│   ├── cron.ts + cron-contract.ts  # cron 工具 + 共享类型
│   ├── subagent.ts + subagent-runtime/rendering/agents.ts  # 子代理委派
│   ├── plan-mode.ts + plan-mode-utils/state.ts  # plan 模式
│   ├── judge/               # Judge 委托验收模式
│   ├── chrome-cdp/          # 本地登录态 Chrome CDP 控制
│   ├── mcp/                 # MCP stdio client、registry、tools、permissions、/mcp
│   └── ui-*.ts               # UI 美化(品牌层含 header/footer/title+spinner、状态条)
├── cron/
│   └── service.ts            # 常驻定时服务(node-cron + HTTP,npm run cron:start)
├── agents/                   # 预设 subagent 定义(需复制到 ~/.pi/agent/agents/)
│   ├── scout.md planner.md reviewer.md worker.md
├── skills/                   # 随包加载(resources_discover 自动发现)
│   └── ugk-guide/adb-guide/scrcpy-guide/subagent-guide/cron-guide/chrome-cdp-guide/mcp-guide/skill-creator/docx
├── themes/                   # ugk-geek 默认主题
├── prompts/                  # /implement /scout-and-plan 等(随包加载)
└── tests/                    # Node test runner 逻辑覆盖
```

---

## ❓ 常见问题

**Q: `ugk` 命令找不到?**
A: 重开一个 cmd/PowerShell 窗口(让 PATH 刷新)。还不行就检查 `npm ls -g ugk-agent` 是否装成功。

**Q: bash 工具报 `WSL ERROR: execvpe /bin/bash failed`?**
A: 见上面「Windows 用户:修复 bash 工具」,配 `shellPath`。

**Q: `@scout` 没反应 / 报 "Unknown agent"?**
A: 没装预设 agent。跑上面的「安装 subagent 预设 agent」复制 .md 文件。

**Q: scrcpy 投屏起不来?**
A: 跑 `/check-env` 自检,它会告诉你缺什么(adb/scrcpy 都能 winget 装)。

**Q: cron 工具报"服务未启动"?**
A: cron 是独立常驻服务,在本仓库目录跑 `npm install && npm run cron:start`(需要先 clone 本仓库)。

**Q: 怎么换模型(不用 DeepSeek)?**
A: 设对应的环境变量(如 `OPENAI_API_KEY`),启动时加 `--provider openai --model gpt-4o`。详见 pi 官方文档。

**Q: `/ugk` 显示 DeepSeek 未配置,但我已经 `/login` 了?**
A: `/ugk` 会同时检查 `DEEPSEEK_API_KEY` 和 `~/.pi/agent/auth.json` 里的 deepseek 登录记录。若刚 login 后仍显示未配置,先重启 ugk;若手动编辑过 `settings.json`,注意不要用带 BOM 的 UTF-8 写入,否则 pi 可能解析失败。

**Q: `/skill` 里有很多不是 ugk 自带的 skill?**
A: `ugk` 首次启动会默认在 `~/.pi/agent/settings.json` 写入:

```json
{
  "clearStartupScreen": true,
  "skills": ["!skills/**"]
}
```

`clearStartupScreen` 会让新会话启动页清理当前终端视口并占满终端高度。`skills` 会隐藏 `~/.agents/skills` 下的用户全局 skills,避免系统里装过的个人 skill 干扰 ugk。ugk 通过扩展注入的 `adb-guide` / `scrcpy-guide` / `subagent-guide` / `cron-guide` / `chrome-cdp-guide` / `ugk-guide` / `skill-creator` / `docx` 仍会加载。

已有用户如果之前手动配置过 `clearStartupScreen` 或 `skills`,ugk 不会覆盖;需要启用默认行为时可手动补上对应字段。

**Q: `.mcp.json` 配了 server,为什么非交互模式不连接?**
A: project/local scope 会执行项目内命令,非交互模式没有 UI 可确认,所以 UGK fail-closed。把可信 server 放到 install scope(UGK 安装目录 `mcp.json`)或 user scope(`~/.config/ugk/mcp.json` / `%APPDATA%\ugk\mcp.json`),或在交互 TUI 中确认后使用。

**Q: `/mcp reload` 后旧工具还在模型上下文里怎么办?**
A: UGK 会把消失 server 的工具从 active tools 下线,但 pi 目前没有真正的 unregisterTool API。若 stale 工具被调用,它会返回 server disconnected,不会自动重连。重新出现的 server 可通过 `/mcp reload` 和 `/mcp enable <server>` 恢复 active。

**Q: 我之前用 pi install 装过老版本,要怎么升级?**
A: 直接 `npm i -g ugk-agent`,然后用 `ugk` 代替 `pi` 即可。老的 ~/.pi/agent/ 配置和 auth 仍然有效(ugk 复用同一目录)。

**Q: 启动时看到 pi 更新提示怎么办?**
A: 正常使用 `ugk` 不应该看到 pi 更新提示。UGK 会在启动入口禁用 pi 自身的版本检查和安装遥测,并固定内部 pi runtime 版本。以后底层 runtime 是否升级,只由 UGK 新版本决定;用户只需要更新 UGK,不要单独执行 `pi update`。
