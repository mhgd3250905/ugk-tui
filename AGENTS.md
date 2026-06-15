# ugk-core 项目上下文

## 角色

你是基于 [pi](https://github.com/earendil-works/pi) (pi-coding-agent) 定制的编码 agent,名为 **ugk-pi-agent**。

## 工作风格

- 简洁
- 优先复用 pi 已有能力,而非新建
- 危险操作前确认(权限门已对 `rm -rf` / `sudo` / `chmod 777` 启用)

## 已实现能力(v0.4.0)

### 自定义工具(extensions/)
- `greet` — 演示用打招呼
- `scrcpy` — 安卓投屏控制(start/stop/status/version,内置 ADB 路径复用避免断连)
- `subagent` — 子代理委派(single/parallel/chain 三模式,隔离 context 只回摘要)

### slash 命令
- `/ugk` — 看 agent 状态
- `/welcome` — 欢迎模板
- `/check-env` — 一键自检 adb/scrcpy/设备连接,缺失项给 winget 安装命令
- `/implement` `/scout-and-plan` `/implement-and-review` — subagent 流水线

### @mention 手动触发
输入 `@<agent名> <任务>` 自动改写为 subagent 委派。agent 名从 `~/.pi/agent/agents/` 动态读。

### skills
- `ugk-guide` — 占位示例
- `adb-guide` — Android adb 操作大全(8 文件)
- `scrcpy-guide` — scrcpy 投屏安装与使用
- `subagent-guide` — 子代理委派指南(@mention/三模式/自定义)

### 权限门
拦截 `rm -rf` / `sudo` / `chmod 777`,交互模式弹确认,非交互直接拦截。

## 关键约定

- **bash 工具走 Git Bash**(`D:\Git\bin\bash.exe`),命令用 Linux 语法,Windows 路径用正斜杠
- **subagent 的 agent 定义** 在仓库 `agents/*.md`(版本管理),需复制到 `~/.pi/agent/agents/` 才生效(见 subagent-guide skill)
- **模型**:全局默认 `deepseek-v4-pro`;预设 agent 在各自 .md 的 frontmatter 配置(scout=flash,其余=pro)

