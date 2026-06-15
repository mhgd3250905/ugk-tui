# ugk-pi-agent

基于 [pi-coding-agent](https://github.com/earendil-works/pi) 的本地定制化 agent(Pi Package 形式)。

> 照搬官方示例模式,不造轮子。扩展能力见 `extensions/`,知识见 `skills/`。

---

## 前置

- Node.js
- 全局安装 pi(>=0.79,带原生 DeepSeek 支持):

  ```cmd
  npm i -g @earendil-works/pi-coding-agent
  ```

- DeepSeek API key(环境变量):

  ```cmd
  set DEEPSEEK_API_KEY=sk-...
  ```
  想永久生效用 `setx DEEPSEEK_API_KEY sk-...`(新开窗口才生效)。

## Windows 用户:修复 bash 工具(重要)

pi 在 Windows 上默认找 bash,但**只查 `C:\Program Files\Git`** 两个标准路径。
若你的 Git for Windows 装在别处(如 `D:\Git`),pi 找不到就会退到 PATH 上的
WSL `bash.exe`,而 WSL 默认发行版(如 docker-desktop)没有 `/bin/bash`,
导致 pi 的 `bash` 工具报错:

```
WSL ERROR: execvpe /bin/bash failed 2
```

**解法**:找到你的 Git Bash 路径(通常 `<Git安装目录>\bin\bash.exe`),
写进 `~/.pi/agent/settings.json`:

```json
{
  "shellPath": "D:\\Git\\bin\\bash.exe"
}
```

用 Git Bash 优于 PowerShell:agent(DeepSeek 等)更熟悉 Linux 命令语法,
出错率更低。验证:`ugk --print "用 bash 工具执行 ls -la 并告诉我"`。

> 注:settings.json 在用户主目录,不进本仓库。

## 永久安装(写入 `~/.pi/agent/settings.json`)

```cmd
pi install .
```

装好后任意目录敲 `pi` 即自带本包的全部能力(见下表)。

## 安装 subagent 预设 agent(可选,推荐)

subagent 工具本身随包加载,但 4 个预设 agent(`scout`/`planner`/`reviewer`/`worker`)
需要复制到用户目录才生效:

```bash
# Git Bash
mkdir -p ~/.pi/agent/agents
cp /e/AII/ugk-core/agents/*.md ~/.pi/agent/agents/
```

详见 `skills/subagent-guide/SKILL.md`。

---

## 包含的能力(v0.6.0)

### 自定义工具

| 工具 | 作用 |
| --- | --- |
| `greet` | 演示用打招呼 |
| `scrcpy` | 安卓投屏控制(start/stop/status/version) |
| `subagent` | 子代理委派(single/parallel/chain 三模式) |
| `cron` | 定时任务管理(status/list/add/remove/history) |

### slash 命令

| 命令 | 作用 |
| --- | --- |
| `/ugk` | 看 agent 状态 |
| `/welcome` | 欢迎模板 |
| `/check-env` | 一键自检 adb/scrcpy/设备连接 |
| `/plan` | 切换 plan-mode 只读探索模式(或 Ctrl+Alt+P) |
| `/todos` | 查看 plan-mode 计划进度 |
| `/implement` | scout→planner→worker 全链路实现 |
| `/scout-and-plan` | scout→planner(只到方案) |
| `/implement-and-review` | worker→reviewer→worker |

### plan-mode 只读探索模式

`/plan` 进入只读模式:工具限制为 read/bash/grep/find/ls,bash 命令过白名单(只放行只读命令,拦 rm/git commit/npm install)。agent 产出 `Plan:` 编号计划后,可选择执行(恢复全部工具)/继续规划/精炼。执行阶段用 `[DONE:n]` 跟踪进度,状态栏显示 `📋 N/M`。

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

### 权限门

危险 bash(`rm -rf` / `sudo` / `chmod 777`)弹确认;非交互模式直接拦截。

---

## 验证(进入 pi 后输入)

| 输入 | 期望 |
| --- | --- |
| `/ugk` | 弹出状态提示(列全部能力) |
| `/check-env` | 自检 adb/scrcpy/设备 |
| `跟我打个招呼,我叫 Sam` | 调 `greet` 工具 |
| `@scout 列出项目目录` | 调 `subagent` 工具委派 scout |
| `rm -rf /tmp/test` | 触发权限门(弹确认) |

---

## 目录结构

```
ugk-core/
├── package.json              # Pi Package manifest(pi 字段)
├── AGENTS.md                 # 人设 + 项目上下文(给 agent 看)
├── extensions/
│   ├── index.ts              # 主入口:工具/命令注册 + @mention + 权限门 + check-env
│   ├── subagent.ts           # subagent 工具(官方搬运 + Windows spawn 适配)
│   ├── subagent-agents.ts    # agent 配置发现
│   ├── cron.ts               # cron 工具(代理常驻服务 HTTP API)
│   ├── plan-mode.ts          # plan-mode 只读探索模式(/plan 切换)
│   ├── plan-mode-utils.ts    # plan-mode 工具(bash 白名单 + 计划提取)
│   └── ui-*.ts               # UI 美化(footer/状态条/标题栏spinner)
├── cron/
│   └── service.ts            # 常驻定时服务(node-cron + HTTP,npm run cron:start)
├── agents/                   # 预设 subagent 定义(需复制到 ~/.pi/agent/agents/)
│   ├── scout.md              # 侦察(flash,只读)
│   ├── planner.md            # 规划(pro,只读)
│   ├── reviewer.md           # 审查(pro)
│   └── worker.md             # 执行(pro,全工具)
├── skills/
│   ├── ugk-guide/            # 示例 skill
│   ├── adb-guide/            # adb 操作大全
│   ├── scrcpy-guide/         # scrcpy 投屏指南
│   ├── subagent-guide/       # 子代理委派指南
│   └── cron-guide/           # 定时任务指南
└── prompts/
    ├── welcome.md            # /welcome 模板
    ├── implement.md          # /implement 流水线
    ├── scout-and-plan.md     # /scout-and-plan
    └── implement-and-review.md
```

---

## 试跑(不改任何配置)

```cmd
cd E:\AII\ugk-core
set DEEPSEEK_API_KEY=sk-...
pi -e extensions/index.ts --provider deepseek --model deepseek-chat
```

非交互一次性跑:

```cmd
pi -e extensions/index.ts --provider deepseek --model deepseek-chat --print "用 greet 工具跟我打招呼,我叫 Sam"
```
