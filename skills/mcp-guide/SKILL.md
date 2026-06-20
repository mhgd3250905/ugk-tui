---
name: mcp-guide
description: Use when the user wants to configure or manage MCP servers in UGK, troubleshoot /mcp status, or understand MCP tool permissions and naming.
---

# MCP Guide

Use this skill when the user asks about UGK MCP configuration, `/mcp` commands, MCP tool names, MCP permissions, or stale MCP tools after reload.

## Scope

UGK is an MCP client for stdio tools. It does not expose an MCP server. It does not enable MCP resources, prompts, sampling, or HTTP transport in this release.

## Config Files

UGK loads three config scopes and merges them in this order:

1. user: `~/.config/ugk/mcp.json`
   - Windows: `%APPDATA%\ugk\mcp.json`
2. project: `<workspace>/.mcp.json`
3. local: `<workspace>/.mcp.local.json`

Higher scope fully replaces a same-name server from a lower scope. `.mcp.local.json` is ignored by git and should hold local-only tokens or paths.

Config shape:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

Environment variables can be interpolated with `${VAR}`. Missing variables fail that server clearly; UGK does not replace them with empty strings.

## Permissions

There are two gates:

1. Spawn policy before starting a server:
   - user scope: allowed
   - project/local scope: ask in interactive UI
   - project/local without UI: blocked fail-closed
2. Per-tool policy inside each MCP tool:
   - `/mcp off`: block tool calls
   - `/mcp on`: allow tool calls
   - `/mcp ask`: ask before tool calls unless the server was allowed for this session

Never advise users to place untrusted project commands in user scope just to bypass confirmation.

## Commands

```text
/mcp status
/mcp ask
/mcp on
/mcp off
/mcp reload
/mcp enable <server>
/mcp disable <server>
```

`/mcp status` shows connected servers, tool counts, permission mode, failed servers, warnings, and stale servers.

`/mcp reload` disconnects all MCP servers, reloads config, reconnects allowed servers, and updates active tools.

## Tool Names

MCP tools are registered as:

```text
server__tool
```

Server and tool names are normalized to provider-safe lowercase names. Characters outside `[a-z0-9-]` become `-`. Server names are capped at 32 characters; tool names at 64 characters. Duplicate normalized server names get suffixes like `-2`.

## Stale Tools

pi currently has no `unregisterTool` API. When a server disappears after `/mcp reload`, UGK removes that server's tools from active tools. If a stale MCP tool is still called, it returns a disconnected error and does not reconnect automatically.

Use:

```text
/mcp reload
/mcp enable <server>
```

after restoring the server config.

## Doctor

`/doctor` includes an MCP check. It is read-only:

- validates config
- reports configured servers by scope
- reads the current registry status
- never spawns MCP server processes

## Troubleshooting

- Server not connected in `ugk --print`: project/local scope is blocked without UI. Move trusted config to user scope or use interactive TUI.
- Env error in `/mcp status`: define the missing environment variable or move local values into `.mcp.local.json`.
- Tool name is unexpected: check provider-safe normalization and duplicate suffix warnings.
- Tool call blocked: check `/mcp status`, then choose `/mcp ask`, `/mcp on`, or approve the session prompt.
