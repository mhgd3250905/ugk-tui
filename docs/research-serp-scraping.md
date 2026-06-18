# 无头浏览器直接抓取搜索引擎结果页 — 技术调研报告

> 调研日期：2026-06-18  
> 调研目标：AI agent 如何绕过聚合 API，直接用无头浏览器/HTTP 客户端抓取 Google、Bing、DuckDuckGo 搜索结果页

---

## 1. 核心发现摘要

| 发现 | 详情 |
|---|---|
| **Google 纯 HTTP 已不可行** | Google 现在对所有请求（包括 `Lynx` UA）都返回 JS Challenge 页面，强制执行 `SG_SS` Cookie 验证。无头浏览器是**强制要求** |
| **DuckDuckGo HTML 版仍然可用** | `html.duckduckgo.com` 返回语义化 HTML，但 2026 年新增了 `anomaly.js` 检测——连续请求会触发 CAPTCHA（选鸭子图片） |
| **Bing 相对宽松** | 反爬策略比 Google 弱，但仍需合理 UA + 延迟 |
| **反检测已进入 C++ 层面** | 新一代工具（Camoufox、CloakBrowser）在浏览器源码层修改指纹，不再依赖 JS 级别的 shim |

---

## 2. 工具链对比

### 2.1 Playwright vs Puppeteer vs Selenium vs 纯 HTTP

| 维度 | Playwright | Puppeteer | Selenium | 纯 HTTP (curl/cheerio) |
|---|---|---|---|---|
| **启动速度** | ~1-2s (Chromium) | ~1-2s (Chromium) | ~2-5s | 即时 |
| **资源占用** | ~200-400MB | ~200-400MB | ~300-600MB | ~10-50MB |
| **反检测能力** | 中等（可配合 stealth 插件） | 中等（`puppeteer-extra`） | 弱（易被检测 `navigator.webdriver`） | **极弱** — Google 直接返回 JS Challenge |
| **多浏览器支持** | ✅ Chromium + Firefox + WebKit | ❌ 仅 Chromium | ✅ 全浏览器 | N/A |
| **API 设计** | 现代化 async，自动等待 | 基础 async | 老旧，需手动等待 | N/A |
| **Google 可用性** | ✅（需 stealth） | ✅（需 stealth） | ⚠️（极易被检测） | ❌ 直接拦截 |
| **DDG 可用性** | ✅ | ✅ | ✅ | ✅（需合理 UA + 延迟） |
| **AI Agent 适用性** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐ | ⭐（仅 DDG） |

### 2.2 关键结论

1. **纯 HTTP 抓取 Google 已彻底死亡**：实测 Google 对所有请求返回 JS Challenge（`SG_SS` Cookie 机制），哪怕用 Lynx 文本浏览器 UA 也只会看到 "Update your browser"。**无头浏览器是强制要求**。

2. **Playwright 是 Agent 场景最佳选择**：
   - 多浏览器支持允许 Firefox 指纹伪装（Camoufox）
   - 自动等待机制减少时序特征暴露
   - `playwright-stealth` 社区活跃

3. **Puppeteer 在 Google 场景仍有优势**：`puppeteer-extra-plugin-stealth` 是目前最成熟的 stealth 方案，但仅限 Chromium。

---

## 3. 反检测技术矩阵

### 3.1 检测维度与对策

| 检测维度 | Google 检测方式 | 对策 |
|---|---|---|
| `navigator.webdriver` | 检测该属性是否为 `true` | CDP 模式抹除（`--disable-blink-features=AutomationControlled`） |
| Chrome Runtime 指纹 | 检测 `chrome.runtime` 对象是否存在 | `puppeteer-extra-plugin-stealth` 自动处理 |
| User-Agent 一致性 | 检测 UA 与浏览器指纹不匹配 | 使用真实浏览器 UA 字符串 |
| WebGL 指纹 | Canvas/WebGL 渲染器字符串 | C++ 级修改（Camoufox/CloakBrowser） |
| 字体指纹 | 枚举系统字体列表 | 限制字体枚举 API |
| 硬件并发数 | `navigator.hardwareConcurrency` | 伪装为常见值（如 8） |
| 屏幕分辨率 | `screen.width/height` | 伪装为常见分辨率 |
| 请求时序 | 分析请求间隔的随机性 | 人为随机延迟 + 模拟人类浏览行为 |
| IP 信誉 | Google 维护 IP 黑名单 | 住宅代理轮换 |
| Cookie 历史 | 检查搜索历史、Google 账户关联 | 每次使用干净的浏览器 context |

### 3.2 主流反检测工具对比

| 工具 | 层级 | 原理 | 通过率 | 成熟度 | 适用引擎 |
|---|---|---|---|---|---|
| **CloakBrowser** (26.5k ⭐) | C++ 源码层 | 在 Chromium 源码中修改指纹实现 | 30/30 测试通过 | 🟢 成熟 | Playwright 兼容 |
| **Camoufox** | C++ 源码层 | Firefox 分支，源码级指纹伪装 | 极高 | 🟢 成熟 | Playwright (Firefox) |
| **camofox-browser** (6.9k ⭐) | C++ + REST API | 将 Camoufox 包装为 REST API 服务，专为 AI Agent 设计 | 极高 | 🟢 成熟 | REST API（语言无关） |
| **Botasaurus** (4.8k ⭐) | Python 框架 | 集成 undetected-chromedriver + 人类行为模拟 | 通过 Cloudflare 等全部测试 | 🟢 成熟 | Selenium/CDP |
| **SeleniumBase** (12.8k ⭐) | Python 框架 | CDP Mode 绕过 `navigator.webdriver`，UC 模式 | 通过全部 bot 检测 | 🟢 成熟 | Selenium + Playwright |
| **undetected-chromedriver** | Python 库 | 补丁修改 chromedriver 二进制 | 中等 | 🟡 维护中 | Selenium |
| **puppeteer-extra-plugin-stealth** | JS shim 层 | 在页面加载前注入 JS 修改各种指纹 | 中等 | 🟡 维护中 | Puppeteer |
| **playwright-stealth** | JS shim 层 | Playwright 版 stealth 注入 | 中等 | 🟡 社区维护 | Playwright |

### 3.3 核心反检测策略（Agent 实战建议）

```python
# 推荐的反检测配置示例（Playwright + Camoufox）
from camoufox import Camoufox

# Camoufox 在 browser launch 时就完成了所有指纹伪装
browser = Camoufox(
    headless=True,
    humanize=True,           # 模拟人类鼠标移动/滚动
    geoip=True,              # 根据代理 IP 自动匹配时区/语言
    screen=(1920, 1080),    # 常见分辨率
    proxy="socks5://residential-proxy:1080",  # 住宅代理
)

context = browser.new_context(
    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...",
    viewport={"width": 1920, "height": 1080},
    locale="en-US",
    timezone_id="America/New_York",
)
```

### 3.4 请求策略

```
┌─────────────────────────────────────────────────────────┐
│  推荐请求间隔策略                                         │
│                                                         │
│  ● Google:  每次搜索间隔 10-30s 随机（每 4-5 次搜索后换 IP） │
│  ● Bing:    每次搜索间隔 5-15s 随机                        │
│  ● DDG:     每次搜索间隔 3-8s 随机（过快触发 anomaly 验证）  │
│  ● 代理轮换: 每次浏览器 context 创建时更换 IP               │
│  ● Cookie:  每次搜索使用新的无痕 context，不保留历史          │
└─────────────────────────────────────────────────────────┘
```

---

## 4. HTML 解析方案

### 4.1 解析库选择

| 库 | 语言 | 适用场景 | 性能 |
|---|---|---|---|
| **cheerio** | Node.js | 静态 HTML 解析，jQuery 风格 API | 极快（~50ms/page） |
| **jsdom** | Node.js | 需要模拟 DOM 环境（但不需要完整浏览器） | 慢（~200ms/page） |
| **BeautifulSoup4** | Python | 静态 HTML，Python 生态首选 | 快 |
| **lxml** | Python | 高性能 XML/HTML 解析 | 极快 |
| **playwright 内置** | Node.js/Python | 动态页面 JS 渲染后提取 | 慢（需渲染） |

**推荐**：对于 SERP 抓取，**cheerio** (Node.js) 或 **BeautifulSoup4** (Python) 最适合——因为搜索结果基本在静态 HTML 中（Google 除外，需要先通过 JS Challenge）。

### 4.2 DuckDuckGo HTML 版解析（2026 实测）

DuckDuckGo HTML 版 (`html.duckduckgo.com`) 是最容易抓取的目标。HTML 结构语义化，CSS 类名稳定：

```javascript
// Node.js + cheerio — DDG HTML 版解析
const cheerio = require('cheerio');

function parseDuckDuckGoResults(html) {
  const $ = cheerio.load(html);
  const results = [];

  $('#links .result').each((i, el) => {
    const $el = $(el);
    const $link = $el.find('a.result__a');
    const rawUrl = $link.attr('href'); // //duckduckgo.com/l/?uddg=REAL_URL&rut=...

    results.push({
      title: $link.text().trim(),
      url: decodeURIComponent(
        (rawUrl.match(/uddg=([^&]+)/) || [])[1] || rawUrl
      ),
      snippet: $el.find('a.result__snippet').text().trim(),
      displayedUrl: $el.find('a.result__url').text().trim(),
      favicon: $el.find('img.result__icon__img').attr('src') || null,
    });
  });

  return results;
}
```

**DDG HTML DOM 结构速查：**

```
div#links
  div.result.results_links.results_links_deep.web-result
    div.links_main.links_deep.result__body
      h2.result__title
        a.result__a[href="//duckduckgo.com/l/?uddg=REAL_URL&rut=..."]
          → 标题文本
      div.result__extras
        div.result__extras__url
          span.result__icon
            img.result__icon__img[src="...favicon.ico"]    ← 站点图标
          a.result__url                                    ← 可见 URL
      a.result__snippet                                    ← 摘要
      div.clear
```

**实际抓取代码（完整可用）：**

```python
# Python — DDG HTML 版抓取
import requests
from bs4 import BeautifulSoup
from urllib.parse import unquote
import time
import random

def search_duckduckgo(query: str, max_results: int = 10) -> list[dict]:
    """抓取 DuckDuckGo HTML 版搜索结果"""
    results = []
    url = f"https://html.duckduckgo.com/html/?q={query}"

    headers = {
        # 关键：DDG 对 Lynx UA 和 Chrome UA 有不同待遇
        # Lynx UA 更容易获取纯净 HTML，但稳定性略低
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/125.0.0.0 Safari/537.36"
    }

    resp = requests.get(url, headers=headers, timeout=10)

    # 检查是否被 anomaly 拦截
    if "anomaly-modal" in resp.text:
        raise Exception("DDG bot detection triggered — 需要换 IP 或增加延迟")

    soup = BeautifulSoup(resp.text, "html.parser")

    for el in soup.select("#links .result"):
        title_el = el.select_one("a.result__a")
        snippet_el = el.select_one("a.result__snippet")
        url_el = el.select_one("a.result__url")
        icon_el = el.select_one("img.result__icon__img")

        if not title_el:
            continue

        raw_href = title_el.get("href", "")
        # DDG 使用 /l/?uddg=REAL_URL&rut=... 格式重定向
        import re
        match = re.search(r"uddg=([^&]+)", raw_href)
        real_url = unquote(match.group(1)) if match else raw_href

        results.append({
            "title": title_el.get_text(strip=True),
            "url": real_url,
            "snippet": snippet_el.get_text(strip=True) if snippet_el else "",
            "displayed_url": url_el.get_text(strip=True) if url_el else "",
            "favicon": icon_el.get("src") if icon_el else None,
        })

        if len(results) >= max_results:
            break

    return results

# 使用
if __name__ == "__main__":
    time.sleep(random.uniform(3, 8))  # 重要：避免触发 anomaly 检测
    results = search_duckduckgo("python programming")
    for r in results:
        print(f"📄 {r['title']}")
        print(f"   {r['url']}")
        print(f"   {r['snippet'][:100]}...\n")
```

### 4.3 Google SERP 解析（需要先过 JS Challenge）

Google 2024-2025 的 SERP HTML 结构以大量随机 CSS 类名为特征，但仍有稳定的语义标记可用：

```javascript
// Playwright + cheerio — Google SERP 解析（需先通过 SG_SS 验证）
const { chromium } = require('playwright');
const cheerio = require('cheerio');

async function searchGoogle(query) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  });

  const page = await context.newPage();

  // 注入 stealth 脚本（简化版）
  await page.addInitScript(() => {
    delete Object.getPrototypeOf(navigator).webdriver;
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
  });

  await page.goto(
    `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`,
    { waitUntil: 'networkidle' }
  );

  const html = await page.content();
  const $ = cheerio.load(html);
  const results = [];

  // Google 2024-2025 SERP 解析策略
  // 策略 1: 找包含 /url?q= 的 <a> 标签的父容器
  $('a[href^="/url?q="]').each((i, el) => {
    const $link = $(el);
    // 找到包含此链接的结果容器（向上找最近的块级容器）
    const $container = $link.closest('div[data-sokoban-container], div[data-header-feature]').length
      ? $link.closest('div[data-sokoban-container], div[data-header-feature]')
      : $link.closest('div.g').length
        ? $link.closest('div.g')
        : $link.parent().parent();

    const rawUrl = $link.attr('href');
    const realUrl = decodeURIComponent(
      rawUrl.replace('/url?q=', '').split('&sa=')[0]
    );

    // 提取标题
    const title = $link.find('h3').text().trim() || $link.text().trim();

    // 提取摘要 — Google 使用 <span> 包裹摘要文本
    const snippet = $container.find('span.aCOpRe, span.st, div[data-sncf] span')
      .first().text().trim()
      || $container.find('div[data-content-feature-id] span').first().text().trim();

    // 提取可见 URL
    const citeEl = $container.find('cite');
    const displayedUrl = citeEl.text().trim();

    // 去重（同一 URL 只保留第一个）
    if (!results.find(r => r.url === realUrl)) {
      results.push({ title, url: realUrl, snippet, displayedUrl });
    }
  });

  await browser.close();
  return results;
}
```

**Google SERP 关键选择器速查（2024-2025）：**

| 目标 | CSS 选择器 | 说明 |
|---|---|---|
| 结果链接 | `a[href^="/url?q="]` | Google 将所有外链包装为 `/url?q=REAL_URL&sa=...` |
| 标题 | `a[href^="/url?q="] h3` | 标题始终在 `<h3>` 中 |
| 摘要 | `span.aCOpRe`, `div[data-sncf] span` | 摘要的类名不稳定，用结构选择器 |
| 可见 URL | `cite` | 面包屑 URL 在 `<cite>` 中 |
| 单个结果容器 | `div.g`（传统）, `div[data-sokoban-container]`（新版） | 嵌套结构，不建议过度依赖 |
| 图片结果 | `div[data-attrid="images"]` | 图片搜索区块 |
| 知识面板 | `div.kp-wholepage` | Knowledge Graph 面板 |

### 4.4 静态 HTML vs JavaScript 渲染

| 场景 | 是否需要 JS 渲染 | 推荐方案 |
|---|---|---|
| Google 搜索 | **强制需要** — SG_SS Challenge 必须执行 JS | Playwright/Puppeteer headless |
| DuckDuckGo HTML | ❌ 不需要 — 纯 HTML 即可 | curl + cheerio/BeautifulSoup |
| Bing 搜索 | 部分需要 — 某些动态加载内容可能缺失 | 优先 HTTP，回退 headless |
| 知识面板/富文本摘要 | ⚠️ Google 需要，DDG 不需要 | 按搜索引擎决定 |

---

## 5. DuckDuckGo 端点详细分析

### 5.1 可用端点

| 端点 | URL | 状态 | 反爬强度 |
|---|---|---|---|
| **HTML 版** | `https://html.duckduckgo.com/html/?q=QUERY` | ✅ 可用 | 🟡 中等（anomaly.js） |
| **Lite 版** | `https://lite.duckduckgo.com/lite/?q=QUERY` | ⚠️ 触发 anomaly | 🔴 更强（实测更易触发） |
| **主站 JS 版** | `https://duckduckgo.com/?q=QUERY` | ✅ 可用 | 🟡 中等 |
| **Instant Answer API** | `https://api.duckduckgo.com/?q=QUERY&format=json` | ✅ 可用 | 🟢 宽松（官方 API） |

### 5.2 DDG Anomaly 检测实测

2026 年 DDG 在 HTML 版和 Lite 版都加入了 `anomaly.js` 检测：

- **第一次请求**（冷 IP + 合理 UA）：✅ 正常返回结果
- **连续请求**（无间隔）：❌ 触发 CAPTCHA（"Select all squares containing a duck"）
- **Lynx UA**：✅ 对 HTML 版更友好（Simplicity 特性）
- **建议间隔**：每次搜索间隔 3-8 秒随机延迟

### 5.3 DDG vs Google 抓取难度对比

```
难度评级（1=最简单，10=最困难）

DuckDuckGo HTML:    ████░░░░░░ (4/10)  — 纯 HTTP 可行，需控制频率
DuckDuckGo Lite:    ██████░░░░ (6/10)  — 更激进的 anomaly 检测
Bing:               ██████░░░░ (6/10)  — 需要 headless browser
Google:             █████████░ (9/10)  — 强制 JS Challenge + IP 信誉 + 指纹检测
```

---

## 6. 核心开源项目列表

### 6.1 反检测浏览器（基础设施层）

| 项目 | ⭐ Stars | 技术栈 | 特色 |
|---|---|---|---|
| **[CloakBrowser](https://github.com/CloakHQ/CloakBrowser)** | 26,494 | Python + 定制 Chromium | C++ 源码级指纹修改，30/30 测试通过，Playwright 兼容 |
| **[camofox-browser](https://github.com/jo-inc/camofox-browser)** | 6,921 | Node.js + Camoufox (Firefox) | 专为 AI Agent 设计的 REST API 浏览器服务，accessibility snapshot 替代原始 HTML，token 效率高 90% |
| **[SeleniumBase](https://github.com/seleniumbase/SeleniumBase)** | 12,797 | Python | Selenium 增强框架，CDP Mode 绕过检测，UC（undetected-chromedriver）模式 |
| **[Botasaurus](https://github.com/omkarcloud/botasaurus)** | 4,811 | Python | 一站式反检测框架，通过 Cloudflare/Datadome/Fingerprint 全部测试，支持桌面 App 打包 |

### 6.2 SERP 抓取引擎（业务层）

| 项目 | ⭐ Stars | 技术栈 | 特色 |
|---|---|---|---|
| **[GoogleScraper](https://github.com/NikolaiT/GoogleScraper)** | 2,821 | Python + async | 多搜索引擎（Google/Bing/DDG/Yandex），异步，支持代理轮换 |
| **[Search-Engines-Scraper](https://github.com/tasos-py/Search-Engines-Scraper)** | 668 | Python + Requests + BS4 | 最简洁的纯 HTTP 方案，以 Lynx UA 抓取 Google（2026 年 Google 部分已失效），支持 7+ 引擎 |
| **[SerpScrap](https://github.com/ecoron/SerpScrap)** | 272 | Python + Selenium | 完整的 SEO 数据提取，支持截图、内容抓取、CSV 导出 |
| **[SerpScraper](https://github.com/Athlon1600/SerpScraper)** | 105 | PHP | PHP 生态 SERP 抓取，支持 2captcha 自动解决 Google 验证码 |
| **[goop](https://github.com/s0md3v/goop)** | 571 | Python | ⚠️ 已失效 — 曾利用 Facebook Debugger 白名单绕过 Google 限制（技术思路有价值） |

### 6.3 辅助工具

| 项目 | ⭐ Stars | 类型 | 用途 |
|---|---|---|---|
| **[search-result-scraper-markdown](https://github.com/essamamdani/search-result-scraper-markdown)** | 239 | FastAPI + SearXNG | 元搜索引擎 + Markdown 转换，适合 AI Agent 消费 |
| **[one-search-mcp](https://github.com/yokingma/one-search-mcp)** | 119 | TypeScript MCP Server | 统一搜索 MCP Server，聚合多种后端 |
| **[playwright_stealth](https://github.com/AtuboDad/playwright_stealth)** | 964 | Python | Playwright stealth 补丁 |
| **[serp-spider/core](https://github.com/serp-spider/core)** | 94 | PHP | PHP SERP 抓取框架 |

---

## 7. 推荐技术方案（AI Agent 场景）

### 7.1 方案 A：最小成本方案（DDG 优先）

```
┌──────────────────────────────────────────────┐
│  DuckDuckGo HTML API                          │
│                                              │
│  curl/requests ──► html.duckduckgo.com       │
│       │                                      │
│       ▼                                      │
│  cheerio/BeautifulSoup4 解析                  │
│       │                                      │
│       ▼                                      │
│  结构化结果 [{title, url, snippet, favicon}]  │
│                                              │
│  优点：零浏览器依赖，启动快，资源省             │
│  缺点：仅 DDG，结果量与质量不如 Google          │
└──────────────────────────────────────────────┘
```

### 7.2 方案 B：生产级方案（多引擎 + 反检测）

```
┌──────────────────────────────────────────────┐
│  camofox-browser REST API (或 CloakBrowser)   │
│       │                                      │
│       ▼                                      │
│  Playwright/Camoufox ──► Google/Bing/DDG     │
│       │                                      │
│       ▼                                      │
│  cheerio 解析 HTML ──► 结构化结果             │
│       │                                      │
│       ▼                                      │
│  代理轮换 (住宅代理池)                         │
│       │                                      │
│       ▼                                      │
│  缓存层 (Redis) — 避免重复搜索                 │
│                                              │
│  优点：覆盖面广，反检测强，生产级稳定            │
│  缺点：基础设施成本高，延迟较高                  │
└──────────────────────────────────────────────┘
```

### 7.3 方案 C：混合方案（推荐）

```
首选：DDG HTML 纯 HTTP 抓取（快速、低成本）
  │
  ├── 命中缓存 → 直接返回
  │
  └── 未命中/结果不足 →
        │
        ├── 常规搜索 → DDG HTML 再试一次（换 UA）
        │
        └── 重要查询 → 启动 headless browser → Google
                        │
                        └── 写缓存（24h TTL）
```

---

## 8. 关键注意事项

1. **法律与 ToS**：抓取 Google 搜索结果违反其服务条款，仅供研究参考。DuckDuckGo 对抓取更加宽容，但 anomaly 检测表明他们也在加强防御。

2. **IP 信誉至关重要**：Google 的 SG_SS Challenge 是基于 IP 信誉 + 浏览器指纹的联合检测。即使完美指纹，来自数据中心 IP 的请求也极易触发验证码。

3. **不要试图破解 CAPTCHA**：如果触发了 Google reCAPTCHA 或 DDG anomaly，正确的做法是换 IP 并增加延迟，而非尝试自动解决 CAPTCHA（效果差、成本高、法律风险大）。

4. **考虑元搜索引擎**：SearXNG 是一个开源元搜索引擎，可以自部署，聚合多个搜索引擎结果，是最合规的替代方案。
