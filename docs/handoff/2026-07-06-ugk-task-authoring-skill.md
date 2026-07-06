# 新 skill:ugk-task-authoring — 写给外部 agent 的 task 制作指南

> **给执行者(同事)**:这次是写一个 skill 文档(`SKILL.md`),不是写代码。受众是**外部 agent**(codex/cursor 等),不是 ugk 自己。
> **基线**:main = `aa2a42a`。
> **素材来源**:三份代码探查报告已确认所有协议细节,你**不用重新读代码**,照本文档的素材写即可。

---

## 0. 背景与目标

### 0.1 为什么做这个 skill
用户的真实工作流:
```
需求 → 在外部 agent(codex)里跑通最优路径 → 把成果带回 ugk → /task run 复用
```
ugk 不够强(试错能力弱),所以**试错留给外部 agent,固化交给 ugk**。但外部 agent 不知道 ugk task 的结构约定。这个 skill 就是**一份自包含的"ugk task 规格书 + 作业 SOP"**,外部 agent 装上后能产出 ugk 兼容的、经过原生自验的高质量 task。

### 0.2 skill 定位
- **名字**:`ugk-task-authoring`(kebab-case,带 `ugk-` 前缀表明域,避开与现有 `task-creator` 重名)
- **位置**:`user-skills/ugk-task-authoring/SKILL.md`(用户 skill 区,不跟包走)
- **受众**:外部 agent(codex 等)
- **关键约束**:**自包含**——不假设有 ugk runtime(没有 `/task`/`run_task`/dispatcher),只教纯文件操作 + 原生 node 自验
- **与 task-creator 的关系**:互补不冲突。task-creator 是 ugk 内部参考手册(讲状态机交互);本 skill 是外部规格书(讲离线造 task)

### 0.3 外部 agent 怎么"装"这个 skill
代码里**没有自动加载机制**(已确认:ugk 的 skill 只在 `<ugk>/skills/` 和 `<ugk>/user-skills/` 被 ugk 自己加载,外部 agent 不会扫这里)。实际用法是:**把 SKILL.md 内容贴进外部 agent 的 system prompt 或项目级 instructions**。

因此 SKILL.md **必须自包含**——外部 agent 只看这一份文档就能造 task,不依赖任何 ugk 运行时概念。在文档开头要说明这个用法。

---

## 1. SKILL.md 规范(必须遵守)

### 1.1 Frontmatter(pushy description)
```yaml
---
name: ugk-task-authoring
description: 用外部 agent(codex/cursor 等)造 ugk 可用的 task。当用户说"帮我做个 XX 的 task""造个下载器 task""把这个能力做成 task"时用。教你怎么写 ugk 五件套(skill.md/verify.mjs/contract.json/spec.json/taskbook.json)+ tests/,怎么用原生 node 自验,怎么交付能直接拷进 ugk 用的 task 目录。不依赖 ugk 运行时,纯文件操作。
---
```
- `description` 是唯一触发机制,要写得够主动/略 pushy(参照 skill-creator 规范)
- 列举多种触发场景(中英文表述)

### 1.2 写作风格(参照 task-creator)
- **中文为主**,技术术语保留英文(dispatcher/worker/runtimeInput 等)
- 大量 **Markdown 表格**(字段清单、对比)
- 大量 **代码块**(JSON 样本、bash 自验命令、verify.mjs 骨架)
- **❌/✅ 对比** 反模式与正确做法
- 口语化、强调语气("别这么干""这是真实踩过的坑")
- **篇幅 <500 行**(skill-creator 规范;超了拆 references/)

### 1.3 目录结构
```
user-skills/ugk-task-authoring/
└── SKILL.md          (主文件,自包含)
```
若主文件超 500 行,把大块内容拆到 `references/`(如 `references/verify-protocol.md`),但**优先自包含**(外部 agent 贴 prompt 时一次拿全最方便)。

---

## 2. SKILL.md 正文章节(10 节,按此结构写)

### ① 开头:用法说明(给外部 agent 看)
说明这个 skill 怎么用(贴进 prompt)+ 一句话定位(你是设计者,产出 ugk 能直接用的 task 目录)。

### ② ugk task 是什么(3 行讲清)
- 一个目录,5 个核心文件 + 可选 scripts/ + 可选 tests/
- 装到 `~/.pi/agent/tasks/<name>/` 就能用(目录名 = taskbook.json 的 name)
- 执行时 ugk 会:① dispatcher 把用户自然语言翻译成结构化输入 → ② worker 按_skill.md_执行 → ③ verify.mjs 校验产物

### ③ 五件套格式(照着写,装到 ugk 不会报错)
每个文件一节,附最小样本。**字段规范见本文档 §3(权威素材)**。

- ### taskbook.json
- ### spec.json
- ### contract.json(字段最多,重点)
- ### skill.md(worker 执行手册,**禁止含验收逻辑**)
- ### verify.mjs(最关键,见 ④)

### ④ verify.mjs 协议(最关键,写错 task 就废了)
**这是 SKILL.md 的核心章节**。内容见本文档 §4(权威素材,直接抄)。

- ### 运行时契约(环境变量 + exit code + 30s 超时)
- ### FAIL 时 stdout 必须是裸 VerifyFailure[] 数组
- ### 完整骨架(可直接抄)
- ### TASK_INPUT 怎么读
- ### 10 个易踩的雷(清单)

### ⑤ tests/ 子目录(可选,随包发布)
- eval.cases.json(dispatcher eval 用例,assert 操作符清单)
- verify.test.mjs(测 verify.mjs 判得对不对)
- collect.test.mjs(脚本冒烟)
- 内容见本文档 §5

### ⑥ 标准作业流程(5 步,从需求到交付)
1. 理解需求 + 跑通最优路径(你作为外部 agent 的试错,这部分 skill 管不了,靠你自己的能力)
2. 复刻五件套(把路径固化成 skill.md/verify.mjs/contract.json)
3. 写 verify.mjs(参照骨架 + 10 个雷区)
4. 原生 node 自验(见 ⑦)
5. 交付(整个目录给用户拷到 `~/.pi/agent/tasks/`)

### ⑦ 原生自验清单(不依赖 ugk runtime)
- JSON 可解析:`node -e "JSON.parse(require('fs').readFileSync('contract.json','utf8'))"`
- verify.mjs 语法:`node --check verify.mjs`
- verify 三路径:设 TASK_OUTPUT_DIR/TASK_INPUT 跑 verify(空目录必 FAIL / 合格产物 PASS / 缺字段 FAIL)
- 契约一致性:contract.artifacts 名字 vs verify.mjs 检查的文件名
- dispatcher eval:**外部环境跑不了**(需要 ugk runner + LLM),只产 eval.cases.json 文件,实际 eval 等拷到 ugk 后跑 `npm run eval:dispatcher -- --task=<name>`

### ⑧ 交付检查清单(装到 ugk 前必过)
- 目录名 = taskbook.name,正则 `^[A-Za-z0-9_-]+$`
- 5 核心文件齐全(全小写,大小写敏感)
- `runs: []` / `scope: "user"` / `outputDir: "<runtime>"`
- artifacts 用纯字符串数组
- runtimeInputMeta 每个 key 在 runtimeInput 里声明
- verify.mjs FAIL 时输出裸数组(不是 `{"failures":[...]}`)
- skill.md 引用的 `$TASK_DIR/scripts/*` 都在 scripts/ 下存在

### ⑨ 真实样本(照着改)
内嵌最小样本(不依赖外部文件,见 §3/§4)。如果外部 agent 能访问 ugk 机器,可参考:
- 最简:`~/.pi/agent/tasks/bili-up-homepage-spider/`
- 完整:`~/.pi/agent/tasks/video-downloader/`(含 tests/eval.cases.json)
- 复杂 verify:`~/.pi/agent/tasks/ins-search/`

### ⑩ 铁律 + 反模式
- 别在 verify 里判 TASK_INPUT 字段是否存在(dispatcher 门禁已管)
- 别用 import.meta.url / __dirname(自检临时目录失效)
- 别 import 第三方 npm 包(无 node_modules)
- 别让 VerifyFailure 的 actual 塞对象(必须 string,JSON.stringify)
- artifacts 别用对象数组(用纯字符串)

---

## 3. 五件套字段规范(权威素材,直接抄进 ③)

> 以下所有规范都有代码佐证(见 §7 代码位置索引)。写 SKILL.md 时直接用这些表格和样本。

### 3.1 taskbook.json
**校验**:`isTaskbook`(`shared/taskbook-schema.js:28-40`)+ install 时 `taskbook.name === 目录名`(`bin/task-install.js:73`)。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 正则 `^[A-Za-z0-9_-]+$`,**必须等于目录名** |
| `description` | string | 是 | 任意非空描述 |
| `scope` | `"user"` \| `"project"` | 是 | 仅这两个值。user=全局,project=项目级 |
| `createdAt` | string(ISO) | 是 | ISO 8601 时间戳,新建时写当前时间 |
| `updatedAt` | string(ISO) | 是 | ISO 8601 时间戳,同 createdAt |
| `tags` | string[] | 否 | 可省略。特殊值 `"dedicated"` 由系统管理,别手写 |
| `runs` | array | 是 | **必须写 `[]`**(运行历史由系统填,publish 时会清空) |

**样本**:
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

### 3.2 spec.json
**校验**:`isRequirementsSpec`(`shared/taskbook-schema.js:42-54`)。

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| `goal` | string | 是 | 非空(trim 后 length > 0) |
| `hardConstraints` | string[] | 是 | 非空数组(length > 0) |
| `acceptance` | string[] | 是 | 非空数组(每条须机器可验) |
| `forbidden` | string[] | 否 | 省略合法,建议写全 |
| `context` | string | 否 | 省略合法 |

**样本**:
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

### 3.3 contract.json(字段最多,重点)
**校验**:`assertValidContract`(`shared/taskbook-schema.js:56-72`)。

| 字段 | 类型 | 必填 | 校验规则 |
|---|---|---|---|
| `outputDir` | string | 实际需要 | schema 不校验。约定写 `"<runtime>"`(ugk 运行时自动解析为产物目录) |
| `artifacts` | string[] | 实际需要 | **纯字符串数组**(如 `["media.json", "*.mp4"]`)。支持 glob。别用对象数组 |
| `runtimeInput` | string[] | 否 | 若存在必须是字符串数组 |
| `runtimeInputMeta` | object | 否 | 每个 key **必须在 runtimeInput 里声明**,否则报错。每个 value 是对象 |
| `requiredEnv` | string[] | 否 | 字符串数组(如 `["MIMO_API_KEY"]`) |
| `requiredTools` | string[] | 否 | 字符串数组(如 `["bash"]`,特殊值 `chrome_cdp` 开 CDP 隔离) |
| `requiredBinaries` | string[] | 否 | 字符串数组(如 `["yt-dlp","ffmpeg"]`,preflight 检查) |
| `maxRetry` | integer | 否 | 整数且 `>=0`。未声明默认 3。昂贵采集器写 0 |

**runtimeInputMeta 每个 key 的子字段**:

| 子字段 | 类型 | 作用 |
|---|---|---|
| `description` | string | 给 dispatcher LLM 看的字段说明 |
| `required` | boolean | **仅 `true` 才触发门禁**(缺了解析失败) |
| `default` | 任意 | 用户未提供时系统补此值 |
| `allowedValues` | (string\|number)[] | 该字段只能取其中之一 |

**样本(完整)**:
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

### 3.4 skill.md
worker 的执行手册。**关键约束**:
- **禁止包含验收逻辑**(那是 verify.mjs 的职责)
- 说清楚:做什么步骤、产物写到哪、用什么脚本
- 引用自带脚本用 `$TASK_DIR/scripts/xxx`(运行时 TASK_DIR 会被注入为 task 目录绝对路径)

### 3.5 verify.mjs
见 §4(单独章节,内容太多)。

---

## 4. verify.mjs 协议(权威素材,直接抄进 ④)

> 这是 SKILL.md 最关键的章节。外部 agent 写错 verify.mjs,task 直接废。所有断言有代码佐证。

### 4.1 运行时契约
verify.mjs 被执行时(等价于 `node /path/to/verify.mjs`,不带参数):

| 环境变量 | 类型 | 值 |
|---|---|---|
| `TASK_OUTPUT_DIR` | string | worker 产物目录的绝对路径 |
| `TASK_INPUT` | JSON 字符串 | `JSON.stringify(runtimeInput)`——dispatcher 算出的输入对象 |
| `TASK_DIR` | string | task 目录绝对路径(可读 scripts/)。**注意:有时不注入,读前必须判 undefined** |

**exit code 语义**:
- `exit 0` = PASS
- `exit 非 0`(含被信号杀死)= FAIL

**超时**:默认 30 秒,超时判 FAIL。verify.mjs 必须在 30s 内退出。

### 4.2 FAIL 时 stdout 必须的格式
**必须是裸的 `VerifyFailure[]` JSON 数组**,不是 `{"failures":[...]}`。

```js
// ❌ 错:包了一层
console.log(JSON.stringify({ failures: [...] }));

// ✅ 对:裸数组
console.log(JSON.stringify([...]));
```

VerifyFailure 字段:

| 字段 | 类型 | 必填 |
|---|---|---|
| `assertion` | string | 是(失败断言描述) |
| `expected` | string | 是(期望值) |
| `actual` | string | 是(实际值,**对象/数字必须 JSON.stringify**) |
| `hint` | string | 否(修复提示) |

### 4.3 完整骨架(可直接抄进 SKILL.md)
这是一份"保证过自检"的骨架,外部 agent 改改断言就能用:

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

### 4.4 TASK_INPUT 怎么读
`TASK_INPUT` 是 JSON 对象字符串,key 是 runtimeInput 字段名。**verify 只做产物语义校验,不重复输入校验**(dispatcher 门禁已保证 required 字段存在)。正确用法是"把 dispatcher 算的值跟产物里的对应字段比对":

```js
const taskInput = parseJsonText(process.env.TASK_INPUT || "{}", "TASK_INPUT") || {};
const url = String(taskInput.url ?? "");
// 比对:产物里的 url 字段应该等于 dispatcher 算的 url
if (url && data.url !== url) {
	fail("url matches TASK_INPUT.url", url, data.url, "worker must echo dispatcher url");
}
```

### 4.5 10 个易踩的雷(清单,直接抄)
1. FAIL 时 stdout 写 `{"failures":[...]}` → 必须裸数组
2. `actual` 塞对象/数字 → 必须 `JSON.stringify`
3. 用 `import.meta.url`/`__dirname` 定位文件 → 自检临时目录失效,改用 `TASK_OUTPUT_DIR`/`TASK_DIR`
4. import 第三方 npm 包 → 无 node_modules,只用 Node stdlib + 相对 import 自带 scripts/
5. 超过 30 秒 → 超时判 FAIL
6. 空目录不 FAIL → 自检会拒绝保存,每个 artifact 必须 existsSync 检查
7. 在 verify 里判 TASK_INPUT 字段是否存在 → 越界(dispatcher 门禁已管)
8. 依赖 `TASK_DIR` 不判空 → 有时不注入,必须 `if (process.env.TASK_DIR)` 判
9. 用 `require` 或省略 `.mjs` → ESM 下不工作
10. 忘了 `process.exit(0)`/`process.exit(1)` → exit code 是唯一判据

---

## 5. tests/ 子目录(权威素材,直接抄进 ⑤)

tests/ 下文件**全部随包发布**(ugk 的 publish 已放行 tests/)。

| 文件 | 什么时候写 | 外部能跑? |
|---|---|---|
| `eval.cases.json` | 有 runtimeInput、dispatcher 翻译有歧义时 | ❌ 外部跑不了(需 ugk runner + LLM),只产文件 |
| `verify.test.mjs` | task 有 verify.mjs 时 | ✅ 可用原生 node 跑(设环境变量) |
| `collect.test.mjs` | task 有 scripts/ 且脚本支持 UGK_COLLECTOR_SELFTEST 时 | ✅ 原生 node 跑 |

**eval.cases.json 结构**:
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

---

## 6. 验证(你写完 SKILL.md 后自查)

### 6.1 合规检查
- [ ] frontmatter 有 `name` + `description`,description 够 pushy
- [ ] 正文 <500 行(超了拆 references/)
- [ ] 中文为主 + 表格 + 代码块 + ❌/✅ 对比(参照 task-creator 风格)
- [ ] 目录:`user-skills/ugk-task-authoring/SKILL.md`

### 6.2 自包含检查(最关键)
通读 SKILL.md,确认:
- [ ] 不出现 `/task`、`run_task`、`dispatcher`(作为"你现在能用的工具"出现;作为"ugk 内部机制"解释可以)
- [ ] 不要求外部 agent 调用任何 ugk runtime
- [ ] 所有"ugk 会怎么做"都翻译成"你写文件时要这样"
- [ ] 自验清单全部用原生 node(不依赖 ugk)

### 6.3 准确性抽查
随机抽 3 个协议断言,对照本文档 §3/§4 确认一致(本文档的素材已由代码探查确认)。

---

## 7. 代码位置索引(给你追溯用,不用读)

| 内容 | 代码位置 |
|---|---|
| contract 校验 | `shared/taskbook-schema.js:56-72` |
| taskbook 校验 | `shared/taskbook-schema.js:28-40` |
| spec 校验 | `shared/taskbook-schema.js:42-54` |
| verify 运行时 | `extensions/task/task-verify.ts:52-106` |
| VerifyFailure 类型 | `extensions/task/task-book.ts:18-23` |
| 自检临时目录 | `extensions/task/task.ts:873-888` |
| skill 加载机制 | `extensions/index.ts:403-428` |
| 现有 task-creator 范本 | `skills/task-creator/SKILL.md`(420 行,风格参照) |
| skill-creator 规范 | `skills/skill-creator/SKILL.md:62-139` |

---

## 8. PR 规范

**PR title**:`docs(skill): 新增 ugk-task-authoring skill(给外部 agent 造 task)`

**commit message**:
```
docs(skill): 新增 ugk-task-authoring skill(给外部 agent 造 task)

自包含的 ugk task 规格书 + 作业 SOP,给外部 agent(codex/cursor 等)用。
外部 agent 贴进 prompt 后,能产出 ugk 兼容的、经过原生自验的高质量 task。

内容:五件套格式 + verify.mjs 协议 + tests/ + 标准作业流程 + 原生自验清单 + 交付检查 + 铁律。
不依赖 ugk runtime,纯文件操作 + 原生 node 自验。
```

---

## 9. 审核约定(给我审你时用)

我会查:
1. **合规性**:frontmatter / <500 行 / 风格一致性
2. **自包含性**:不依赖 ugk runtime(最关键)
3. **准确性**:verify 协议 / contract schema / 五件套字段 是否与代码一致(抽查 3 处)
4. **可读性**:外部 agent 只看这一份文档能不能造 task(模拟一个简单需求走一遍流程)
5. **verify 骨架**:是否可直接抄、是否覆盖空目录 FAIL / 裸数组 / exit code

按这个计划写,有问题随时问。
