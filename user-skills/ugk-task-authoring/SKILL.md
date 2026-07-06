---
name: ugk-task-authoring
description: >
  用外部 agent(codex/cursor 等)造 ugk 可用的 task。当用户说"帮我做个 XX 的 task""造个下载器 task""把这个能力做成 task""create a UGK task""make this reusable as a task"时用。教你怎么写 ugk 五件套(skill.md/verify.mjs/contract.json/spec.json/taskbook.json)+ tests/,怎么用原生 node 自验,怎么交付能直接拷进 ugk 用的 task 目录。不依赖 ugk 运行时,纯文件操作。
---

# UGK Task Authoring

把本文贴进外部 agent 的 system prompt 或项目 instructions 使用。你是 task 设计者,产出一个能直接拷进 ugk 的 task 目录;你不需要、也不应该假设当前环境有 ugk runtime、`/task`、`run_task` 或 dispatcher runner。

## 1. 先搞清楚 task 是什么

| 事实 | 说明 |
|---|---|
| 形态 | 一个目录,5 个核心文件 + 可选 `scripts/` + 可选 `tests/` |
| 安装 | 拷到 `~/.pi/agent/tasks/<name>/`;目录名必须等于 `taskbook.json.name` |
| 运行链路 | ugk 内部会:dispatcher 把自然语言翻译成 `runtimeInput` -> worker 按 `skill.md` 执行 -> `verify.mjs` 校验产物 |

外部 agent 的职责只有一件事:写出这个目录,并用原生 Node 自验。dispatcher eval 外部跑不了,只产 `tests/eval.cases.json`。

## 2. 目录结构

```text
<task-name>/
  taskbook.json
  spec.json
  contract.json
  skill.md
  verify.mjs
  scripts/              # 可选:自带脚本
  tests/                # 可选:随包测试资产
```

## 3. 五件套格式

### `taskbook.json`

校验要点:`name` 正则 `^[A-Za-z0-9_-]+$`,且必须等于目录名。`runs` 必须写 `[]`,运行历史由 ugk 填。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 正则 `^[A-Za-z0-9_-]+$`,必须等于目录名 |
| `description` | string | 是 | 任意非空描述 |
| `scope` | `"user"`/`"project"` | 是 | user=全局,project=项目级 |
| `createdAt` | string(ISO) | 是 | ISO 8601 时间戳 |
| `updatedAt` | string(ISO) | 是 | ISO 8601 时间戳 |
| `tags` | string[] | 否 | 特殊值 `"dedicated"` 由系统管理,别手写 |
| `runs` | array | 是 | 必须写 `[]` |

```json
{
  "name": "ins-downloader",
  "description": "Download Instagram posts/reels via a single URL.",
  "scope": "user",
  "createdAt": "2026-07-06T10:00:00.000Z",
  "updatedAt": "2026-07-06T10:00:00.000Z",
  "tags": ["instagram", "download"],
  "runs": []
}
```

### `spec.json`

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| `goal` | string | 是 | 非空(trim 后 length > 0) |
| `hardConstraints` | string[] | 是 | 非空数组 |
| `acceptance` | string[] | 是 | 非空数组,每条须机器可验 |
| `forbidden` | string[] | 否 | 省略合法,建议写全 |
| `context` | string | 否 | 省略合法 |

```json
{
  "goal": "给定一个 Instagram 帖子 URL,下载其中的图片/视频到产物目录。",
  "hardConstraints": [
    "必须使用 taskbook 自带脚本 $TASK_DIR/scripts/download.mjs 执行下载。",
    "所有产物必须写入本次 task 的 outputDir。"
  ],
  "acceptance": [
    "media.json 存在且为有效 JSON。",
    "至少一个媒体文件(.jpg/.mp4)存在。"
  ],
  "forbidden": ["不得硬编码本机输出路径。"],
  "context": "Instagram 下载器。只 url 必填。"
}
```

### `contract.json`

| 字段 | 类型 | 必填 | 校验规则 |
|---|---|---|---|
| `outputDir` | string | 实际需要 | 约定写 `"<runtime>"` |
| `artifacts` | string[] | 实际需要 | 纯字符串数组,支持 glob;别用对象数组 |
| `runtimeInput` | string[] | 否 | 若存在必须是字符串数组 |
| `runtimeInputMeta` | object | 否 | 每个 key 必须在 `runtimeInput` 里声明;每个 value 是对象 |
| `requiredEnv` | string[] | 否 | 字符串数组 |
| `requiredTools` | string[] | 否 | 字符串数组;如 `["bash"]`,特殊值 `chrome_cdp` |
| `requiredBinaries` | string[] | 否 | 字符串数组;如 `["yt-dlp","ffmpeg"]` |
| `maxRetry` | integer | 否 | 整数且 `>=0`;未声明默认 3;昂贵采集器写 0 |

`runtimeInputMeta.<key>` 子字段:

| 子字段 | 类型 | 作用 |
|---|---|---|
| `description` | string | 给 dispatcher LLM 看的字段说明 |
| `required` | boolean | 仅 `true` 才触发门禁 |
| `default` | 任意 | 用户未提供时系统补此值 |
| `allowedValues` | (string/number)[] | 字段只能取其中之一 |

```json
{
  "outputDir": "<runtime>",
  "artifacts": ["media.json", "*.jpg", "*.mp4"],
  "runtimeInput": ["url", "quality"],
  "runtimeInputMeta": {
    "url": { "description": "必填,Instagram 帖子链接", "required": true },
    "quality": { "description": "可选,画质", "required": false, "default": "best", "allowedValues": ["best", "worst"] }
  },
  "requiredTools": ["bash"],
  "requiredBinaries": ["yt-dlp"]
}
```

### `skill.md`

worker 的执行手册,只写"怎么做":

| ✅ 写 | ❌ 别写 |
|---|---|
| 输入字段含义、执行步骤、输出文件名、脚本调用方式 | 验收逻辑;那是 `verify.mjs` 的职责 |
| `$TASK_OUTPUT_DIR/<artifact>` 落盘约定 | 本机绝对路径 |
| `$TASK_DIR/scripts/xxx` 引用自带脚本 | 裸脚本名或相对路径 |

### `verify.mjs`

见下一节。这个文件写错,task 就废。

## 4. `verify.mjs` 协议

### 运行时契约

`verify.mjs` 等价于被这样执行:`node /path/to/verify.mjs`,不带参数。

| 环境变量 | 类型 | 值 |
|---|---|---|
| `TASK_OUTPUT_DIR` | string | worker 产物目录的绝对路径 |
| `TASK_INPUT` | JSON 字符串 | `JSON.stringify(runtimeInput)` |
| `TASK_DIR` | string | task 目录绝对路径;有时不注入,读前必须判 undefined |

| 结果 | 语义 |
|---|---|
| exit 0 | PASS |
| exit 非 0 | FAIL |
| 运行超过 30 秒 | FAIL |

### FAIL stdout 格式

FAIL 时 stdout 必须是裸 `VerifyFailure[]` JSON 数组,不是 `{"failures":[...]}`。

```js
// ❌ 错:包了一层
console.log(JSON.stringify({ failures: failures }));

// ✅ 对:裸数组
console.log(JSON.stringify(failures, null, 2));
```

| 字段 | 类型 | 必填 |
|---|---|---|
| `assertion` | string | 是 |
| `expected` | string | 是 |
| `actual` | string | 是;对象/数字必须 `JSON.stringify` |
| `hint` | string | 否 |

### 完整骨架

```js
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const failures = [];
function fail(assertion, expected, actual, hint) {
  // 三必填必须 string;actual 若是对象/数字,调用方自己 JSON.stringify
  failures.push({
    assertion: String(assertion),
    expected: String(expected),
    actual: String(actual),
    ...(hint ? { hint: String(hint) } : {}),
  });
}
function parseJsonText(text, label) {
  try { return JSON.parse(text); }
  catch (e) { fail(label + " is valid JSON", "parseable JSON", e.message || String(e)); return null; }
}

const outputDir = process.env.TASK_OUTPUT_DIR;
const taskInput = parseJsonText(process.env.TASK_INPUT || "{}", "TASK_INPUT") || {};

if (!outputDir || !existsSync(outputDir)) {
  fail("TASK_OUTPUT_DIR exists", "existing output directory", outputDir || "missing");
} else {
  // 对每个 artifact:先判存在(空目录必 FAIL 靠这个),再读 + 校验
  const mainFile = join(outputDir, "media.json");
  if (!existsSync(mainFile)) {
    fail("artifact exists", "file exists", "missing", "worker must write media.json");
  } else {
    const data = parseJsonText(readFileSync(mainFile, "utf8"), "media.json");
    if (data) {
      // ... 字段存在性 + 值语义 + 与 taskInput.<field> 回显比对 ...
    }
  }
}

if (failures.length > 0) {
  console.log(JSON.stringify(failures, null, 2));  // 裸数组,不是 {failures:[...]}
  process.exit(1);
}
console.log("PASS");   // 习惯写法,非必须;exit 0 才是判据
process.exit(0);
```

### `TASK_INPUT` 怎么读

`TASK_INPUT` 是 JSON 对象字符串,key 是 `runtimeInput` 字段名。verify 只做产物语义校验,不重复输入校验;required 字段缺失由 dispatcher 门禁处理。

```js
const taskInput = parseJsonText(process.env.TASK_INPUT || "{}", "TASK_INPUT") || {};
const url = String(taskInput.url ?? "");
if (url && data.url !== url) {
  fail("url matches TASK_INPUT.url", url, data.url, "worker must echo dispatcher url");
}
```

### 10 个雷区

1. ❌ FAIL stdout 写 `{"failures":[...]}` -> ✅ 裸数组
2. ❌ `actual` 塞对象/数字 -> ✅ 先 `JSON.stringify`
3. ❌ 用 `import.meta.url`/`__dirname` 定位文件 -> ✅ 用 `TASK_OUTPUT_DIR`/`TASK_DIR`
4. ❌ import 第三方 npm 包 -> ✅ 只用 Node stdlib + 相对 import 自带 scripts
5. ❌ verify 跑超过 30 秒 -> ✅ 只做轻量文件校验
6. ❌ 空目录也 PASS -> ✅ 每个 artifact 先 `existsSync`
7. ❌ 在 verify 判 `TASK_INPUT` 字段是否存在 -> ✅ 只校验产物是否用了输入
8. ❌ 依赖 `TASK_DIR` 不判空 -> ✅ `if (process.env.TASK_DIR)` 后再读
9. ❌ 用 `require` 或省略 `.mjs` -> ✅ ESM + 显式扩展名
10. ❌ 忘了 `process.exit(0/1)` -> ✅ exit code 是唯一判据

## 5. `tests/` 子目录

`tests/` 全部随包发布。别把测试写成依赖 ugk runtime 的脚本;外部能跑的只用原生 Node。

| 文件 | 什么时候写 | 外部能跑? |
|---|---|---|
| `eval.cases.json` | 有 `runtimeInput`、dispatcher 翻译有歧义时 | ❌ 不能;需 ugk runner + LLM,只产文件 |
| `verify.test.mjs` | task 有 `verify.mjs` 时 | ✅ 能;设环境变量跑 |
| `collect.test.mjs` | task 有 `scripts/` 且脚本支持 `UGK_COLLECTOR_SELFTEST` 时 | ✅ 能 |

`eval.cases.json` 结构:

```json
{
  "task": "ins-downloader",
  "description": "dispatcher 翻译质量 eval。",
  "cases": [
    {
      "id": "case-01",
      "group": "baseline",
      "input": "下载 https://instagram.com/p/xxx",
      "assert": { "url": "equals:https://instagram.com/p/xxx" },
      "note": "基线"
    },
    {
      "id": "case-02",
      "group": "boundary",
      "input": "下个视频",
      "assert": { "__outcome": "fails-required-gate" },
      "note": "无 url,应解析失败"
    }
  ]
}
```

assert 操作符:`equals:<值>` / `omitted` / `in:a|b` / `present` / `path-equals:<值>` / `__outcome: fails-required-gate`。

## 6. 标准作业流程

1. 理解需求 + 跑通最优路径。外部 agent 自己试错,别把试错写进 task。
2. 复刻五件套。把稳定路径固化成 `skill.md`、`verify.mjs`、`contract.json` 等。
3. 写 `verify.mjs`。照骨架改断言,先保证空目录 FAIL、合格产物 PASS、缺字段 FAIL。
4. 原生 Node 自验。见下一节,不依赖 ugk runtime。
5. 交付整个目录。用户把目录拷到 `~/.pi/agent/tasks/<name>/` 后再在 ugk 里跑。

## 7. 原生自验清单

### JSON + 语法

```bash
node -e "JSON.parse(require('fs').readFileSync('taskbook.json','utf8'))"
node -e "JSON.parse(require('fs').readFileSync('spec.json','utf8'))"
node -e "JSON.parse(require('fs').readFileSync('contract.json','utf8'))"
node --check verify.mjs
```

### verify 三路径

| 路径 | 做法 | 期望 |
|---|---|---|
| 空目录 | `TASK_OUTPUT_DIR` 指向空目录 | FAIL,stdout 裸数组 |
| 合格产物 | 写入符合 contract 的样例 artifact | PASS,exit 0 |
| 缺字段/坏 JSON | 删字段或写坏 JSON | FAIL,指出具体断言 |

```bash
TASK_OUTPUT_DIR=/tmp/ugk-task-empty TASK_INPUT='{"url":"https://example.com"}' node verify.mjs
```

### 契约一致性

| 对照项 | 必须一致 |
|---|---|
| `contract.artifacts` | `verify.mjs` 检查的文件名、`skill.md` 要求 worker 写的文件名 |
| `runtimeInput` | 每个 `runtimeInputMeta` key 都已声明 |
| `skill.md` 脚本引用 | `$TASK_DIR/scripts/*` 下真实存在 |
| `requiredTools`/`requiredBinaries` | 声明了就真的会用;用了就必须声明 |

dispatcher eval 外部跑不了。只写 `tests/eval.cases.json`;拷到 ugk 后再跑:

```bash
npm run eval:dispatcher -- --task=<name>
```

## 8. 交付检查清单

| 检查 | 标准 |
|---|---|
| 目录名 | 等于 `taskbook.json.name`,匹配 `^[A-Za-z0-9_-]+$` |
| 核心文件 | 5 个齐全,全小写,大小写敏感 |
| `taskbook.json` | `runs: []`,`scope: "user"` 或 `"project"` |
| `contract.json` | `outputDir: "<runtime>"`;`artifacts` 是纯字符串数组 |
| 输入元数据 | `runtimeInputMeta` 每个 key 都在 `runtimeInput` 声明 |
| `verify.mjs` | FAIL 输出裸数组,不是 `{ "failures": [...] }` |
| `skill.md` | 不含验收逻辑;脚本路径都用 `$TASK_DIR/scripts/*` |
| 自验 | JSON parse、`node --check`、verify 三路径都跑过 |

## 9. 最小真实样本

```text
ins-downloader/
  taskbook.json
  spec.json
  contract.json
  skill.md
  verify.mjs
  tests/eval.cases.json
```

可访问 ugk 机器时,参考这些已安装 task:

| 样本 | 用途 |
|---|---|
| `~/.pi/agent/tasks/bili-up-homepage-spider/` | 最简结构 |
| `~/.pi/agent/tasks/video-downloader/` | 完整 task,含 eval cases |
| `~/.pi/agent/tasks/ins-search/` | 复杂 verify |

## 10. 铁律 + 反模式

| ❌ 别这么干 | ✅ 改成 |
|---|---|
| 在 verify 里判 `TASK_INPUT.url` 是否存在 | 让 dispatcher 门禁管输入;verify 只判产物 |
| `artifacts` 写对象数组 | 写纯字符串数组,如 `["media.json","*.mp4"]` |
| `actual` 直接塞对象 | `JSON.stringify(obj)` |
| verify 用 `import.meta.url`/`__dirname` | 用 `TASK_OUTPUT_DIR` 和判空后的 `TASK_DIR` |
| verify import 第三方包 | 只用 Node stdlib |
| skill.md 写验收逻辑 | 放进 `verify.mjs` |
| 外部环境假装能跑 dispatcher eval | 只产 `eval.cases.json`,拷到 ugk 后跑 |
| 固定值也参数化 | 只有每次运行会变的值进 `runtimeInput` |

最后再问一次:这个能力会被多次、参数化地复用吗?如果不会,别做 task。YAGNI 比坏 task 便宜。
