# ugk-pi-agent

基于 [pi-coding-agent](https://github.com/earendil-works/pi) 的本地定制化 agent(Pi Package 形式)。

> 照搬官方示例模式(`hello.ts` / `permission-gate.ts` / `registerCommand`),不造轮子。

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

## 试跑(不改任何配置)

```cmd
cd E:\AII\ugk-core
set DEEPSEEK_API_KEY=sk-...
pi -e extensions/index.ts --skill skills/ugk-guide --prompt-template prompts/welcome.md --provider deepseek --model deepseek-chat
```

非交互一次性跑(处理完退出):

```cmd
pi -e extensions/index.ts --provider deepseek --model deepseek-chat --print "用 greet 工具跟我打招呼,我叫 Sam"
```

## 永久安装(写入 `~/.pi/agent/settings.json`)

```cmd
pi install .
```

装好后任意目录敲 `pi` 即自带本包的 greet 工具、`/ugk` 命令、skill、权限门。

## 验证(进入 pi 后输入)

| 输入 | 期望 |
| --- | --- |
| `/ugk` | 弹出状态提示 |
| `跟我打个招呼,我叫 Sam` | 模型调用 `greet` 工具 |
| `/skill:ugk-guide` | 加载 skill |
| `/welcome Sam` | 用 prompt 模板打印欢迎 |
| `rm -rf /tmp/test` | 触发权限门(弹确认) |

## 包含的能力

| 类型 | 内容 | 来源(官方示例) |
| --- | --- | --- |
| 自定义工具 | `greet` | `examples/extensions/hello.ts` |
| slash 命令 | `/ugk`、`/welcome` | `registerCommand` / prompt 模板 |
| skill | `/skill:ugk-guide` | `SKILL.md` |
| 权限门 | 危险 bash 确认 | `examples/extensions/permission-gate.ts` |
| 人设 | `AGENTS.md` | 项目上下文 |

## 目录结构

```
ugk-core/
├── package.json              # Pi Package manifest(pi 字段)
├── AGENTS.md                 # 人设(项目上下文注入)
├── extensions/
│   └── index.ts              # greet 工具 + /ugk 命令 + 权限门
├── skills/
│   └── ugk-guide/
│       └── SKILL.md          # 示例 skill
└── prompts/
    └── welcome.md            # /welcome 模板
```

## 可选二期(直接照搬官方示例,不造轮子)

- **plan-mode**:复制 `packages/coding-agent/examples/extensions/plan-mode/{index.ts,utils.ts}`
- **subagent**:复制 `packages/coding-agent/examples/extensions/subagent/`(子 agent,spawn 独立 pi 进程)
- **MCP**:pi 不内置 MCP;需要时安装第三方包 `pi-mcp-adapter`
