---
name: chrome-cdp-guide
description: Use when the user explicitly asks to use local Chrome/CDP/an already logged-in browser, or when ordinary network access cannot reach a page because it requires cookies, SSO, CAPTCHA, private workspace state, or browser login state.
---

# Chrome CDP Guide

Use `chrome_cdp` only for local logged-in Chrome access. Do not use it as the default way to browse public websites.

## Use This Skill When

- The user explicitly asks to use local Chrome, CDP, DevTools Protocol, or an already logged-in browser.
- A page requires the user's existing Chrome login state, cookies, SSO, CAPTCHA completion, or private workspace state.
- Ordinary network access was attempted or reasoned through and cannot reach the target content.
- The user wants an actual Chrome screenshot or DOM inspection of a local/private page.

## Do Not Use This Skill For

- Public web search.
- Ordinary documentation lookup.
- Pages accessible through normal HTTP, `bash`, or browser-free methods.
- Static source-code inspection.
- Login automation or password entry.

## Required Flow

1. Prefer ordinary access first.
2. If ordinary access is insufficient, explain why CDP is needed.
3. Call `chrome_cdp` with:
   - `reason`: a clear explanation tied to logged-in/local Chrome state
   - `normalAccessAttempted`: `true` unless the user explicitly requested local Chrome/CDP
4. Start with `action=status` or `/cdp status` if CDP availability is unknown.
5. In default `ask` mode, wait for user approval before browser operations.
6. Never ask the user to give passwords to the agent.

## Useful Commands

```text
/cdp status
/cdp ask
/cdp on
/cdp off
/cdp port 9222
/cdp launch
/cdp tabs
```

## Chrome Launch

Prefer a dedicated UGK Chrome profile:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.ugk/chrome-cdp-profile"
```

The user logs in inside that Chrome profile. UGK does not store credentials.
