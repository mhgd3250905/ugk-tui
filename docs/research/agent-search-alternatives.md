# AI Agent 替代性搜索协议与语义搜索方案调研

> 调研日期：2026-06-18  
> 目的：梳理 AI agent 除了调用传统搜索引擎（Google/Bing/DDG）之外，可利用的替代性信息获取协议与搜索方案

---

## 目录

1. [RSS / Atom Feed 生态](#1-rss--atom-feed-生态)
2. [Sitemap 协议](#2-sitemap-协议)
3. [WebSub 协议](#3-websub-协议)
4. [语义搜索方案 (Embedding + Vector DB)](#4-语义搜索方案-embedding--vector-db)
5. [GraphQL / API 直接查询](#5-graphql--api-直接查询)
6. [垂直搜索：GitHub Code Search / StackOverflow API 等](#6-垂直搜索github-code-search--stackoverflow-api-等)
7. [Agent Web Search 技术全景图](#7-agent-web-search-技术全景图)

---

## 1. RSS / Atom Feed 生态

### 1.1 原理

RSS（Really Simple Syndication / Rich Site Summary）和 Atom 是两种基于 XML 的内容聚合协议。网站发布者维护一个标准格式的 XML 文件，包含最近更新的文章标题、摘要、链接和时间戳。订阅者（agent）通过定期轮询该 XML 文件来感知内容更新。

**RSS 2.0 典型结构：**

```xml
<rss version="2.0">
  <channel>
    <title>Example Blog</title>
    <link>https://example.com</link>
    <description>Tech blog about AI</description>
    <item>
      <title>New LLM Breakthrough</title>
      <link>https://example.com/posts/llm-breakthrough</link>
      <pubDate>Wed, 18 Jun 2026 10:00:00 GMT</pubDate>
      <description><![CDATA[<p>Article content or summary...</p>]]></description>
      <guid>https://example.com/posts/llm-breakthrough</guid>
    </item>
  </channel>
</rss>
```

**Atom 1.0 典型结构：**

```xml
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Blog</title>
  <link href="https://example.com" />
  <entry>
    <title>New LLM Breakthrough</title>
    <link href="https://example.com/posts/llm-breakthrough" />
    <updated>2026-06-18T10:00:00Z</updated>
    <summary>Article content or summary...</summary>
    <id>urn:uuid:...</id>
  </entry>
</feed>
```

### 1.2 Agent 应用场景

| 场景 | 描述 |
|------|------|
| **内容监控** | Agent 定时轮询目标站点的 RSS feed，检测新文章，触发摘要/分类/告警 |
| **定向信息收集** | 针对特定领域（如安全公告 CVE、论文预印本 arXiv）订阅专门的 RSS 源 |
| **事件驱动工作流** | 检测到新内容 → 自动抓取全文 → LLM 摘要 → 存入知识库 / 推送到 Slack |
| **舆情/竞品监测** | 批量订阅竞争对手博客/新闻源，构建自动化的品牌/市场监控 |

### 1.3 技术栈（Node.js / Python）

**Node.js：**
- [`rss-parser`](https://www.npmjs.com/package/rss-parser) — 最流行的 RSS/Atom 解析库，支持 TypeScript
- [`feedparser`](https://www.npmjs.com/package/feedparser) — 流式解析，适合大 feed
- [`node-feedly`](https://www.npmjs.com/package/node-feedly) — Feedly API 封装

**Python：**
- [`feedparser`](https://pypi.org/project/feedparser/) — 最成熟的 Python feed 解析库
- [`atoma`](https://pypi.org/project/atoma/) — 纯 Python 的 Atom/RSS 解析器
- [`reader`](https://pypi.org/project/reader/) — 完整的 feed 阅读器库，支持增量更新

**Agent 集成示例（Node.js）：**

```typescript
import Parser from 'rss-parser';

async function monitorFeeds(urls: string[]) {
  const parser = new Parser();
  for (const url of urls) {
    const feed = await parser.parseURL(url);
    for (const item of feed.items) {
      // Agent 逻辑：检查是否已处理、摘要、分类、入库
      await processArticle({
        title: item.title,
        link: item.link,
        content: item.contentSnippet || item.content,
        pubDate: item.pubDate,
      });
    }
  }
}
```

### 1.4 RSSHub — 万物皆可 RSS

**[RSSHub](https://github.com/DIYgod/RSSHub)**（⭐ ~45k）是一个开源、可扩展的 RSS 聚合节点，能将几乎任何网站的内容转换为标准 RSS feed。

**核心价值：**
- 为没有原生 RSS 的网站（微博、知乎、Twitter/X、YouTube、B站等）生成 RSS
- 社区驱动的路由规则（routes），覆盖 1000+ 网站
- 支持自建实例或使用官方公共服务
- Agent 无需为每个网站编写爬虫，统一用 RSS 协议消费

**Agent 使用模式：**

```
Agent → RSSHub 实例 → 目标网站（无 RSS）
```

例如：
- `https://rsshub.app/zhihu/daily` → 知乎日报 RSS
- `https://rsshub.app/github/trending/daily` → GitHub Trending RSS
- `https://rsshub.app/bilibili/user/video/UID` → B站 UP 主视频 RSS

**部署方式：**
```bash
# Docker 一键部署
docker run -d --name rsshub -p 1200:1200 diygod/rsshub
```

### 1.5 与搜索引擎的互补

| | 搜索引擎 | RSS/Feed |
|---|---|---|
| **时效性** | 索引延迟（小时~天级） | 近乎实时（发布即推送） |
| **覆盖范围** | 全网 | 仅已订阅的源 |
| **噪声** | 需要关键词过滤 | 天然按源过滤，信噪比高 |
| **发现能力** | 强（发现未知内容） | 弱（只能看到已订阅源） |
| **Agent 友好度** | 需解析 HTML/调用 API | 结构化 XML，直接可用 |

**最佳实践：搜索引擎做发现（discovery），RSS 做持续监控（monitoring）。**

---

## 2. Sitemap 协议

### 2.1 原理

Sitemap 是网站向搜索引擎（以及 agent）告知其可抓取页面列表的 XML 协议。由 Google、Yahoo、Microsoft 于 2006 年联合推出，现已成为事实标准。

**两种形式：**

1. **Sitemap（单文件）：** 包含最多 50,000 个 URL
2. **Sitemap Index（索引文件）：** 指向多个 Sitemap 的入口文件，用于大型网站

**Sitemap 典型结构：**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page1</loc>
    <lastmod>2026-06-18</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://example.com/page2</loc>
    <lastmod>2026-06-15</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>
</urlset>
```

**Sitemap Index：**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap-posts.xml</loc>
    <lastmod>2026-06-18</lastmod>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemap-pages.xml</loc>
    <lastmod>2026-06-18</lastmod>
  </sitemap>
</sitemapindex>
```

**关键字段：**
- `<loc>` — 页面 URL（唯一必填字段）
- `<lastmod>` — 最后修改日期（agent 可用于增量更新）
- `<changefreq>` — 更新频率提示（always/hourly/daily/weekly/monthly/yearly/never）
- `<priority>` — 相对优先级（0.0~1.0，默认 0.5）

**发现方式：**
1. 约定位置：`https://example.com/sitemap.xml`
2. `robots.txt` 中的 `Sitemap:` 指令
3. 通过 `robots.txt` 加 `Sitemap:` 声明

### 2.2 Agent 应用场景

| 场景 | 描述 |
|------|------|
| **网站发现** | Agent 拿到一个域名后，先请求 `sitemap.xml` 获取完整的页面地图 |
| **定向抓取** | 结合 `<lastmod>` 只抓取有更新的页面，避免全站重爬 |
| **结构化爬取** | 按 `<priority>` 排序，优先抓取高价值页面 |
| **文档网站索引** | 对文档站（如 docs.example.com），sitemap 天然是内容目录 |
| **增量更新** | 定期对比 `<lastmod>`，只获取变更的页面 |

### 2.3 技术栈

**Node.js：**
- [`sitemapper`](https://www.npmjs.com/package/sitemapper) — Sitemap 解析器，支持 Sitemap Index
- [`simplecrawler`](https://www.npmjs.com/package/simplecrawler) — 内置 sitemap 发现功能

**Python：**
- [`ultimate-sitemap-parser`](https://pypi.org/project/ultimate-sitemap-parser/) — 递归解析 Sitemap Index
- [`advertools`](https://pypi.org/project/advertools/) — SEO 工具集，含 sitemap 解析

**Agent 集成示例（Node.js）：**

```typescript
import Sitemapper from 'sitemapper';

async function discoverSitePages(domain: string) {
  const sitemap = new Sitemapper({
    url: `https://${domain}/sitemap.xml`,
    timeout: 15000,
  });

  const { sites } = await sitemap.fetch();
  // sites 包含所有 URL，可按 lastmod 排序、过滤
  const recentSites = sites
    .filter(s => new Date(s.lastmod) > new Date(Date.now() - 7 * 86400000))
    .sort((a, b) => b.priority - a.priority);

  return recentSites;
}
```

### 2.4 局限性

- **覆盖率不完全**：不是所有网站都有 sitemap，或 sitemap 不包含所有页面
- **质量不一**：`<lastmod>` 和 `<priority>` 由网站自行维护，可能不准确
- **无内容语义**：sitemap 只有 URL 元数据，没有页面内容信息
- **需要配合爬虫**：sitemap 是"目录"，内容仍需抓取

### 2.5 与搜索引擎的互补

搜索引擎是"全网的 sitemap 消费者 + 排名系统"。Agent 使用 sitemap 是做 **定向发现**：已知感兴趣的域名，高效获取该域的所有入口点。搜索引擎反查（`site:example.com`）也能做到类似效果，但 sitemap 更结构化、不需要 API key。

---

## 3. WebSub 协议

### 3.1 原理

**WebSub**（原 PubSubHubbub，2018 年成为 W3C 推荐标准）是一种发布-订阅（pub/sub）协议，实现内容更新的实时推送。不同于 RSS 的"轮询"模式，WebSub 是"推送"模式：内容一旦发布，订阅者几乎实时收到通知。

**架构三角色：**

```
Publisher (发布者)          Hub (中转中心)          Subscriber (订阅者)
     |                          |                        |
     |-- 发布新内容 ----------->|                        |
     |                          |-- 推送更新 ----------->|
     |                          |                        |
```

**工作流程：**

1. **发现 Hub：** Publisher 在其 RSS/Atom feed 的 HTTP 响应头或 feed 内部声明 Hub 地址
   ```
   Link: <https://pubsubhubbub.appspot.com/>; rel="hub"
   ```
2. **订阅：** Subscriber 向 Hub 发送 POST 请求，声明要订阅的 feed URL 和回调 URL
   ```
   POST / HTTP/1.1
   Host: hub.example.com
   
   hub.mode=subscribe
   hub.topic=https://blog.example.com/feed.xml
   hub.callback=https://agent.example.com/callback
   ```
3. **验证：** Hub 向 callback URL 发送 GET 请求确认订阅意图
4. **推送：** Publisher 发布新内容后通知 Hub（ping），Hub 拉取 feed 并将新条目 POST 到所有 subscriber 的 callback URL
5. **退订：** 发送 `hub.mode=unsubscribe` 即可

**RSS feed 中声明 Hub（Atom 格式）：**

```xml
<feed xmlns="http://www.w3.org/2005/Atom">
  <link rel="hub" href="https://pubsubhubbub.appspot.com/" />
  <link rel="self" href="https://blog.example.com/feed.xml" />
  ...
</feed>
```

### 3.2 采用现状

| 平台 | 支持情况 |
|------|----------|
| **WordPress** | 原生支持，`rel="hub"` 自动输出 |
| **Blogger** | Google 托管，原生支持 |
| **Medium** | 通过 Superfeedr 支持 |
| **YouTube** | 使用 WebSub 推送视频更新通知 |
| **Mastodon / ActivityPub** | 核心基础设施（OStatus 套件的一部分） |
| **W3C** | 自身博客使用 WebSub |
| **Google PubSubHubbub Hub** | 公开 Hub，2021 年已弃用（shutdown） |

**关键变化：** Google 在 2021 年关闭了其公开 Hub（`pubsubhubbub.appspot.com`），但协议本身仍被 W3C 维护，WordPress 等平台继续支持。社区 Hub 如 [Switchboard](https://switchboard.p3k.io/) 替代了 Google Hub。

### 3.3 Agent 使用先例

- **IFTTT / Zapier** — 通过 WebSub 触发 workflow（如"博客更新时发推"）
- **Superfeedr**（被 Medium 收购）— 提供 WebSub 到 Webhook 的桥接服务
- **Bridgy Fed** — 使用 WebSub 桥接不同社交网络
- **IndieWeb 生态** — 大量个人站点通过 WebSub 实现实时评论/Webmention

### 3.4 Agent 适用场景

| 场景 | 描述 |
|------|------|
| **实时内容触发** | 关键信息源更新时秒级触发 agent workflow，而非轮询 |
| **减少资源浪费** | 对于低频更新的源，无需定时轮询 |
| **事件驱动架构** | 把 WebSub webhook 直接作为 agent 任务队列的入口 |

### 3.5 挑战与局限

- **Hub 生态萎缩**：Google Hub 关闭后，缺乏大型公共 Hub
- **运维复杂**：Agent 需要暴露公网 HTTP endpoint（callback URL）
- **隐私问题**：Hub 知道所有订阅关系
- **RSS 已足够覆盖大部分场景**：对于 AI agent，5 分钟轮询 RSS 的成本远低于维护 WebSub 基础设施

### 3.6 与搜索引擎的互补

WebSub 和搜索引擎解决的是 **完全正交** 的问题：前者做实时推送通知，后者做全量索引和排名。Agent 可以用 WebSub 作为"触发器"——收到推送后，再调用搜索或爬虫做深度分析。

---

## 4. 语义搜索方案 (Embedding + Vector DB)

### 4.1 原理

语义搜索的核心思想是：将文本映射到高维向量空间（embedding），语义相近的文本向量距离近，从而实现"按意思搜索"而非"按关键词匹配"。

**完整流程：**

```
┌──────────┐    ┌──────────────┐    ┌───────────┐    ┌─────────────┐
│ 爬取网页  │ -> │ 文本分割      │ -> │ 生成      │ -> │ 存入向量     │
│          │    │ (chunking)   │    │ Embedding │    │ 数据库       │
└──────────┘    └──────────────┘    └───────────┘    └─────────────┘
                                                           │
                    ┌──────────────┐                       │
  用户查询 --------->│ 生成查询向量  │-----------------------┘
                    └──────────────┘    相似度检索 (ANN/KNN)
                                              │
                                        ┌─────▼─────┐
                                        │ Top-K 结果  │ -> LLM 重排序/摘要
                                        └───────────┘
```

### 4.2 技术栈详解

#### 4.2.1 Embedding 模型

| 模型/API | 维度 | 特点 | 成本 |
|----------|------|------|------|
| **OpenAI text-embedding-3-small** | 1536 | 性价比高，多语言好 | $0.02/1M tokens |
| **OpenAI text-embedding-3-large** | 3072 | 精度最高 | $0.13/1M tokens |
| **Cohere Embed v3** | 1024 | 支持多语言、压缩表示 | 免费额度 100K/月 |
| **BGE (BAAI)** | 768/1024 | 中文最强开源模型 | 本地运行免费 |
| **Jina Embeddings v3** | 1024 | 支持 89 种语言，开源 | 自部署免费 |
| **sentence-transformers** | 384-768 | 轻量级，适合本地 | 免费 |

#### 4.2.2 向量数据库

| 数据库 | 类型 | 特点 | 适用场景 |
|--------|------|------|----------|
| **Pinecone** | 云托管 | 零运维，但闭源、贵 | 生产级快速上线 |
| **Weaviate** | 开源/云 | 内置 hybrid search + GraphQL | 中等规模，功能丰富 |
| **Qdrant** | 开源/云 | Rust 实现，高性能，过滤器强大 | 性能敏感场景 |
| **Milvus** | 开源 | 分布式，PB 级支持 | 大规模企业部署 |
| **Chroma** | 开源 | 极简 API，本地优先，Python 原生 | 原型开发 / 小规模 |
| **pgvector** | PostgreSQL 扩展 | 和业务数据共存，SQL 查询 | 已有 PG 基础设施 |
| **LanceDB** | 嵌入式 | 无服务器，基于 Lance 格式 | 边缘 / 本地 agent |

#### 4.2.3 文本分割策略

```
原网页内容
    │
    ├── 按段落分割 (paragraph split)
    ├── 按固定 token 数 (如 512 tokens)
    ├── 递归字符分割 (RecursiveCharacterTextSplitter) ← LangChain 默认
    ├── 语义分割 (按 embedding 相似度变化切分)
    └── 重叠窗口 (overlap = 50-200 tokens)
```

### 4.3 混合搜索（Hybrid Search）

**纯语义搜索的问题：**
- 对精确关键词/实体名不敏感（如搜索 "CVE-2024-1234"）
- 对缩写/代码片段匹配不准

**混合搜索 = 语义搜索 + 关键词搜索：**

```
查询 → ┌─ 语义搜索 (向量相似度) ──┐
       │                          ├── 融合排序 → 最终结果
       └─ 关键词搜索 (BM25/TF-IDF)┘
```

Weaviate、Pinecone 等原生支持 hybrid search；其他数据库可用 [RRF (Reciprocal Rank Fusion)](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) 在应用层融合。

### 4.4 开源实现

**LangChain 一站式方案：**

```python
from langchain_community.document_loaders import WebBaseLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_openai import OpenAIEmbeddings
from langchain_community.vectorstores import Chroma

# 1. 爬取网页
loader = WebBaseLoader(["https://example.com/page1", "https://example.com/page2"])
docs = loader.load()

# 2. 文本分割
splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
chunks = splitter.split_documents(docs)

# 3. 生成 embedding + 存入向量库
vectorstore = Chroma.from_documents(
    documents=chunks,
    embedding=OpenAIEmbeddings(model="text-embedding-3-small"),
    persist_directory="./chroma_db"
)

# 4. 语义搜索
results = vectorstore.similarity_search("什么是 RAG？", k=5)

# 5. 混合搜索 (Chroma 不原生支持，需手动 BM25 + 融合)
```

**LlamaIndex 方案（更适合 RAG agent）：**

```python
from llama_index.core import VectorStoreIndex, SimpleDirectoryReader
from llama_index.core.node_parser import SentenceSplitter

documents = SimpleDirectoryReader("./web_content").load_data()
index = VectorStoreIndex.from_documents(
    documents,
    transformations=[SentenceSplitter(chunk_size=1024)]
)
query_engine = index.as_query_engine(similarity_top_k=5)
response = query_engine.query("How does RAG work?")
```

### 4.5 Agent 集成模式

**模式一：私有知识库搜索**

```
Agent 爬取目标网站 → 建索引 → 后续查询走语义搜索 → 不依赖外部搜索引擎
```

适用：合规/法律/内部文档等敏感场景，或需要对搜索结果有完全控制权的场景。

**模式二：搜索增强 RAG**

```
用户查询 → 调搜索引擎 API 获取原始结果 → 抓取 Top-N 页面全文 → 
分割 + embedding → 在抓取内容上做语义搜索 → 用 LLM 生成回答
```

**模式三：长期记忆**

```
Agent 对话历史 / 之前的搜索结果 → embedding → 存入向量库 → 
后续任务可"回忆"历史信息
```

### 4.6 局限性

| 挑战 | 描述 | 缓解方案 |
|------|------|----------|
| **Embedding 成本** | 大规模网页索引的 API 调用成本高 | 开源模型本地推理；增量索引 |
| **索引更新延迟** | 网页更新后，向量库可能是过时的 | 增量索引 + 时效性权重衰减 |
| **存储成本** | 向量维度 × 文档量可能很大 | 量化（PQ、Scalar）；分层存储（热/冷） |
| **Chunking 质量** | 不当的切分导致上下文断裂 | 重叠窗口 + 邻 chunk 扩展检索 |
| **冷启动** | 新领域无索引可用 | 搜索引擎做 bootstrapping |
| **长尾查询** | VERY specific 查询语义搜索也不准 | Hybrid search + LLM 重写查询 |

---

## 5. GraphQL / API 直接查询

### 5.1 原理

部分网站/平台提供 **GraphQL 或 REST API** 作为结构化数据访问入口。Agent 可以直接使用这些 API 获取信息，比解析 HTML 或调搜索引擎更精确、更高效。

GraphQL 的核心优势：**按需取数据**，一个请求获取多个资源的精确字段，避免 over-fetching / under-fetching。

### 5.2 对 Agent 有高价值的 API 端点

| 平台 | API 类型 | 端点 | 典型用途 |
|------|----------|------|----------|
| **GitHub** | GraphQL | `https://api.github.com/graphql` | 搜索代码/仓库/issue/PR、获取 star 趋势 |
| **GitHub** | REST | `https://api.github.com/search/code?q=...` | 代码搜索（REST 接口也强大） |
| **Reddit** | REST/JSON | `https://www.reddit.com/r/{subreddit}/search.json?q=...` | 搜索帖子/评论 |
| **Stack Exchange** | REST | `https://api.stackexchange.com/2.3/search?site=stackoverflow&q=...` | 搜索问答、获取答案 |
| **Wikipedia** | REST | `https://en.wikipedia.org/w/api.php` | 全文搜索、页面摘要 |
| **arXiv** | REST | `https://export.arxiv.org/api/query?search_query=...` | 论文搜索 |
| **Hacker News** | Firebase REST | `https://hacker-news.firebaseio.com/v0/` | 热门帖子/评论 |
| **Dev.to** | REST | `https://dev.to/api/articles?tag=...` | 技术文章搜索 |
| **Product Hunt** | GraphQL | `https://api.producthunt.com/v2/api/graphql` | 产品/发布搜索 |
| **Notion** | REST | `https://api.notion.com/v1/search` | 搜索工作区 |
| **Slack** | Web API | `https://slack.com/api/search.messages` | 搜索消息历史 |

### 5.3 GitHub GraphQL 示例

```graphql
query {
  search(query: "lang:typescript AI agent framework stars:>100", type: REPOSITORY, first: 10) {
    repositoryCount
    edges {
      node {
        ... on Repository {
          nameWithOwner
          description
          stargazerCount
          primaryLanguage { name }
          updatedAt
        }
      }
    }
  }
}
```

一个 query 拿到：搜索结果数量、仓库名、描述、star 数、语言、更新时间——全是结构化字段，无需 HTML 解析。

### 5.4 Agent 集成模式

```
用户："帮我找最近一周 GitHub 上关于 RAG 的热门 TypeScript 项目"

Agent 解析意图：
1. 查询 GitHub GraphQL: search(query:"rag lang:typescript", sort:stars, since:1w)
2. 获取 Top-5 项目详情（README、最近 commits）
3. LLM 综合：项目对比、推荐

无需搜索引擎介入。
```

### 5.5 优势与局限

**优势：**
- 结构化数据，零 HTML 解析
- 精确过滤（语言、日期范围、star 数等）
- 不依赖搜索引擎索引延迟
- 通常有速率限制但可预测

**局限：**
- 只有提供了 API 的平台才能使用
- 需要 API key / OAuth 授权
- 速率限制（如 GitHub 5000 req/h）
- 平台 API 字段可能不如搜索引擎结果丰富（如缺少页面全文）

---

## 6. 垂直搜索：GitHub Code Search / StackOverflow API 等

### 6.1 为什么开发者 Agent 需要垂直搜索

通用搜索引擎（Google/Bing）在开发场景下的痛点：

| 痛点 | 垂直搜索如何解决 |
|------|-----------------|
| 搜索结果混入大量非技术内容 | 只在技术平台内搜索 |
| 代码片段被 HTML 污染 | 原生语法高亮、结构化返回 |
| 时效性筛选不精确 | 按 commit 时间 / answer 更新时间过滤 |
| 无法按语言/license/stars 过滤 | 平台内置精确过滤 |
| 缺少上下文（issue 讨论、PR review） | 平台 API 返回关联实体 |

### 6.2 关键垂直搜索平台

#### 6.2.1 GitHub Code Search

**能力：**
- 搜索代码片段（全 GitHub 公开仓库）
- 正则表达式搜索
- 按语言、路径、仓库过滤
- 搜索结果包含匹配行上下文

**Agent 使用方式：**

```bash
# REST API
GET https://api.github.com/search/code?q=QdrantClient+language:python+path:/

# 或用 Octokit (Node.js)
const { data } = await octokit.rest.search.code({
  q: 'QdrantClient language:python',
  per_page: 10
});
```

**典型场景：** "找所有用了 Pinecone 的 TypeScript 项目"、"看看别人怎么实现 WebSub subscriber 的"

#### 6.2.2 Stack Exchange API (StackOverflow)

**能力：**
- 搜索问题/答案/评论
- 按标签、评分、日期过滤
- 获取完整答案 Markdown（含代码块）
- 无 API key 时 300 req/day，有 key 时 10000 req/day

**Agent 使用示例：**

```bash
GET https://api.stackexchange.com/2.3/search/advanced?
  site=stackoverflow&
  q=vector+database+performance&
  tagged=python&
  answers=1&
  sort=votes&
  filter=withbody
```

返回每个问题的标题、答案正文（Markdown）、投票数、标签——直接喂给 LLM 无需清洗。

#### 6.2.3 其他高价值垂直搜索

| 平台 | 搜索对象 | 接口 | Agent 场景 |
|------|----------|------|-----------|
| **NPM Registry** | npm 包 | `https://registry.npmjs.org/-/v1/search?text=...` | 找库/比较 |
| **PyPI** | Python 包 | `https://pypi.org/simple/` + JSON API | 找库/安全审计 |
| **Docker Hub** | 镜像 | `https://hub.docker.com/v2/search?q=...` | 找基础镜像/工具 |
| **arXiv** | 论文 | `https://export.arxiv.org/api/query?search_query=...` | 文献调研 |
| **Semantic Scholar** | 论文(带引用图) | `https://api.semanticscholar.org/graph/v1/paper/search?query=...` | 引文分析 |
| **CVE (NVD)** | 漏洞 | `https://services.nvd.nist.gov/rest/json/cves/2.0` | 安全情报 |
| **Shodan** | 联网设备 | REST API (需付费) | 资产发现/安全 |
| **Wayback Machine** | 历史网页 | `https://archive.org/wayback/available?url=...` | 历史版本回溯 |
| **Google Programmable Search** | 自定义搜索 | REST API | 聚焦特定站点集合 |

### 6.3 垂直搜索的多路复用（Federated Search）

Agent 的一种高级模式：**同时查询多个垂直源，合并去重排序。**

```
用户查询："Python 异步 HTTP 客户端哪个最好？"

Agent 并行请求：
├── StackOverflow API → 最热问题 + 答案
├── GitHub Code Search → 真实项目中的 aiohttp/httpx 使用频率
├── PyPI → 下载量/最近更新
├── Hacker News API → 相关讨论热度
└── Google Search API (fallback) → 博客/评测文章

融合策略：LLM 综合所有来源，给出去重后的推荐
```

---

## 7. Agent Web Search 技术全景图

### 7.1 方案矩阵

```
                    实时性 →
                   低                          高
        ┌──────────────────────┬──────────────────────┐
  广    │  传统搜索引擎          │  (空白)               │
  度    │  Google/Bing/DDG     │                      │
  ↓     │  全量索引 + PageRank  │                      │
        ├──────────────────────┼──────────────────────┤
        │  Sitemap + 爬虫       │  RSS/Atom Feed       │
        │  定向发现 + 深度抓取   │  订阅监控 + 增量更新   │
  定    │                      │                      │
  向    │  语义搜索             │  WebSub              │
  性    │  Embedding + VectorDB │  实时推送             │
  ↓     │  按意思搜索           │                      │
        ├──────────────────────┼──────────────────────┤
        │  GraphQL / REST API  │  Webhook / WebSub    │
  精    │  结构化查询           │  callback            │
  确    │  (GitHub, SO, etc)   │                      │
  度    │                      │                      │
        └──────────────────────┴──────────────────────┘
```

### 7.2 分层架构建议

```
┌─────────────────────────────────────────────────────────┐
│                    Agent 查询层                          │
│   "帮我了解最新的 RAG 技术进展"                            │
└────────────────────────┬────────────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │    查询路由器        │  ← LLM 判断该走哪条路径
              │  (Query Router)     │
              └──┬──────┬──────┬────┘
                 │      │      │
    ┌────────────▼┐ ┌───▼───┐ ┌▼─────────────┐
    │ 搜索引擎     │ │ 垂直  │ │ 语义搜索      │
    │ (Google/Bing)│ │ API   │ │ (Vector DB)   │
    │ 广度优先     │ │ 深度  │ │ 按意思搜      │
    └──────┬───────┘ └───┬───┘ └──┬───────────┘
           │             │        │
           └─────────────┼────────┘
                         │
              ┌──────────▼──────────┐
              │   结果融合 & 去重     │
              │  (Fusion + Rerank)  │
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │  RSS Feed / WebSub  │  ← 异步监控层
              │  持续监控 + 触发     │     (独立运行)
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │    Agent 最终输出    │
              └─────────────────────┘
```

### 7.3 各方案综合对比

| 方案 | 实时性 | 覆盖面 | 结构化 | 成本 | Agent 集成难度 |
|------|--------|--------|--------|------|---------------|
| **传统搜索引擎 API** | 中 | ⭐⭐⭐⭐⭐ | 低 | 低~中 | ⭐ 简单 |
| **RSS/Atom Feed** | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ | 极低 | ⭐⭐ 简单 |
| **RSSHub** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | 低 | ⭐⭐ 简单 |
| **Sitemap + 爬虫** | ⭐⭐⭐ | ⭐⭐⭐ (单站) | ⭐⭐ | 中 | ⭐⭐⭐ 中等 |
| **WebSub** | ⭐⭐⭐⭐⭐ | ⭐ | ⭐⭐⭐ | 中 | ⭐⭐⭐⭐ 复杂 |
| **语义搜索 (Vector DB)** | ⭐⭐ | ⭐⭐ (已索引) | ⭐⭐⭐⭐ | 高 | ⭐⭐⭐⭐ 复杂 |
| **GraphQL/API 直查** | ⭐⭐⭐⭐ | ⭐⭐ (特定平台) | ⭐⭐⭐⭐⭐ | 低~中 | ⭐⭐ 简单 |
| **垂直搜索 (GitHub/SO)** | ⭐⭐⭐⭐ | ⭐⭐⭐ (技术圈) | ⭐⭐⭐⭐⭐ | 低 | ⭐⭐ 简单 |

### 7.4 推荐 Agent 搜索策略

```
第一层（免费、快速、结构化）：
  → 垂直 API（GitHub / StackOverflow / PyPI）
  → RSS feed（已订阅源的最新内容）

第二层（需要覆盖未知信息）：
  → 传统搜索引擎 API（Google Programmable Search / Bing）
  → RSSHub（发现新源）

第三层（深度/私有信息）：
  → Sitemap + 爬虫（定向深度抓取）
  → 语义搜索（自建向量索引）

第四层（实时触发）：
  → WebSub（对高价值实时源）
```

### 7.5 ugk-core 落地路径建议

基于当前 ugk-core 的技术栈（Node.js / TypeScript、Git Bash 环境），推荐优先落地：

1. **RSS Feed 监控** — 集成 `rss-parser`，构建 `rss-monitor` 扩展工具
   - 低风险、高价值
   - 配合 cron 定时任务天然契合

2. **RSSHub 集成** — 在 cron 任务中通过 RSSHub 实例获取原本无 RSS 的平台内容

3. **GitHub Code Search / SO API** — 开发者 agent 垂直搜索扩展
   - 当前 `search-github-code` / `search-stackoverflow` 作为自定义工具

4. **Sitemap 发现工具** — 让 agent 拿到 URL 后能快速摸清网站结构

5. **语义搜索（远期）** — 需评估 embedding API 成本，可先用 Chroma 本地做 prototype

---

## 附录：核心参考资源

- [RSS 2.0 规范](https://www.rssboard.org/rss-specification)
- [Atom 1.0 (RFC 4287)](https://datatracker.ietf.org/doc/html/rfc4287)
- [RSSHub 项目](https://github.com/DIYgod/RSSHub)
- [Sitemap 协议](https://www.sitemaps.org/protocol.html)
- [WebSub W3C 推荐标准](https://www.w3.org/TR/websub/)
- [LangChain Document Loaders](https://python.langchain.com/docs/integrations/document_loaders)
- [Chroma DB](https://www.trychroma.com/)
- [GitHub GraphQL API](https://docs.github.com/en/graphql)
- [Stack Exchange API](https://api.stackexchange.com/docs)
- [RRF 融合算法](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
