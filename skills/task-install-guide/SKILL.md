---
name: task-install-guide
description: Use when the user wants to install a UGK task from chat, pastes or mentions `ugk task install NAME`, `$ ugk task install NAME`, or asks in Chinese to install a task.
---

# Task Install Guide

When the user asks to install a UGK task, use the existing installer. Do not manually download manifests, unzip files, or recreate install validation.

## Steps

1. Extract the task name from the user request, for example `video-downloader` from `ugk task install video-downloader`.
2. Run `ugk task install <name>` with the shell tool.
3. If `ugk` is not available and you are inside the UGK repo, run `node bin/ugk.js task install <name>`.
4. Report the installer result in the user's language. Include the task name and the destination when the installer prints one.

If no task name is present, ask for the task name. If the installer fails, report the exact failure and do not retry by hand-editing task files.
