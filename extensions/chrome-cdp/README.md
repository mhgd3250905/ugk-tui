# Chrome CDP Extension

Guarded local Chrome DevTools Protocol control for UGK.

## Purpose

This extension lets the agent request access to a local, logged-in Chrome session when normal network access cannot reach a page because it needs cookies, SSO, CAPTCHA, private workspace state, or browser login state.

It is not a replacement for normal web access or documentation lookup.

## Commands

```text
/cdp status
/cdp ask
/cdp on
/cdp off
/cdp port 9222
/cdp launch
/cdp tabs
```

Default mode is `ask`, so browser operations require user confirmation.

## Chrome Launch

Use a dedicated Chrome profile:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.ugk/chrome-cdp-profile"
```

Login state stays inside Chrome. UGK does not store passwords, cookies, or credentials.

## Tool

The AI-callable tool is:

```text
chrome_cdp
```

Supported actions:

```text
status
tabs
navigate
evaluate
screenshot
```

Every non-status call should include a reason and whether ordinary access was attempted.
