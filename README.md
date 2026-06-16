# ugk

**ugk** — 一个开箱即用的终端编码 agent。一条命令安装,打 `ugk` 即用。

> 基于 [pi](https://github.com/earendil-works/pi) 构建,但用户无需关心 pi——`npm i -g ugk-agent` 装完就拥有全部能力(投屏、子代理、定时任务、plan 模式等)。

---

## 🚀 安装(2 步,约 2 分钟)

### 第 1 步:安装

```cmd
npm i -g ugk-agent
```

> 需要先有 Node.js 18+。没有的话去 [nodejs.org](https://nodejs.org) 装 LTS 版。
> ugk 内置 pi 作为依赖,**不用单独装 pi、不用 clone 本仓库、不用 pi install**。

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

验证:进 ugk 后输入 `@scout 列出当前目录`,能调起 scout 就说明装好了。
详见 `skills/subagent-guide/SKILL.md`。

---

## ✅ 验证安装

进 ugk 后依次试这些,全部正常说明装好了:

| 输入 | 期望 |
| --- | --- |
| `/ugk` | 弹出状态(列全部能力) |
| `/check-env` | 自检 adb/scrcpy/设备(没装会提示安装命令) |
| `跟我打个招呼,我叫 Sam` | 调 `greet` 工具回复 |
| `@scout 列出项目目录` | 调 `subagent` 委派 scout(需先装预设 agent) |
| `/plan` | 切换只读探索模式 |
| `rm -rf /tmp/test` | 触发权限门(弹确认) |

---

## 🎬 开始使用

```cmd
:: 任意目录,直接进对话
ugk

:: 一次性非交互模式(脚本/cron 用)
ugk --print "用 greet 工具跟我打招呼,我叫 Sam"

:: 指定模型
ugk --model deepseek-reasoner
```

进对话后,直接用自然语言或 `/命令` 即可。例:
- `帮我看看这个项目的结构` — agent 自己探索
- `@scout 找一下认证代码` — 委派给 scout 子代理
- `/implement 加个 Redis 缓存` — scout→planner→worker 全链路
- `/plan` — 先只读规划再执行

---

## 包含的能力(v1.0.0)

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

## 目录结构

```
ugk-core/
├── package.json              # npm 包 manifest(name=ugk-agent, bin=ugk)
├── bin/
│   └── ugk.js                # CLI 入口(薄壳:调 pi main + -e 注入扩展)
├── AGENTS.md                 # 人设 + 项目上下文(给 agent 看)
├── extensions/
│   ├── index.ts              # 主入口:工具/命令注册 + @mention + 权限门 + resources_discover
│   ├── device-env.ts         # adb/scrcpy 探测 + getUgkBin(命令自适应)
│   ├── scrcpy-tool.ts        # scrcpy 投屏工具
│   ├── cron.ts + cron-contract.ts  # cron 工具 + 共享类型
│   ├── subagent.ts + subagent-runtime/rendering/agents.ts  # 子代理委派
│   ├── plan-mode.ts + plan-mode-utils/state.ts  # plan 模式
│   └── ui-*.ts               # UI 美化(footer/状态条/标题栏spinner)
├── cron/
│   └── service.ts            # 常驻定时服务(node-cron + HTTP,npm run cron:start)
├── agents/                   # 预设 subagent 定义(需复制到 ~/.pi/agent/agents/)
│   ├── scout.md planner.md reviewer.md worker.md
├── skills/                   # 随包加载(resources_discover 自动发现)
│   └── ugk-guide/adb-guide/scrcpy-guide/subagent-guide/cron-guide
├── prompts/                  # /implement /scout-and-plan 等(随包加载)
└── tests/                    # 17 个测试(纯逻辑覆盖)
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

**Q: 我之前用 pi install 装过老版本,要怎么升级?**
A: 直接 `npm i -g ugk-agent`,然后用 `ugk` 代替 `pi` 即可。老的 ~/.pi/agent/ 配置和 auth 仍然有效(ugk 复用同一目录)。

