# 搜索引擎官方 API（第一方 API）调研报告

> 调研日期：2026-06-18  
> 范围：只关注搜索引擎公司自己提供的第一方 API，不含聚合中间商（SerpAPI、Tavily、SearchApi.io 等）

---

## 目录
1. [Google Programmable Search Engine](#1-google-programmable-search-engine)
2. [Bing Web Search API (Azure)](#2-bing-web-search-api-azure)
3. [Brave Search API](#3-brave-search-api)
4. [Mojeek Search API](#4-mojeek-search-api)
5. [Kagi Search API](#5-kagi-search-api)
6. [You.com API](#6-youcom-api)
7. [Yandex Search API](#7-yandex-search-api-情况)
8. [综合对比表](#综合对比表)
9. [作为 agent web search 后端的推荐](#作为-agent-web-search-后端的推荐)

---

## 1. Google Programmable Search Engine

（原 Google Custom Search JSON API）

### 基本信息

| 项目 | 内容 |
|------|------|
| **全名** | Custom Search JSON API（Programmable Search Engine） |
| **端点** | `GET https://customsearch.googleapis.com/customsearch/v1` |
| **认证方式** | API Key 作为 `key` 查询参数；同时需要 Search Engine ID (`cx`) |
| **响应格式** | JSON |
| **文档** | https://developers.google.com/custom-search/v1/overview |
| **SDK** | Google API Client Library（Python/Node.js/Java/Go 等） |

### 价格 / 额度

| 层 | 内容 |
|----|------|
| **免费** | 100 queries / 天 |
| **付费** | $5 / 1000 queries，上限 10k queries / 天 |
| **付费前提** | 需要在 Google Cloud Console 设置 billing account |

### 核心返回字段

```json
{
  "items": [
    {
      "title": "页面标题",
      "link": "https://...",
      "snippet": "搜索摘要片段",
      "displayLink": "显示的域名",
      "formattedUrl": "格式化的 URL",
      "pagemap": { /* 结构化数据（schema.org） */ }
    }
  ],
  "searchInformation": {
    "totalResults": "结果总数(字符串)",
    "formattedTotalResults": "格式化的结果数"
  },
  "queries": { "request": [{ "totalResults": "..." }] },
  "context": { "title": "搜索引擎名称" }
}
```

### 限制与 Notes

- **最多 100 条结果**：即使匹配文档超过 100，API 也不会返回更多，`start + num > 100` 报错
- **每页最多 10 条**：`num` 参数最大值为 10
- **需要预配置搜索引擎**：必须先在 https://programmablesearchengine.google.com/ 创建 Search Engine，指定要搜索的网站（可设为搜索整个网络）
- **不能替代 Google 搜索**：本质是"自定义搜索"，如果选择 "Search the entire web" 模式，效果接近普通 Google 搜索
- **不是真正的 Google 通用搜索**：结果集和排名可能与 google.com 不完全一致
- **有 Ads-Free Paid API**：付费版可去除广告元素

### npm 包
- `googleapis`（官方综合包，包含 customsearch v1）

---

## 2. Bing Web Search API (Azure)

### 基本信息

| 项目 | 内容 |
|------|------|
| **全名** | Bing Web Search API v7（Azure Cognitive Services 下） |
| **端点** | `GET https://api.bing.microsoft.com/v7.0/search` |
| **认证方式** | `Ocp-Apim-Subscription-Key` 请求头（Azure subscription key） |
| **响应格式** | JSON |
| **文档** | https://learn.microsoft.com/en-us/bing/search-apis/bing-web-search/overview |

⚠️ **重要**：Microsoft Learn 上此文档已标记为 `is_archived: true` / `is_retired: true`。当前产品入口已迁移至 Azure Marketplace 的 "[Grounding with Bing](https://www.microsoft.com/en-us/bing/apis)"。

### 价格 / 额度

| 层 | 价格 | 每秒请求(QPS) |
|----|------|---------------|
| **Free (F0)** | $0/月 | 3 QPS |
| **Standard (S0)** | 按量付费 | ~10+ QPS |
| **更高层** | 联系 Microsoft | 更高 |

具体价格取决于 Azure 订阅层级和计费模式。所有层均需 Azure 订阅。

### 核心返回字段

```json
{
  "webPages": {
    "value": [
      {
        "name": "结果标题",
        "url": "https://...",
        "snippet": "搜索片段",
        "displayUrl": "显示的 URL",
        "dateLastCrawled": "最后爬取时间",
        "language": "语言"
      }
    ],
    "totalEstimatedMatches": 12345,
    "someResultsRemoved": false
  },
  "images": { "value": [...] },
  "videos": { "value": [...] },
  "news": { "value": [...] },
  "relatedSearches": { "value": [...] },
  "rankingResponse": { /* 排名信息 */ }
}
```

### 特性

- **SafeSearch**：可配置严格/中等/关闭
- **市场过滤**：`mkt` 参数（如 `en-US`、`zh-CN`）
- **新鲜度过滤**：`freshness` 参数（Day/Week/Month）
- **答案过滤**：可选择嵌入 News、Images、Videos
- **Hit highlighting**：支持搜索结果高亮
- 返回 images/videos/news 等多种 answer 类型
- **限制**：URL 最大 2048 字符，query 参数 < 1500 字符
- **使用约束**：只能用于直接用户查询或可解释为搜索请求的操作

### SDKs
- Azure SDK for Python / .NET / Java / JavaScript
- npm: `@azure/cognitiveservices-websearch`

---

## 3. Brave Search API

### 基本信息

| 项目 | 内容 |
|------|------|
| **全名** | Brave Search API |
| **端点** | `GET https://api.search.brave.com/res/v1/web/search` |
| **LLM 专用端点** | `GET https://api.search.brave.com/res/v1/llm/context` |
| **Chat 端点** | `POST https://api.search.brave.com/res/v1/chat/completions` |
| **认证方式** | `X-Subscription-Token` 请求头 或 API Key |
| **响应格式** | JSON |
| **文档** | https://brave.com/search/api/ |
| **索引规模** | 40+ 亿页面 |

### 价格 / 额度

| 方案 | 价格 | 备注 |
|------|------|------|
| **Search Plan** | $5 / 1000 requests | 含 $5 免费月额度（自动应用） |
| **Answers Plan** | $4 / 1000 requests | 含 $5 免费月额度 |
| **Enterprise** | 联系 Brave | 定制容量/端点 |

所有账户注册即获 **$5 免费月额度**，无需绑定信用卡。

### 核心返回字段

```json
{
  "web": {
    "results": [
      {
        "title": "结果标题",
        "url": "https://...",
        "description": "描述片段",
        "age": "页面年龄",
        "language": "语言代码"
      }
    ]
  },
  "news": { "results": [...] },
  "videos": { "results": [...] },
  "images": { "results": [...] },
  "discussions": { "results": [...] },
  "locations": { "results": [...] },
  "summarizer": {
    "key": "AI 摘要文本"
  }
}
```

### 特色功能

- **Goggles**：可自定义搜索排名过滤器（对 agent 有用）
- **AI Summarizer**：返回搜索结果的 AI 生成摘要
- **LLM Context 端点**：专门为 LLM/AI agent 优化的端点，返回适合注入 prompt 的格式化内容
- **MCP Server**：Brave 提供了 [MCP Server](https://github.com/brave/brave-search-mcp-server)，可直接集成到 Claude Desktop、Cursor 等
- **Specialized endpoints**：Web、Images、Videos、News、Suggest、Spellcheck、Locations
- **独立索引**：使用自己的网络爬虫索引，不依赖 Google/Bing

### 其他端点
- `GET https://api.search.brave.com/res/v1/suggest?q=...`
- `GET https://api.search.brave.com/res/v1/spellcheck?q=...`
- `GET https://api.search.brave.com/res/v1/images/search?q=...`
- `GET https://api.search.brave.com/res/v1/videos/search?q=...`
- `GET https://api.search.brave.com/res/v1/news/search?q=...`

### npm 包
- 无官方 npm 包，通过简单 HTTP fetch 调用即可
- Brave 提供 curl / Python / Go 示例

---

## 4. Mojeek Search API

### 基本信息

| 项目 | 内容 |
|------|------|
| **全名** | Mojeek Web Search API |
| **端点** | 需联系获取（HTTP GET） |
| **认证方式** | API Key |
| **响应格式** | JSON 或 XML |
| **文档** | https://www.mojeek.com/services/search/web-search-api/ |
| **API 文档** | https://www.mojeek.com/support/api/ |
| **特色** | 独立搜索引擎，基于自有爬虫，隐私友好 |

### 价格 / 额度

| 方案 | 价格（CPM） | QPS | 存储权限 | AI 使用 |
|------|------------|-----|---------|---------|
| **Startup** | £2 / 1000 queries | 5 QPS | ❌（仅 1h 缓存） | ✅ |
| **Business** | £3 / 1000 queries | 更高 | ✅ | ✅ |
| **Enterprise** | 联系洽谈 | 定制 | ✅ | ✅ |

支付方式：Stripe Pay-as-you-go 信用系统；Enterprise 可开发票。

### 核心返回字段

- 结果包含 title、URL、description/snippet
- 支持 Focus 功能（限定域名搜索）

### Notes

- **独立索引**：英国团队自建爬虫，索引数十亿页面，不依赖 Google/Bing
- **隐私友好**：不追踪用户
- **灵活条款**：Business 及以上可存储搜索结果
- **需联系开通**：无在线自助注册，需发邮件/联系表单获取 API key
- **无免费层**：所有方案均需付费，但单价低

### npm 包
- 无官方 npm 包

---

## 5. Kagi Search API

### 基本信息

| 项目 | 内容 |
|------|------|
| **全名** | Kagi Search API |
| **端点** | `GET https://kagi.com/api/v1/search?q=...` |
| **认证方式** | API Token（账户内生成） |
| **响应格式** | JSON |
| **文档** | https://help.kagi.com/kagi/api/overview.html |
| **API 文档** | https://kagi.com/api/docs |

### 价格 / 额度

- Kagi 是**付费搜索引擎**，需订阅 plan（Starter $5/月, Professional $10/月, Ultimate $25/月）
- API 使用计入账户的搜索配额
- 无独立免费 API 层

### API 套件

Kagi 提供整套 API：

| API | 端点 | 说明 |
|-----|------|------|
| **Search API** | `GET /api/v1/search` | 网页搜索 |
| **Summarizer** | `POST /api/v0/summarize` | 页面摘要 |
| **FastGPT** | `POST /api/v0/fastgpt` | 快速 LLM 问答（带搜索增强） |
| **Enrichment API** | `POST /api/v1/enrich` | URL 内容丰富/提取 |
| **Small Web RSS** | `GET /api/v1/smallweb/feed` | 独立网站 RSS |

### 核心返回字段

```json
{
  "data": [
    {
      "t": 1000,
      "url": "https://...",
      "title": "结果标题",
      "snippet": "结果片段",
      "published": "2024-01-01"
    }
  ]
}
```

### 特色

- **继承账户设置**：API 继承用户的自定义搜索偏好（屏蔽/提升网站、Lenses 等）
- **无广告、无追踪**
- **搜索结果质量高**：人工策划的搜索源
- **Lenses**：可自定义搜索范围（如学术、论坛、编程等）
- **不适合大规模 agent 调用**：面向个人用户，非 enterprise API 定位

### npm 包
- 无官方 npm 包

---

## 6. You.com API

### 基本信息

| 项目 | 内容 |
|------|------|
| **全名** | You.com API |
| **文档** | https://you.com/docs/welcome |
| **定位** | Real-Time Web Intelligence for AI Applications |
| **认证方式** | API Key（`x-api-key` 头） |
| **响应格式** | JSON |

### API 套件

| API | 说明 |
|-----|------|
| **Search API** | 实时网页搜索 |
| **Contents API** | 获取页面完整内容 |
| **Research API** | 深度调研搜索（类似 AI agent 多步搜索） |

### 价格 / 额度

- 提供 **免费试用信用**，无需信用卡
- 具体定价需查阅 https://you.com/docs

### 特色

- **AI-native 设计**：专为 AI 应用/RAG 场景设计
- **Research API**：内置多步搜索能力，适合 agent
- **实时索引**
- **以开发者为中心**：文档使用 Fern 构建，专业化程度高

### npm 包
- 无官方 npm 包（通过 HTTP 调用）

---

## 7. Yandex Search API（情况）

Yandex 曾提供 **Yandex.XML** 搜索 API，但目前：

- 新的 Yandex Cloud 下已转型为 **Yandex Search API**（属于 Yandex Cloud 服务）
- 文档地址：https://yandex.cloud/en/docs/search-api/
- 需要 Yandex Cloud 账户和 billing
- 访问受限（俄语区为主，国际用户可能需要 bypass）
- 调研时被 Yandex SmartCaptcha 拦截

Yandex 搜索 API 在中文/英文内容搜索方面质量不如 Google/Bing，但俄语内容有优势。对 general agent web search 场景**不推荐**。

---

## 综合对比表

| 维度 | Google CSE | Bing Web | Brave | Mojeek | Kagi | You.com |
|------|-----------|----------|-------|--------|------|---------|
| **免费层** | 100/day | 有(F0) | $5 信用/月 | ❌ | ❌（需订阅） | 试用信用 |
| **付费单价** | $5/1k | 按 Azure 层 | $5/1k | £2~3/1k | 含在月费中 | 待确认 |
| **索引来源** | Google | Bing | 自有 | 自有(独立) | 混合(含 Google) | 自有 |
| **API Key** | ✅ GCP key | ✅ Azure key | ✅ Header | 需联系 | 账户 Token | ✅ x-api-key |
| **结果上限** | 100 条 | 无硬限制 | 无硬限制 | 按计划 | 按计划 | 待确认 |
| **每页条数** | 10 | 可配 | 可配 | 可配 | 可配 | 可配 |
| **AI/LLM 支持** | ❌ | ❌ | ✅ LLM端点+MCP | 部分 | ✅ FastGPT | ✅ Research API |
| **独立索引** | - | - | ✅ | ✅ | 混合 | ✅ |
| **隐私友好** | ❌ | ❌ | ✅ | ✅ | ✅ | 中等 |
| **区域覆盖** | 全球 | 全球 | 全球 | 英文为主 | 英文为主 | 英文为主 |
| **自助注册** | ✅ | ✅ | ✅ | ❌(需联系) | ✅ | ✅ |
| **npm SDK** | `googleapis` | `@azure/cognitiveservices-websearch` | ❌ | ❌ | ❌ | ❌ |
| **适合 agent** | 一般 | 一般 | ⭐⭐⭐ | ⭐⭐ | ⭐ | ⭐⭐⭐ |

---

## 作为 agent web search 后端的推荐

### 首选：Brave Search API

**优势**：
- 为 LLM/AI agent 场景做了专门优化（`/llm/context` 端点、MCP Server）
- 独立索引 + AI Summarizer + Goggles 可定制
- $5/月免费信用，入门成本极低
- 支持多类型搜索（web/images/videos/news/discussions）
- 隐私友好，不追踪
- 注册简单，立即可用

**劣势**：
- 索引规模（40+ 亿）不如 Google/Bing
- 中文搜索质量不及 Google/Bing
- 无官方 npm 包（但 HTTP 调用足够简单）

### 次选：Bing Web Search API

**优势**：
- 背靠微软，索引覆盖广，全球多语言支持好
- 有免费层(F0)
- Azure 生态集成好
- 有官方 SDK

**劣势**：
- ⚠️ 文档已标记为 archived/retired，产品在转型中
- 需要使用 Azure 订阅
- 使用条款限制：只能用于"用户发起的搜索"
- 对 agent 自主搜索场景的合规性存疑（需咨询 MS）

### 备选：You.com API

**优势**：
- AI-native 设计，Research API 天然适合 agent
- 免费试用信用

**劣势**：
- 较新，稳定性待验证
- 中文支持有限
- 定价不透明

### 不推荐用于 agent 的方案

| 方案 | 原因 |
|------|------|
| **Google CSE** | 100 条硬上限、10 条/页限制、需要预配 Search Engine、不是真正的通用搜索 |
| **Kagi** | 面向个人用户，非 API-first，额度含在个人订阅中 |
| **Mojeek** | 需联系获取 key，无自助注册，英文为主，无免费层 |
| **Yandex** | 中文/英文质量差，被墙风险，注册门槛高 |

### 最佳实战组合

```
主要搜索后端：Brave Search API (web search + LLM context)
备选搜索后端：Bing Web Search API v7 (作为中文/多语言补充)
AI 增强：Brave Summarizer / You.com Research API
```

---

## 备注

- **DuckDuckGo**：不提供官方搜索 API（曾有 Instant Answer API，但已停止）
- **Ecosia**：不提供公开 API
- **SearxNG**：自建元搜索引擎方案（非第一方），可配合上述 API 使用但不属于本报告范围
- 本报告所有价格信息截至 2026-06-18，实际价格以各服务官网为准
