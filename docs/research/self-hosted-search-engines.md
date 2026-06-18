# 开源/自托管搜索引擎技术方案调研

> 调研日期：2026-06-18  
> 目标：为 AI agent 构建自托管 web search 能力选型

---

## 目录

1. [总体分类](#总体分类)
2. [各项目详评](#各项目详评)
   - [SearXNG](#1-searxng-元搜索引擎)
   - [Whoogle Search](#2-whoogle-search)
   - [YaCy](#3-yacy-p2p-分布式搜索引擎)
   - [Meilisearch](#4-meilisearch-全文搜索引擎)
   - [Typesense](#5-typesense-全文搜索引擎)
   - [ZincSearch](#6-zincsearch)
   - [Apache Solr + Nutch](#7-apache-solr--nutch)
   - [Elasticsearch](#8-elasticsearch)
3. [AI Agent 场景对比表](#ai-agent-场景对比表)
4. [推荐路径](#推荐路径)
5. [参考资源](#参考资源)

---

## 总体分类

| 类别 | 代表项目 | 核心思路 |
|------|---------|---------|
| **元搜索引擎** | SearXNG, Whoogle | 聚合 Google/Bing/DuckDuckGo 等结果，本身不建索引 |
| **P2P 搜索引擎** | YaCy | 分布式爬虫 + DHT 索引，独立于商业搜索引擎 |
| **全文搜索引擎（应用内）** | Meilisearch, Typesense, ZincSearch | 对已有文档建全文索引，本身不爬 web |
| **全文搜索引擎（通用）** | Elasticsearch, Solr | 企业级全文检索平台，配合爬虫可建 web 索引 |

---

## 各项目详评

### 1. SearXNG — 元搜索引擎

| 项目 | 值 |
|------|-----|
| **GitHub Stars** | ~32,300 |
| **语言** | Python (Flask) |
| **许可证** | AGPL-3.0 |
| **活跃度** | 极高（2026.6.18 仍在活跃提交） |
| **Open Issues** | 215 |

#### 架构

SearXNG 本身**不建索引、不爬网页**。它作为中间层，将用户查询转发到 **237 个上游搜索引擎** 并合并结果。

内置引擎涵盖：
- **通用 Web 搜索**：Google, Bing, DuckDuckGo, Brave, Qwant, Startpage, Yahoo, Yandex, Mojeek, Marginalia
- **图片**：Google Images, Bing Images, Flickr, Unsplash, DeviantArt
- **视频**：YouTube, Dailymotion, Vimeo, Odysee, PeerTube
- **新闻**：Google News, Bing News, Yahoo News
- **学术**：Google Scholar, arXiv, PubMed, Semantic Scholar, Crossref
- **百科/知识**：Wikipedia, Wikidata, WolframAlpha
- **代码**：GitHub, GitLab, NPM, PyPI, Docker Hub, crates.io
- **专业领域**：IMDb, Genius, HackerNews, Reddit, StackExchange, Spotify, Steam
- **本地引擎**：SQLite, PostgreSQL, MySQL, MariaDB, MongoDB, Solr, Elasticsearch, Meilisearch, Recoll（可接本地数据源！）
- **AI 引擎**：Ollama, Cloudflare AI（实验性）

#### 部署

```bash
# Docker Compose（推荐）
mkdir -p searxng/core-config
cd searxng
curl -O https://raw.githubusercontent.com/searxng/searxng/master/container/docker-compose.yml
curl -O https://raw.githubusercontent.com/searxng/searxng/master/container/.env.example
cp .env.example .env
docker compose up -d
# 默认监听 8080 端口
```

#### API 与 JSON 格式

**端点**：`GET/POST /search`

**关键参数**：

| 参数 | 说明 |
|------|------|
| `q` | 搜索查询（必填） |
| `format` | `json` / `csv` / `rss`（需在 settings.yml 中启用） |
| `engines` | 指定搜索引擎，逗号分隔（如 `google,bing`） |
| `categories` | 指定类别 |
| `pageno` | 页码 |
| `language` | 语言代码 |
| `time_range` | `day` / `month` / `year` |

**JSON 响应结构**：

```json
{
  "query": "搜索词",
  "results": [
    {
      "url": "https://example.com/page",
      "title": "页面标题",
      "content": "页面摘要/描述",
      "engine": "google",
      "engines": ["google", "bing"],
      "score": 0.85,
      "category": "general",
      "parsed_url": {...},
      "publishedDate": "2026-06-15T00:00:00"
    }
  ],
  "answers": [],
  "corrections": [],
  "infoboxes": [],
  "suggestions": ["相关搜索建议"],
  "unresponsive_engines": [["engine_name", "error_type"]]
}
```

**示例调用**：

```bash
# 搜索并获取 JSON
curl 'http://localhost:8080/search?q=rust+programming&format=json'

# 只使用 Google 和 Bing
curl 'http://localhost:8080/search?q=rust+programming&format=json&engines=google,bing'

# 搜索最近一个月的结果
curl 'http://localhost:8080/search?q=rust+programming&format=json&time_range=month'
```

#### AI Agent 集成

SearXNG 是 **AI agent 场景中最成熟的方案**，已有多个专门项目：

- **[searcharvester](https://github.com/vakovalskii/searcharvester)**（242⭐）：SearXNG + FastAPI + trafilatura，Tavily 兼容 API，带 Markdown 内容采集
- **[MCP-searxng](https://github.com/SecretiveShell/MCP-searxng)**（120⭐）：MCP 协议服务器，让 Claude Code / Cursor 等工具直接调用
- **[ask-search](https://github.com/ythx-101/ask-search)**（362⭐）：给 OpenClaw / Claude Code 用的自托管搜索 skill
- **[one-search-mcp](https://github.com/yokingma/one-search-mcp)**（119⭐）：统一 MCP 服务器，支持 SearXNG / Tavily / DuckDuckGo 等多后端
- 主流 AI 框架（LangChain、Open WebUI）均有 SearXNG 集成

**集成方式极简**：

```python
# Python agent 中使用
import requests

def web_search(query: str, num: int = 10) -> list[dict]:
    resp = requests.get(
        "http://localhost:8080/search",
        params={"q": query, "format": "json", "pageno": 1}
    )
    data = resp.json()
    return [
        {"title": r["title"], "url": r["url"], "snippet": r["content"]}
        for r in data["results"][:num]
    ]
```

#### 评估

| 维度 | 评分 | 说明 |
|------|------|------|
| 搜索质量 | ⭐⭐⭐⭐⭐ | 聚合 Google + Bing 等顶级引擎，质量等同原引擎 |
| 部署复杂度 | ⭐⭐⭐⭐⭐ | Docker 一键部署，5 分钟搞定 |
| API 友好度 | ⭐⭐⭐⭐⭐ | 原生 JSON API，字段清晰 |
| Agent 适配度 | ⭐⭐⭐⭐⭐ | 生态最完善，MCP/LangChain 均有集成 |
| 隐私性 | ⭐⭐⭐⭐ | 自托管，可配置 Tor/代理 |
| 资源占用 | ⭐⭐⭐⭐ | 轻量，512MB RAM 足够 |
| 独立性 | ⭐⭐⭐ | 依赖上游搜索引擎，Google 可能封 IP |

---

### 2. Whoogle Search

| 项目 | 值 |
|------|-----|
| **GitHub Stars** | ~11,500 |
| **语言** | Python (Flask) |
| **许可证** | MIT |
| **活跃度** | ⚠️ **2026.4.14 发布最终版本，项目停止维护** |
| **Open Issues** | 3 |

#### ⚠️ 重大警告

Whoogle 作者于 2026 年 4 月 14 日发布公告：**Google 自 2025 年初持续封杀非 JS 请求的 User-Agent 字符串**，Whoogle 的核心工作方式（无 JS 请求 Google 搜索结果）已经失效。项目进入最终版本，不再维护。

> "Since early 2025, Google has been aggressively blocking search queries performed without JavaScript enabled... This is THE fundamental part of how Whoogle works."

**结论：不推荐在 2026 年的新项目中使用 Whoogle。**

#### 架构对比（历史参考）

与 SearXNG 的关键差异：
- Whoogle **只代理 Google**（非多元搜索）
- 通过随机 User-Agent 轮换绕过反爬
- 提供 JSON API（通过 `Accept: application/json` 头或 `?format=json`）
- 部署更简单（单容器），但功能范围窄得多

---

### 3. YaCy — P2P 分布式搜索引擎

| 项目 | 值 |
|------|-----|
| **GitHub Stars** | ~3,960 |
| **语言** | Java |
| **许可证** | GPL-2.0+ |
| **活跃度** | 中等（2026.6 仍在提交） |
| **Open Issues** | 224 |

#### 架构原理

YaCy 是一个**完整的搜索引擎**，包含：
- **爬虫**：可调度，支持 HTTP/FTP/SMB
- **索引器**：对爬取的网页建立本地反向索引
- **P2P 网络层**：通过 DHT（分布式哈希表）与其他 YaCy 节点交换索引
- **Web 前端**：提供搜索 UI 和管理界面

**两种运行模式**：
1. **P2P 集群模式**（默认）：加入 YaCy 网络，与其他节点共享索引，快速获得海量搜索能力
2. **独立模式**：仅使用本地索引，完全隐私

#### 部署

```bash
# Docker
docker run -d --name yacy \
  -p 8090:8090 -p 8443:8443 \
  -v yacy_data:/opt/yacy_search_server/DATA \
  --restart unless-stopped \
  yacy/yacy_search_server:latest

# 管理界面：http://localhost:8090
# 默认账号：admin / yacy
```

#### API 接口

YaCy 几乎所有页面都有对应的 XML/JSON API（橙色的 "API" 图标），包括：

```
# 搜索 JSON API
http://localhost:8090/yacysearch.json?query=search+terms

# 返回 RSS/JSON 混合格式
# {
#   "channels": [{
#     "items": [{
#       "title": "...",
#       "link": "...",
#       "description": "..."
#     }]
#   }]
# }
```

#### AI Agent 集成

- **无已知的专门 AI agent 集成项目**
- API 可用但格式不如 SearXNG 标准化
- Java 运行环境较重

#### 评估

| 维度 | 评分 | 说明 |
|------|------|------|
| 搜索质量 | ⭐⭐⭐ | 依赖 P2P 网络索引质量，不如 Google/Bing |
| 部署复杂度 | ⭐⭐⭐ | Docker 可用，但 Java 运行环境较重 |
| API 友好度 | ⭐⭐ | API 存在但格式老旧，文档不够清晰 |
| Agent 适配度 | ⭐⭐ | 缺少现成集成，响应格式需额外解析 |
| 独立性 | ⭐⭐⭐⭐⭐ | 完全不依赖商业搜索引擎 |
| 资源占用 | ⭐⭐ | Java + Lucene 索引，建议 2GB+ RAM |
| 唯一优势 | 真正的独立搜索引擎 | 适合极度重视独立性、愿意牺牲搜索质量的场景 |

---

### 4. Meilisearch — 全文搜索引擎

| 项目 | 值 |
|------|-----|
| **GitHub Stars** | ~58,100 |
| **语言** | Rust |
| **许可证** | MIT |
| **活跃度** | 极高 |
| **Open Issues** | 295 |

#### 定位

Meilisearch 是**应用内全文搜索引擎**，不是 web 搜索引擎。它解决的是「给你一堆文档，让用户能搜索」的问题。

**核心特性**：
- 搜索速度：< 50ms
- 错别字容忍（Typo Tolerance）
- 混合搜索（全文 + 语义向量）
- 即输即搜（Search-as-you-type）
- 分面搜索、过滤、排序、地理位置搜索
- RESTful API + 多语言 SDK

#### 在 Web Search 场景的用法

Meilisearch 本身不爬网页。配合爬虫可以构建本地 web 索引：

```
爬虫 (Crawlee/Scrapy) → 提取网页内容 → 写入 Meilisearch → Agent 通过 API 搜索
```

但这意味着**你需要自己维护一个网页爬虫 + 索引更新流水线**，对 web search 场景来说成本太高。

#### 部署

```bash
# 单命令启动
docker run -p 7700:7700 getmeili/meilisearch:v1.17

# 或者直接下载二进制
curl -L https://install.meilisearch.com | sh
./meilisearch
```

#### API

```bash
# 搜索
curl 'http://localhost:7700/indexes/movies/search' \
  -H 'Authorization: Bearer masterKey' \
  -d '{"q": "interstellar", "limit": 5}'
```

#### 评估

| 维度 | 评分 | 说明 |
|------|------|------|
| 搜索质量 | ⭐⭐⭐⭐ | 全文+语义混合搜索，但需自己填充内容 |
| 部署复杂度 | ⭐⭐⭐⭐⭐ | 极简，单二进制 |
| API 友好度 | ⭐⭐⭐⭐⭐ | RESTful API 设计一流 |
| Agent 适配度 | ⭐⭐ | 适合做 RAG 的检索后端，不适合做 web search 后端 |
| Web Search 适用性 | ⭐ | 需要自己爬 + 自己建索引，不是开箱即用的 web search |

---

### 5. Typesense — 全文搜索引擎

| 项目 | 值 |
|------|-----|
| **GitHub Stars** | ~26,000 |
| **语言** | C++ |
| **许可证** | GPL-3.0 |
| **活跃度** | 极高 |
| **Open Issues** | 821 |

#### 定位

与 Meilisearch 类似，但**功能更丰富**：
- 全文搜索（< 50ms）
- 向量搜索 / 语义搜索（内置 S-BERT、E5、OpenAI 嵌入生成）
- **内置 RAG**（对话式搜索，直接返回基于索引数据的完整答案）
- **自然语言搜索**（LLM 意图识别，自然语言 → 结构化查询）
- **图像搜索**（CLIP 模型）
- **语音搜索**（Whisper 转录）
- 地理搜索、联合搜索、分组、JOIN、排序
- 基准：28M 图书索引 14GB RAM，46 QPS 并发

#### 部署

```bash
docker run -p 8108:8108 typesense/typesense:27.0 \
  --api-key=xyz --data-dir=/data
```

#### 评估

| 维度 | 评分 | 说明 |
|------|------|------|
| 搜索质量 | ⭐⭐⭐⭐ | 索引搜索质量极高，内置 AI 特性 |
| 部署复杂度 | ⭐⭐⭐⭐ | 单二进制，配置简单 |
| API 友好度 | ⭐⭐⭐⭐⭐ | RESTful API，文档优秀 |
| Agent 适配度 | ⭐⭐⭐ | 做 RAG 检索后端优秀，但做 web search 需自建爬虫 |
| Web Search 适用性 | ⭐ | 需要自建爬虫+索引流水线 |

---

### 6. ZincSearch

| 项目 | 值 |
|------|-----|
| **GitHub Stars** | ~17,800 |
| **语言** | Go |
| **许可证** | 未明确标注 |
| **活跃度** | 低（核心团队转向 OpenObserve） |

#### 定位

轻量级 Elasticsearch 替代品。项目本身已**半放弃**，核心团队转向了 [OpenObserve](https://github.com/openobserve/openobserve)（日志/可观测性平台）。

**不推荐新项目使用。**

---

### 7. Apache Solr + Nutch

| 项目 | Solr | Nutch |
|------|------|-------|
| **GitHub Stars** | ~1,600 | ~3,200 |
| **语言** | Java | Java |
| **许可证** | Apache-2.0 | Apache-2.0 |
| **定位** | 全文搜索引擎 | Web 爬虫 |

#### 经典架构：Solr + Nutch

这是**传统搜索引擎的经典组合**：

```
Nutch (爬虫) → Solr (索引) → 搜索 API
```

1. **Nutch** 爬取网页，基于 Hadoop/HBase 存储原始页面
2. **Solr** 基于 Lucene 建立全文索引
3. 搜索请求通过 Solr 的 REST API 返回结果

这是 Apache 基金会自己的搜索引擎技术栈，也是 Hadoop 生态的一部分。

#### 部署复杂度

- 需要 Java + Hadoop 环境
- Nutch 配置复杂（需要配置 `nutch-site.xml`、爬虫参数、URL 过滤规则）
- Solr 相对独立，但调优也需要深入理解 Lucene

#### 评估

| 维度 | 评分 | 说明 |
|------|------|------|
| 搜索质量 | ⭐⭐⭐⭐ | Lucene 索引质量极高，但需要足够规模的数据 |
| 部署复杂度 | ⭐ | 极重，Java + Hadoop 全家桶 |
| API 友好度 | ⭐⭐⭐ | Solr REST API 功能全但老旧 |
| Agent 适配度 | ⭐ | 太重，对 agent 场景过度设计 |
| Web Search 适用性 | ⭐⭐⭐⭐ | 真正的 web search 方案，但运营成本高 |

---

### 8. Elasticsearch

| 项目 | 值 |
|------|-----|
| **GitHub Stars** | ~77,000 |
| **语言** | Java |
| **许可证** | 曾为 Apache-2.0，2021 年改为 SSPL/Elastic License（非纯开源） |
| **Open Issues** | 5,843 |

#### 在 Web Search 场景

与 Solr + Nutch 类似，但没有官方的爬虫组件。第三方方案：
- **StormCrawler**（Java 爬虫，原生 ES 集成）
- **Crawlee**（Python/Node.js 爬虫，ES 可通过 API 写入）

#### 评估

| 维度 | 评分 | 说明 |
|------|------|------|
| 搜索质量 | ⭐⭐⭐⭐⭐ | 顶级全文搜索 |
| 部署复杂度 | ⭐⭐ | 较重，JVM 内存 + 集群管理 |
| API 友好度 | ⭐⭐⭐⭐ | RESTful JSON API |
| Agent 适配度 | ⭐⭐ | 太重，且许可证变化有风险 |
| Web Search 适用性 | ⭐⭐⭐ | 需配合爬虫，运营成本高 |

---

## AI Agent 场景对比表

| 方案 | 开箱即用 Web Search | 部署难度 | 资源需求 | API 友好度 | Agent 生态 | 独立性 | 推荐度 |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **SearXNG** | ✅ 即用 | ⭐ 极简 | 512MB | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 中等 | 🥇 **强烈推荐** |
| Whoogle | ✅ (已失效) | ⭐ 极简 | 256MB | ⭐⭐⭐ | ⭐ | 低 | ❌ 已停止维护 |
| YaCy | ✅ (P2P) | ⭐⭐⭐ | 2GB+ | ⭐⭐ | ⭐ | 极高 | 🥉 特定场景 |
| Meilisearch | ❌ 需爬虫 | ⭐ 极简 | 500MB | ⭐⭐⭐⭐⭐ | ⭐⭐ | 高 | RAG 后端 |
| Typesense | ❌ 需爬虫 | ⭐ 极简 | 1GB | ⭐⭐⭐⭐⭐ | ⭐⭐ | 高 | RAG 后端 |
| ZincSearch | ❌ 需爬虫 | ⭐⭐ | 低 | ⭐⭐⭐ | ⭐ | 高 | ❌ 已停滞 |
| Solr+Nutch | ✅ | ⭐⭐⭐⭐⭐ | 4GB+ | ⭐⭐⭐ | ⭐ | 极高 | ❌ 太重 |
| Elasticsearch | ❌ 需爬虫 | ⭐⭐⭐ | 2GB+ | ⭐⭐⭐⭐ | ⭐⭐ | 中 | ❌ 太重+许可证 |

---

## 推荐路径

### 🥇 首选：SearXNG

**如果你想要 AI agent 能搜索互联网，直接上 SearXNG。**

理由：
1. **5 分钟部署**（Docker Compose）
2. **原生 JSON API**，一行 HTTP 请求搞定
3. **237 个搜索引擎**，质量等同 Google/Bing
4. **Agent 生态最完善**（MCP Server、LangChain 集成、专用项目 5+）
5. **资源占用少**
6. **活跃维护**（2026 年仍在频繁更新）

`settings.yml` 关键配置建议：

```yaml
search:
  formats: [html, json]  # 启用 JSON API
  safe_search: 0

server:
  port: 8888
  bind_address: "0.0.0.0"      # 允许外部访问
  secret_key: "<生成随机密钥>"   # 安全
```

然后 agent 中：

```python
def search_web(query: str) -> list[dict]:
    r = requests.get(
        "http://localhost:8888/search",
        params={"q": query, "format": "json", "engines": "google,bing,duckduckgo"}
    )
    return [{"title": i["title"], "url": i["url"], "snippet": i["content"]} 
            for i in r.json()["results"]]
```

### 🥈 进阶：SearXNG + 内容采集

将 SearXNG 与 `trafilatura` 或 `readability` 结合，搜索结果自动抓取全文 Markdown：

```python
# 参考 searcharvester 项目
# SearXNG 搜索 → 获取 URL 列表 → trafilatura 抓取正文 → Markdown
```

这样可以给 agent 提供**搜索摘要 + 完整页面内容**，大幅提升回答质量。

### 🥉 完全独立路线（不依赖 Google）

如果必须摆脱对商业搜索引擎的依赖：

1. **YaCy** 独立模式提供基数索引
2. 用 `Crawlee` / `Scrapy` + **Meilisearch** 或 **Typesense** 对特定领域网站建立专项索引
3. 两者结合，YaCy 兜底宽泛搜索，专项索引提供高精度领域搜索

这是**自建 Google 的雏形**，但运营成本（爬虫维护、索引存储、反爬对抗）非常高。一般 AI agent 场景不需要走这条路。

---

## 总结

| 场景 | 推荐方案 |
|------|---------|
| 给 AI agent 加 web search 能力 | **SearXNG** |
| 已登录浏览器访问受限页面 | Chrome CDP（已有） |
| 文档/知识库全文检索（RAG） | **Meilisearch** 或 **Typesense** |
| 完全独立的搜索引擎 | YaCy（但搜索质量有限） |
| 企业级大规模 web 索引 | Solr+Nutch 或 Elasticsearch+Crawlee（运营成本高） |

**一句话：装个 SearXNG，你的 agent 就有了互联网搜索力。**

---

## 参考资源

- [SearXNG 官方文档](https://docs.searxng.org)
- [SearXNG GitHub](https://github.com/searxng/searxng)
- [searcharvester - SearXNG + trafilatura](https://github.com/vakovalskii/searcharvester)
- [MCP-searxng - MCP 协议服务器](https://github.com/SecretiveShell/MCP-searxng)
- [YaCy 官网](https://yacy.net)
- [Meilisearch 文档](https://www.meilisearch.com/docs)
- [Typesense 文档](https://typesense.org/docs/)
- [Apache Nutch](https://nutch.apache.org)
- [Apache Solr](https://solr.apache.org)
