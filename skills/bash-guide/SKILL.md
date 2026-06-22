---
name: bash-guide
description: Use when an agent needs bash on Windows in UGK, sees bash/PATH failures, works with Driver/subagent sessions, or is tempted to probe many Git Bash paths manually.
---

# Bash Guide

UGK treats bash as a shared runtime setting, not a per-task guessing game.

## Source of truth

- Primary setting: `<agentDir>/settings.json` field `shellPath`.
- Default `agentDir`: `PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`.
- On Windows, `/doctor` checks bash with the resolver and writes a successful absolute Git Bash path back to `settings.json.shellPath`.
- Main agent, Judge Driver sessions, and subagent child processes use the same `agentDir`, so a persisted `shellPath` is shared after restart or delegation.

## What to do

1. If bash fails on Windows, run `/doctor` or the project environment check first.
2. If `/doctor` reports `bash available (settings.json shellPath: ...)`, trust that path.
3. If `/doctor` reports a common Git Bash location, it should persist that path for future Driver/subagent sessions.
4. Use normal bash commands only after the shared shell has been established.

## What not to do

- 不要在任务里反复 `which bash`, `where bash`, `ls /d/Git`, or probe many hard-coded Git install paths.
- Do not make every Driver or subagent rediscover bash independently.
- Do not ask the user to manually run commands when UGK tools can check or persist the shell path.

## Manual repair

If automatic detection cannot find Git Bash, set `shellPath` in `<agentDir>/settings.json`:

```json
{
  "shellPath": "D:\\Git\\bin\\bash.exe"
}
```

Keep the rest of the existing settings file unchanged.
