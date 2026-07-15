# Codex setup

## Install UGK

先用 `ugk --version` 检查本机安装。若命令不存在，说明将进行全局 npm 安装并取得用户同意，然后运行：

```text
npm i -g ugk-agent
```

安装或写入配置前都先取得用户同意。

## Register the MCP server

检查当前注册：

```text
codex mcp list
```

若没有 `ugk`，先说明这会写入 Codex 配置并取得用户同意，再运行：

```text
codex mcp add ugk -- ugk mcp serve
```

在 Codex GUI 中的等价操作是添加一个本地 STDIO server：名称为 `ugk`，命令为 `ugk`，参数为 `mcp serve`。写入配置前仍需用户同意。

刚注册后，如果当前任务看不到 `ugk` 工具，重启 Codex 或新建 Codex 任务。不要把宿主尚未刷新工具误报为 UGK 故障。

## Bootstrap diagnostics

MCP 尚不可用时运行：

```text
ugk mcp doctor --json
```

- `WORKSPACE_UNTRUSTED`：MCP 连接后调用 `start`，把返回的信任确认展示给用户，再用 `respond` 回传。
- `MODEL_AUTH_MISSING`：不要让用户在聊天中粘贴 key。让用户把 key 写入本机私有文件；取得同意后运行 `ugk auth import --provider deepseek --file <path>`，全程不要读取或回显文件内容。
- `WORKSPACE_NOT_FOUND`：让用户选择一个存在的项目目录。
- `READY`：进入 `start` → `status` 流程。
