# Web 爬虫框架与通用爬取数据集调研报告

> 调研目标：AI agent 如何通过爬虫框架自己抓取互联网内容并建立索引，以及已有的通用网页数据集。
> 日期：2026-06-18

---

## 一、主流爬虫框架对比

### 1.1 框架总览表

| 框架 | 语言 | Stars | 分布式能力 | JS 渲染 | 与搜索引擎集成难度 | 适用场景 |
|------|------|-------|-----------|---------|-------------------|---------|
| **Scrapy** | Python | ~54k | 有限（需 Scrapyd/Scrapy-Redis 扩展） | 需 Splash/Playwright 插件 | ⭐⭐（轻量级，强在数据抓取） | 中型项目、数据挖掘、API 数据源 |
| **Crawlee** | TypeScript | ~22k | 有限（Apify 平台支持云端扩展） | ✅ 原生 Playwright/Puppeteer | ⭐⭐（agent 友好，JS 生态） | agent 场景、JS 渲染页面、动态网站 |
| **Apache Nutch** | Java | ~1.3k fork | ✅ 原生 Hadoop 集成 | ❌ 无（仅 HTTP） | ⭐⭐⭐（天然为搜索而生） | 大数据全量爬取、搜索引擎后端 |
| **StormCrawler** | Java | ~980 star | ✅ 原生 Apache Storm | ❌ 无（仅 HTTP） | ⭐⭐⭐（低延迟流式处理） | 实时增量爬取、新闻监控 |
| **Colly** | Go | ~25.3k | 有限（内置分布式模式） | ❌ 无（仅 HTTP） | ⭐（易集成数据库/ES） | 轻量抓取、API 聚合、Go 生态项目 |

### 1.2 各框架详细分析

#### Scrapy (Python)

**架构：**
```
Spider → Scheduler → Downloader (经过 Downloader Middleware) → Spider (解析)
                                            ↑
                                   Item Pipeline → 数据库/文件
```

**核心特点：**
- **Spider**: 定义爬取逻辑和解析规则的核心类
- **Engine**: 协调 Spider、Scheduler、Downloader 之间的数据流
- **Scheduler**: 基于优先级的请求队列，支持去重
- **Downloader Middleware**: 可插拔的中间件体系，可用于：
  - User-Agent 轮换
  - IP 代理切换
  - Cookie 管理
  - 请求重试/重定向
  - 自定义 HTTP 头
- **Item Pipeline**: 数据清洗、验证、持久化（DB/JSON/CSV/S3）
- **AutoThrottle**: 内置自适应限速，自动调整请求延迟

**与搜索引擎集成模式：**
```python
# 典型的"爬取 → 入库 → Elasticsearch"模式
import scrapy
from elasticsearch import Elasticsearch

class SiteSpider(scrapy.Spider):
    name = "site_indexer"
    
    def parse(self, response):
        item = {
            'url': response.url,
            'title': response.css('title::text').get(),
            'content': response.css('body').get(),
            'timestamp': ...
        }
        # 直接写入 ES 索引
        es.index(index='web_index', body=item)
```

**Scrapy-Redis 分布式：**
- 使用 Redis 作为共享队列和去重过滤器
- 多个 Scrapy 实例可从同一 Redis 消费 URL
- 适合需要横向扩展的中型爬取任务

**局限：**
- 不原生支持 JS 渲染（需搭配 Splash 或 scrapy-playwright）
- 分布式能力依赖第三方扩展
- 对 agent 场景（需要动态决策下一步）不够灵活

---

#### Crawlee (Node.js/TypeScript)

**为什么最适合 agent 场景：**

Crawlee 由 Apify 开发，设计理念就是让爬虫更"智能"。其核心设计非常适合 AI agent 使用：

```
Agent 决策层
    ↓
Crawlee 执行层 (CheerioCrawler / PlaywrightCrawler / PuppeteerCrawler)
    ↓
RequestQueue (智能队列) + SessionPool (会话管理) + ProxyConfiguration (代理管理)
    ↓
Dataset (结果存储) + KeyValueStore (持久化状态)
```

**关键能力：**

1. **三种爬虫模式自由切换：**
   - `CheerioCrawler`：纯 HTTP + Cheerio 解析（最快，适合静态页面）
   - `PlaywrightCrawler`：Chromium/Firefox/WebKit 全浏览器支持
   - `PuppeteerCrawler`：Chromium 无头浏览器

2. **内置 RequestQueue 智能调度：**
   - 自动去重（基于 URL）
   - 优先级队列（可设置 priority）
   - `enqueueLinks()` 支持 CSS Selector 过滤
   - Label 标签机制，方便 agent 做条件分发

3. **代理管理（ProxyConfiguration）：**
   - 静态代理列表（轮询）
   - 自定义代理函数（按 URL/域名动态选代理）
   - **Tiered 代理（分层代理）**：自动检测是否被封，逐级升级代理质量
     ```
     Tier 0: 无代理 → Tier 1: 普通代理 → Tier 2: 优质代理 → Tier 3: 高价住宅代理
     ```
   - 自动探活：定期检测低层代理是否恢复

4. **SessionPool 会话管理：**
   - 每个 session 对应一个"虚拟用户"
   - 独立的 Cookie、浏览器指纹、代理 IP
   - 被封时自动创建新 session
   - 模仿真实用户行为

5. **浏览器指纹（Fingerprint）：**
   - 默认启用，零配置
   - 可定制操作系统、浏览器版本、locale
   - 支持 Camoufox（Firefox 魔改版，应对 Cloudflare）

6. **存储系统：**
   - `Dataset`：JSON 格式结果集（`./storage/datasets/default/*.json`）
   - `KeyValueStore`：键值存储（适合保存爬取状态）
   - `RequestQueue`：URL 队列持久化

**agent 集成示例（伪代码）：**

```typescript
import { PlaywrightCrawler, Dataset, ProxyConfiguration } from 'crawlee';

// agent 可以动态控制爬取策略
const crawler = new PlaywrightCrawler({
    proxyConfiguration: new ProxyConfiguration({
        tieredProxyUrls: [
            [null],
            ['http://proxy-tier1.com'],
            ['http://proxy-tier2.com'],
        ],
    }),
    
    async requestHandler({ request, page, enqueueLinks, log }) {
        const url = request.url;
        const title = await page.title();
        const content = await page.content();
        
        // agent 可在此注入自己的决策逻辑
        const relevance = await aiAgent.evaluateRelevance(title, url);
        
        if (relevance.score > 0.7) {
            await Dataset.pushData({
                url, title,
                text: await page.evaluate(() => document.body.innerText),
                timestamp: Date.now(),
            });
            
            // 高相关页面：深入爬取
            await enqueueLinks({
                selector: 'a[href]',
                transformRequestFunction: (req) => {
                    req.userData = { depth: (request.userData.depth || 0) + 1 };
                    return req;
                },
            });
        }
    },
});
```

---

#### Apache Nutch (Java)

**定位：** 为搜索引擎而生的全量爬虫

**架构：**
```
Injector → Generator → Fetcher → ParseSegment → UpdateDB → Indexer
                    ↕                         ↓
              CrawlDB (元数据库)         Solr/Elasticsearch
```

**核心组件：**

| 组件 | 职责 |
|------|------|
| **Injector** | 将种子 URL 注入 CrawlDB |
| **Generator** | 按域名/优先级从 CrawlDB 生成待抓取批次 |
| **Fetcher** | HTTP 下载 + robots.txt 遵守 + 速率限制 |
| **Parser** (Tika) | 解析 HTML/PDF/Word 等格式 |
| **UpdateDB** | 更新 CrawlDB（新 URL、状态、元数据） |
| **Indexer** | 将解析结果写入 Solr/ES |

**插件体系：**
- 基于 plugin 目录的动态加载
- 内置 100+ 插件：评分（OPIC）、URL 标准化、语言检测
- 可轻松扩展：自定义 ParseFilter、IndexingFilter、URLFilter

**分布式能力：**
- 原生 Hadoop 集成（MapReduce 模式执行爬取步骤）
- HDFS 存储 CrawlDB
- 适合十亿级页面爬取

**agent 适用性：**
- ⚠️ 较重，部署复杂（需要 Hadoop/HBase 集群）
- 适合大规模离线索引构建，不适合 agent 实时按需爬取
- 无 JS 渲染能力

---

#### StormCrawler (Java)

**定位：** 基于 Apache Storm 的低延迟流式爬虫

**核心特点：**
- **流式处理模型**：Spout（URL 发射）→ Bolt（抓取/解析/索引）
- **低延迟**：URL 从发现到索引数秒以内
- **与 Elasticsearch/Kibana 深度集成**：开箱即用的可视化监控
- **支持 WARC 导出**：可对接 CommonCrawl 生态

**典型拓扑：**
```
URL Spout (Kafka/Redis) 
    → Fetcher Bolt (HTTP 下载)
    → Parser Bolt (HTML 解析) 
    → Indexer Bolt (Elasticsearch)
    → Status Updater Bolt (更新状态)
```

**适用场景：**
- 新闻实时抓取与索引
- 增量爬取（只爬更新的页面）
- 需要实时可见性的数据采集

**agent 适用性：**
- Java 技术栈较重
- 适合作为 agent 后端的长期采集管道

---

#### Colly (Go)

**定位：** 轻量级高性能爬虫框架

**核心能力：**
- 单核 >1k request/sec
- 内置 robots.txt 支持
- 自动 Cookie/Session 处理
- 同步/异步/并行三种模式
- 分布式爬取（通过 Redis/HTTP 后端）
- 缓存机制
- 自动编码检测（非 Unicode 响应）

**代码示例：**
```go
c := colly.NewCollector(
    colly.AllowedDomains("example.com"),
    colly.MaxDepth(2),
)

c.OnHTML("a[href]", func(e *colly.HTMLElement) {
    e.Request.Visit(e.Attr("href"))
})

c.OnResponse(func(r *colly.Response) {
    // 保存到数据库
})

c.Visit("https://example.com/")
```

**agent 适用性：**
- 最适合需要高性能的 Go 项目
- agent 若用 Go 写，Colly 是首选
- 分布式能力有限（需自行扩展）

---

## 二、CommonCrawl 数据集

### 2.1 规模与覆盖

| 指标 | 数值 |
|------|------|
| 成立时间 | 2007 年（2011 年开始发布 crawls） |
| 网页总量 | **数十亿**（2023 年单次 crawl 达 31 亿页面） |
| 存储格式 | WARC / WAT / WET |
| 存储位置 | AWS S3 `us-east-1` (s3://commoncrawl/) |
| 更新频率 | 约每月一次新 crawl |
| 学术引用 | 10,000+ 篇论文 |
| AI 训练数据 | GPT / Gemini / Claude 等均使用 |
| 资助方 | Anthropic、OpenAI（各 $250K）、Elbaz Family Foundation |

### 2.2 三种数据格式

| 格式 | 全称 | 内容 | 典型用途 |
|------|------|------|---------|
| **WARC** | Web ARChive | 完整 HTTP 请求/响应（含 Header、HTML、CSS、JS） | 原始存档、完全回放 |
| **WAT** | Web Archive Transformation | JSON 元数据（链接、标题、HTTP 头） | 链接图分析、页面元数据提取 |
| **WET** | WARC Encapsulated Text | 纯文本（剥离 HTML 标签后） | NLP 训练、全文搜索索引 |

### 2.3 访问方式

#### 方式一：HTTP 直接下载（无需 AWS 账号）
```bash
# 列出某次 crawl 的 WARC 文件
curl -s "https://data.commoncrawl.org/crawl-data/CC-MAIN-2026-21/warc.paths.gz" | zcat

# 下载单个 WARC 文件（约 1GB/个）
wget https://data.commoncrawl.org/crawl-data/CC-MAIN-2026-21/segments/.../warc/...warc.gz
```

#### 方式二：AWS CLI（匿名访问）
```bash
# 列出文件
aws --no-sign-request s3 ls s3://commoncrawl/crawl-data/CC-MAIN-2026-21/

# 下载
aws --no-sign-request s3 cp s3://commoncrawl/path/to/file.warc.gz ./
```

#### 方式三：CDX URL 索引（按 URL 精准查询）

**索引服务器：** `https://index.commoncrawl.org/`

```bash
# 查询 example.com 在所有 crawl 中的记录（返回 JSON）
curl "https://index.commoncrawl.org/CC-MAIN-2026-21-index?url=example.com&output=json"
```

返回字段：
```json
{
  "urlkey": "com,example)/",
  "timestamp": "20260508082331",
  "url": "http://www.example.com/",
  "mime": "text/html",
  "mime-detected": "text/html",
  "status": "200",
  "digest": "B6NJ6JIZT3B7E442X7OKPSKPSC2TEWYR",
  "length": "948",
  "offset": "26951243",
  "filename": "crawl-data/CC-MAIN-2026-21/segments/.../warc/...warc.gz",
  "languages": "eng"
}
```

**API 端点：**
- `/{crawl-id}-index?url={pattern}&output=json` — CDX 索引查询
- `/{crawl-id}-index?url={pattern}&output=json&pageSize=N` — 分页
- `/collinfo.json` — 列出所有可用的 crawl 索引

#### 方式四：Columnar Index（列式索引，适合批量过滤）

2018 年后提供 Parquet 格式的列式索引，适合 Spark/Hive 做大规模过滤和聚合分析。

### 2.4 用 CommonCrawl 替代实时爬取

**优势：**
- ✅ 零爬取成本（无需处理反爬、代理、限速）
- ✅ 历史数据丰富（回溯 10+ 年）
- ✅ 数据格式统一（WARC/WET 标准化）
- ✅ 无法律风险（robots.txt 由 CC 负责）

**局限性：**
- ❌ **延迟 1-6 个月**：最新数据可能已过时
- ❌ 覆盖不完整（非全网，只是爬得到的那部分）
- ❌ 无实时性：不能用于实时舆情监控
- ❌ 2025 年争议：CCBot 已成为 top 1000 网站中最被广泛封禁的爬虫

### 2.5 2026 年新进展

- **Hugging Face 分发自 2026 年 4 月起实验性提供** CommonCrawl 数据，通过 `hf://datasets/commoncrawl`，极大降低了下载门槛
- CCBot 封禁率持续上升，可能影响未来数据覆盖率

---

## 三、聚焦爬虫 (Focused Crawling)

### 3.1 什么是聚焦爬虫

聚焦爬虫不是全量抓取整个 Web，而是：
- 从种子 URL 出发
- 对每个页面评估「是否与目标主题相关」
- 只深入高相关页面
- 类似 BFS/DFS 但不遍历全部分支

### 3.2 agent 如何实现「按需爬取」

```
┌───────────────────────────────────────────────────────┐
│                   Agent 决策循环                        │
│                                                       │
│  1. 收到用户查询/研究任务                               │
│  2. Agent 决定要爬取哪些网站（搜索 API / 知识图谱）       │
│  3. 将种子 URL 推入优先级队列                           │
│  4. 对每个抓取的页面：                                  │
│     a) 用 LLM 评估页面与任务的相关性                     │
│     b) 高相关 → 提取内容、提取链接、入索引               │
│     c) 低相关 → 丢弃、不继续遍历                        │
│  5. 动态调整优先级（新发现的链接可能重新排序）            │
│  6. 直到收集到足够信息或达到预算上限                      │
└───────────────────────────────────────────────────────┘
```

### 3.3 链接提取 + 优先级队列 + 相关性过滤

```
种子 URL: article-about-topic.com
    │
    ├─ [Page 1] 相关度 0.9 → 深入
    │   ├─ [Link A] 相关度 0.8 → 入队(优先级高)
    │   ├─ [Link B] 相关度 0.3 → 丢弃
    │   └─ [Link C] 相关度 0.6 → 入队(优先级中)
    │
    ├─ [Page 2] 相关度 0.1 → 停止该分支
    │
    └─ [Page 3] 相关度 0.95 → 加入种子集继续
```

**优先级计算建议：**
```
priority = w1 * relevance_score + w2 * freshness + w3 * authority_score
```
- `relevance_score`：LLM 评估（标题、摘要、首段与任务的语义相似度）
- `freshness`：页面最后修改时间
- `authority_score`：域名权威度（如引用次数）

### 3.4 开源实现参考

| 项目 | 语言 | 特点 |
|------|------|------|
| **Scrapy + scrapy-crawl-once** | Python | 最简单的聚焦爬虫，配合 selector 过滤 |
| **Crawlee + custom label filter** | TypeScript | 用 label 机制 + 自定义 enqueueLinks 条件 |
| **Apache Nutch (Focused Crawling Plugin)** | Java | 基于文本分类器的聚焦爬取扩展 |
| **StormCrawler 自定义 ParseFilter** | Java | 流式聚焦抓取，实时评估 URL 相关性 |

---

## 四、反爬对抗

### 4.1 robots.txt 解析

**Scrapy：**
```python
# settings.py 中启用
ROBOTSTXT_OBEY = True  # 默认遵守
```
- 内置 `RobotstxtMiddleware`
- 缓存 robots.txt，减少重复请求

**Crawlee：**
```typescript
// 所有爬虫默认遵守 robots.txt
const crawler = new PlaywrightCrawler({
    // 可选：禁用 robots.txt 检查（不推荐）
    // useSessionPool: false,
});
```

**Colly：**
```go
c := colly.NewCollector(
    colly.IgnoreRobotsTxt(), // 如需忽略
)
// 默认遵守 robots.txt
```

### 4.2 速率限制最佳实践

| 策略 | 说明 | 实现 |
|------|------|------|
| **固定延迟** | 请求间固定间隔 | Crawlee: `requestHandlerTimeoutSecs` |
| **自适应限速** | 根据服务器响应时间动态调整 | Scrapy: `AUTOTHROTTLE_ENABLED = True` |
| **域名并发限制** | 同一域名同时最多 N 个连接 | Crawlee: `maxConcurrency` + 域名分组 |
| **时间窗口限制** | 每分钟/小时最多 N 个请求 | 自定义计数器 |
| **退避策略** | 429/503 时指数退避 | 中间件内置 |

**Scrapy AutoThrottle 配置：**
```python
AUTOTHROTTLE_ENABLED = True
AUTOTHROTTLE_START_DELAY = 5      # 初始延迟(秒)
AUTOTHROTTLE_MAX_DELAY = 60       # 最大延迟
AUTOTHROTTLE_TARGET_CONCURRENCY = 1.0  # 目标并发数
```

**Crawlee 速率控制：**
```typescript
const crawler = new PlaywrightCrawler({
    maxConcurrency: 10,                    // 全局最大并发
    maxRequestsPerMinute: 60,              // 每分钟最多请求
    requestHandlerTimeoutSecs: 30,         // 单个请求超时
    maxRequestRetries: 3,                  // 最大重试次数
});
```

### 4.3 代理轮换方案

| 方案 | 成本 | 效果 | 适用场景 |
|------|------|------|---------|
| **无代理** | 免费 | 差 | 个人小规模爬取 |
| **免费代理列表** | 免费 | 极不稳定 | ⚠️ 不推荐 |
| **数据中心代理** | $1-10/GB | 中等 | 一般网站 |
| **住宅代理** | $10-50/GB | 好 | 反爬严格的网站 |
| **移动代理** | $20+/GB | 最好 | 极严反爬（如社交媒体） |
| **代理池自建** | 运维成本高 | 可控 | 大规模持续爬取 |

**Crawlee Tiered 代理**（推荐模式）：
```typescript
const proxyConfiguration = new ProxyConfiguration({
    tieredProxyUrls: [
        [null],                                    // 先试无代理
        ['http://datacenter-proxy-1.com'],           // 被拦截后切数据中心代理
        ['http://residential-proxy-1.com',           // 再被拦截切住宅代理
         'http://residential-proxy-2.com'],
    ],
});
// 自动探活：定期检测低层代理是否已解封，自动降级
```

**Scrapy 代理中间件：**
```python
# scrapy-rotating-proxies
ROTATING_PROXY_LIST = [
    'http://proxy1.com:8080',
    'http://proxy2.com:8080',
]
DOWNLOADER_MIDDLEWARES = {
    'rotating_proxies.middlewares.RotatingProxyMiddleware': 610,
}
```

### 4.4 浏览器指纹对抗 (Crawlee 特有)

Crawlee 是唯一一个内置指纹管理的框架：

```typescript
const crawler = new PlaywrightCrawler({
    browserPoolOptions: {
        fingerprintOptions: {
            fingerprintGeneratorOptions: {
                browsers: [{ name: BrowserName.chrome, minVersion: 110 }],
                devices: [DeviceCategory.desktop],
                operatingSystems: [OperatingSystemsName.windows],
                locales: ['en-US'],
            },
        },
    },
});
```

- **默认启用**：零配置自动生成随机指纹
- **Camoufox 集成**：应对 Cloudflare 等高级防护
- **Session 关联**：同一 session 复用同一指纹，模拟真实用户

### 4.5 综合反爬策略建议

```
第 0 层：礼貌爬取
  ├── 遵守 robots.txt
  ├── 合理 User-Agent（标识身份和联系方式）
  └── 低并发、长间隔

第 1 层：轻度对抗
  ├── IP 轮换（代理池）
  ├── Referer / Accept-Language 伪造
  └── Cookie 管理

第 2 层：中度对抗（Crawlee 内置）
  ├── 浏览器指纹随机化
  ├── Session 隔离
  └── Tiered 代理自动升级

第 3 层：重度对抗
  ├── Camoufox / stealth 插件
  ├── 住宅代理 + 移动代理
  ├── 人工模拟（鼠标移动、滚动、点击）
  └── CAPTCHA 处理（需人工或 2captcha 服务）
```

---

## 五、agent 自建索引的最小可行方案

### 5.1 架构设计

```
┌─────────────────────────────────────────────────────┐
│                    Agent (决策层)                      │
│                                                       │
│  任务理解 → 搜索规划 → 爬取调度 → 相关性评估 → 输出     │
└───────────┬──────────────────────────┬────────────────┘
            │                          │
   ┌────────▼────────┐        ┌───────▼────────┐
   │   Crawler        │        │  CommonCrawl   │
   │   (Crawlee)      │        │  Index Server  │
   │   实时按需爬取    │        │  历史数据查询   │
   └────────┬────────┘        └───────┬────────┘
            │                          │
            └──────────┬───────────────┘
                       │
              ┌────────▼────────┐
              │  Content Store   │
              │  (SQLite/JSON)   │
              │                  │
              │  url, title,     │
              │  text, meta,     │
              │  crawl_time      │
              └────────┬────────┘
                       │
              ┌────────▼────────┐
              │  Indexer         │
              │  (mini-search)   │
              │                  │
              │  可选方案:        │
              │  • SQLite FTS5   │
              │  • MiniSearch    │
              │  • Elasticsearch │
              │  • LanceDB       │
              └─────────────────┘
```

### 5.2 推荐技术栈

| 层级 | 推荐方案 | 替代方案 |
|------|---------|---------|
| **实时爬取** | Crawlee (TypeScript) | Colly (Go) 如果性能优先 |
| **历史数据** | CommonCrawl CDX Index → WARC | — |
| **内容存储** | SQLite (轻量) / JSON 文件 | PostgreSQL / LevelDB |
| **全文索引** | SQLite FTS5 / MiniSearch.js | LanceDB (向量) / Elasticsearch |
| **向量检索** | LanceDB (嵌入式) | Chroma / Qdrant |

### 5.3 最小可行实现（TypeScript）

```typescript
import { PlaywrightCrawler, Dataset } from 'crawlee';
import Database from 'better-sqlite3';
import MiniSearch from 'minisearch';

// 1. 初始化 SQLite 内容存储 + FTS5 全文索引
const db = new Database('agent_index.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE,
    title TEXT,
    text_content TEXT,
    crawl_time INTEGER
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
    title, text_content, content='pages', content_rowid='id'
  );
`);

// 2. 初始化 MiniSearch（内存中快速搜索）
const miniSearch = new MiniSearch({
  fields: ['title', 'text'],
  storeFields: ['url', 'title', 'crawlTime'],
});

// 3. Agent 驱���的聚焦爬虫
async function agentCrawl(topic: string, seedUrls: string[]) {
  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: 200,
    maxConcurrency: 5,
    
    async requestHandler({ request, page, enqueueLinks, log }) {
      const title = await page.title();
      const text = await page.evaluate(() => document.body.innerText);
      
      // Agent 评估相关性（实际用 LLM）
      const relevance = evaluateRelevance(topic, title, text.substring(0, 1000));
      
      if (relevance > 0.5) {
        // 存入索引
        const stmt = db.prepare(
          'INSERT OR REPLACE INTO pages(url, title, text_content, crawl_time) VALUES(?,?,?,?)'
        );
        const result = stmt.run(request.loadedUrl, title, text, Date.now());
        
        miniSearch.add({
          id: result.lastInsertRowid as number,
          title,
          text: text.substring(0, 5000),
          url: request.loadedUrl,
          crawlTime: Date.now(),
        });
        
        log.info(`[RELEVANT ${relevance.toFixed(2)}] ${title}`);
        
        // 深入爬取高相关页面
        if (request.userData.depth < 3) {
          await enqueueLinks({
            selector: 'a[href]',
            transformRequestFunction: (req) => {
              req.userData.depth = (request.userData.depth || 0) + 1;
              return req;
            },
          });
        }
      }
    },
  });
  
  await crawler.run(seedUrls);
}

// 4. 搜索接口
function search(query: string, topK: number = 10) {
  const results = miniSearch.search(query, { prefix: true, fuzzy: 0.2 });
  return results.slice(0, topK).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.text?.substring(0, 300),
    score: r.score,
  }));
}
```

### 5.4 CommonCrawl 集成路径

```
步骤 1: 通过 CDX Index 查询目标域名的所有历史页面
  curl "https://index.commoncrawl.org/CC-MAIN-2026-21-index?url=*.example.com/*&output=json"

步骤 2: 根据返回的 offset + filename 从 WARC 文件提取页面内容
  Python: warcio + boto3
  Node.js: node-warc

步骤 3: 提取纯文本并建立索引（同 5.3 中的 SQLite FTS5 / MiniSearch）
```

**Python 版 CommonCrawl 提取示例：**
```python
import requests
import gzip
from warcio.archiveiterator import ArchiveIterator

# 1. 查 CDX Index
resp = requests.get(
    'https://index.commoncrawl.org/CC-MAIN-2026-21-index',
    params={'url': '*.example.com/*', 'output': 'json'}
)
records = [r for r in resp.json() if r['status'] == '200']

# 2. 取第一条记录的 WARC 文件
rec = records[0]
warc_url = f"https://data.commoncrawl.org/{rec['filename']}"

# 3. 下载并解析
import io
warc_data = requests.get(warc_url).content
with gzip.open(io.BytesIO(warc_data)) as f:
    for record in ArchiveIterator(f):
        if record.rec_type == 'response':
            # 提取纯文本
            html = record.content_stream().read()
            # 用 BeautifulSoup 提取文本
            # ...存入索引
```

---

## 六、结论与建议

### 6.1 框架选型建议

| 场景 | 推荐框架 | 理由 |
|------|---------|------|
| **Agent 实时按需爬取** | Crawlee (TypeScript) | 原生 JS 渲染、指纹管理、代理分层、Session 管理，与 Node.js agent 天然集成 |
| **Go 生态 agent** | Colly | 极致性能，API 简洁 |
| **大规模离线索引构建** | Apache Nutch + Solr/ES | Hadoop 分布式、搜索引擎级成熟度 |
| **实时增量监控** | StormCrawler + ES | 流式处理、低延迟 |
| **已有 Python 项目** | Scrapy | 生态成熟、中间件丰富 |

### 6.2 数据策略

| 需求 | 方案 |
|------|------|
| 实时信息 | Crawlee 实时爬取 + 增量索引 |
| 历史回溯 | CommonCrawl (CC-MAIN-2026-21 是最新) |
| 混合策略 | CommonCrawl 加载历史基线 → Crawlee 补充实时差异 |

### 6.3 关键提醒

1. **CommonCrawl 延迟**：最新数据可能滞后 1-6 个月，不适合实时应用
2. **CCBot 封禁率**：2025 年起 CCBot 被封禁率持续上升，未来数据覆盖可能下降
3. **Hugging Face 分发**：2026 年 4 月起可通过 `hf://datasets/commoncrawl` 获取，是更好的访问方式
4. **反爬代价**：住宅代理 + 指纹管理的成本不低，对于 agent 场景，优先考虑 CommonCrawl + 有限实时爬取的混合方案
5. **法律合规**：无论用哪个框架，都应遵守 robots.txt 和网站服务条款

---

*本报告基于 2026 年 6 月最新数据编写。*
