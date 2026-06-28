# ugk-core 开发指南

> 改 ugk-core 代码(extensions/、bin/、agents/、skills/)的开发者必读。
> 本文档收纳**开发侧**约定;运行时 agent 的行为准则在 `AGENTS.md`(pi 运行时只自动加载 AGENTS.md,不加载本文档,故开发细节不污染运行时 prompt)。

---

## 0. 必读文档

- **`docs/extension-contracts.md`** — 扩展开发硬规则(覆盖 pi 内置工具的隐式注入契约、读 pi 管理 JSON 的 BOM 规则、sessionManager 能力边界等)。改 `extensions/` 或 `bin/` 前必读。
- **`docs/design/task-extension-spec.md`** — task 四阶段设计契约
- **`docs/design/subtask-extension-spec.md`** — run_task 编排设计

---

## 1. 运行时架构与发行策略

- UGK 是基于 [pi](https://github.com/earendil-works/pi)(`pi-coding-agent`)定制的 agent。pi 是 UGK 的**内部 runtime**,每个 UGK 版本必须固定一个明确的 pi 版本(`package.json` 里 `@earendil-works/*` 全钉死)。
- **不要让用户看到或执行 `pi update`**;pi 升级只能通过 UGK 项目主动升级依赖、完成兼容验证并发布新的 UGK 版本。

---

## 2. pi runtime patch 契约

`bin/ugk-*.js` 在 `bin/ugk.js` 启动时安装,修正 pi 行为。仿 `installUgkSessionViewPatch` 的 **idempotent 范式**:
- `Symbol.for()` 守卫(防重复安装)
- proto 包装
- 返回 false 时 `console.warn`

**当前 patch**:
- `installUgkSessionViewPatch` — session 视图/autocomplete
- `installUgkPackageUpdatePatch` — 压制 `pi update` 提示
- `installUgkExtensionOverlayPatch` — 扩展 overlay 打开时暂停 `Working...` spinner,消除 questionnaire 等输入框闪烁
- `installUgkEditorBorderGlyphPatch` — 编辑器边框虚线化

**注意**:pi 升级后每个 patch 的 descriptor/方法检查可能失效,需回归。

---

## 3. 更新机制实现

启动入口在进入 TUI 前检查 GitHub `main` 最新 commit,显示 Codex CLI 风格的中文更新菜单:`立即更新` / `跳过本次` / `跳过直到下个版本`。
- 开发仓库内更新走 `git pull --rebase origin main && npm install`
- 正式 npm 安装场景走 `npm install -g ugk-agent`
- 成功后提示重启并退出,不继续加载旧 TUI
- `/update` 是会话内手动入口

---

## 4. 模型选择契约

- 全局默认 `deepseek-v4-pro`
- `agents/*.md` 的 frontmatter 记录角色意图,但**当前 pi 运行时不靠修改这些 frontmatter 来切换 Judge/Driver 的实际模型**
- 需要更换模型时**必须改 session 创建/模型选择代码并补测试**

---

## 5. agent 定义与部署

- subagent 的 agent 定义在仓库 `agents/*.md`(版本管理)
- **需复制到 `~/.pi/agent/agents/` 才生效**(见 subagent-guide skill)

---

## 6. 同步 spec 的规则汇总

改 ugk-core 核心模块时,必须同步对应设计文档:

| 改动 | 必须同步 |
|---|---|
| task 模块核心函数签名、task 状态机 | `docs/design/subtask-extension-spec.md` |
| task 四阶段创造/复用流程 | `docs/design/task-extension-spec.md` |
| 扩展开发(覆盖原生工具/读 pi 文件/sessionManager) | `docs/extension-contracts.md` |
| 扩展层 settings 读取/BOM 处理 | `docs/extension-contracts.md` |

---

## 7. UI 组件契约

`extensions/ui-brand.ts` 的 header/footer/title 组件:
- **不得在 render 阶段持有或读取 `ExtensionContext`**
- 必须在 `session_start` 时抽取普通 session 数据,避免 session replacement/reload 后 stale ctx 崩溃
- footer 的模型显示必须从当前 session 模型 getter 读取,不要在 `session_start` 缓存模型快照

---

## 8. bash 部署路径

- bash 工具走 Git Bash(`D:\Git\bin\bash.exe`),命令用 Linux 语法,Windows 路径用正斜杠 `/`
- bash 工具若报 WSL 错(`WSL ERROR: execvpe /bin/bash failed 2`),按 README "Windows 用户:修复 bash 工具"一节,把 Git Bash 路径写进 `%USERPROFILE%\.pi\agent\settings.json` 的 `shellPath`

---

## 9. ugk 部署方式

ugk-agent 通过 npm 全局安装(`npm install -g ugk-agent`),在开发环境通常 `npm link` 到 ugk-core 仓库。所以 ugk-core 仓库的代码改动**直接影响实际运行的 ugk**(包括 main agent 和 task-worker/subagent 子进程)。
