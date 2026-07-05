# web_search

`web_search` starts its own headless Chrome on port `9223`, with profile
`~/.ugk/web-search-profile`, then opens Google Search and falls back to Bing CN
when Google fails or returns anti-bot text.

It is intentionally isolated from `extensions/chrome-cdp/`: separate process,
port, profile, and source files. Delete this directory to remove the feature.

The tool returns the SERP page text. It does not parse results; the agent reads
titles, URLs, and snippets itself.

## web_read

`web_read(url)` reads the main text of any http/https page using the same
isolated Chrome (port 9223, profile `~/.ugk/web-search-profile`). Injects a
lightweight readability-style JS (selects article/main/[role=main], falls back
to body.innerText, strips nav/footer/script). Zero new dependencies.

Pair with `web_search`: search returns links, `web_read` reads them.
