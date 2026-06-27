---
name: task-creator
description: Use when the user wants to turn an existing skill, script, or capability into a reusable /task taskbook ("把这个做成 task"), or asks where taskbooks live, how to create one, what files a taskbook needs, or why a task was/wasn't found. Teaches the exact storage location, the five-file format, and the standard creation flow — so you never need to grep the repo to discover any of it.
---

# Task Creator 指南

把一个已有能力（skill / 脚本 / 抓取流程）封装成可复用的 `/task` taskbook。
**这份指南告诉你存放位置、五件套格式、标准流程——不需要满仓 grep 去找。**

## 存放位置（最关键，别再乱找）

taskbook 只有两个 scope，目录就是固定的，别猜、别 find：

| scope | 目录 | 用途 |
|---|---|---|
| **user**（默认） | `~/.pi/agent/tasks/<name>/` | 跟用户走，所有项目可用 |
| **project** | `<cwd>/.tasks/<name>/` | 跟项目走，只在当前项目可用 |

- `<name>` 用 kebab-case，简短达意，如 `x-search-latest`、`bili-up-homepage-spider`。
- 创建前先 `ls ~/.pi/agent/tasks/` 看已有样本（照一个真实样本改，比凭空捏造靠谱）。
- **不要**放到 `~/.agents/`、`~/.pi/agent/skills/`、或任何 `skills/` 目录下——那是 skill 的地方，不是 taskbook 的。taskbook 和 skill 是两回事。

## 五件套格式（照真实样本）

一个 taskbook 是一个目录，下面五个文件，缺一不可。字段都从真实运行过的 taskbook 提取，照着填：

### 1. `taskbook.json` — 索引（运行记录自动追加，创建时写头部即可）
```json
{
  "name": "bili-up-homepage-spider",
  "description": "一句话说清这个 task 干什么：给定什么输入，产出什么",
  "scope": "user",
  "createdAt": "2026-06-25T13:37:50.857Z",
  "tags": ["bilibili", "scraper"],
  "runs": []
}
```
> `runs` 数组由 `/task run` 自动写入，创建时留空 `[]`。

### 2. `spec.json` — RequirementsSpec（给 worker 的需求）
```json
{
  "goal": "给定 X，产出 Y，保存为 Z",
  "hardConstraints": ["硬性约束1", "链接格式必须是 ..."],
  "acceptance": ["验收项1：程序能从输入提取 ...", "输出文件为有效 JSON"],
  "forbidden": ["不要做 ...", "不要过度请求避免被封"],
  "context": "实现提示：可以先用 HTTP，失败再用 CDP；时间格式需补全等"
}
```

### 3. `contract.json` — 契约（输入输出 + 依赖工具）
```json
{
  "outputDir": "<runtime>",
  "artifacts": ["output_page{page}.json"],
  "runtimeInput": ["keyword", "days"],
  "runtimeInputMeta": {
    "keyword": { "description": "搜索关键词", "required": true },
    "days": { "description": "最近 N 天", "required": false, "default": 30 }
  },
  "requiredTools": ["chrome_cdp"]
}
```
> - `outputDir` 固定写 `"<runtime>"`，由系统在运行时注入实际输出目录。
> - `runtimeInput` 是**外部每次运行传入的参数名**，参数化任务全靠它。
> - `requiredTools` 填 worker 需要的受保护工具（如 `chrome_cdp`），没有就空数组。

### 4. `skill.md` — worker 执行指令
写清楚 worker 拿到参数后**具体怎么做**：输入字段、执行命令、输出文件名、输出 JSON 结构、技术要点。这是 worker agent 的操作手册。

### 5. `verify.mjs` — 机器验收脚本
**契约**：用 `TASK_INPUT`（JSON 环境变量，含 runtimeInput）和 `TASK_OUTPUT_DIR`（输出目录）校验产物。
- 失败：`console.log(JSON.stringify(failures, null, 2))` + `process.exit(1)`
- 通过：`console.log("PASS")` + `process.exit(0)`
- `failures` 是数组，每项 `{ assertion, expected, actual, hint }`

骨架：
```js
import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const failures = [];
function fail(assertion, expected, actual, hint) {
  failures.push({ assertion, expected, actual, hint });
}

const taskInput = JSON.parse(process.env.TASK_INPUT || "{}");
const taskOutputDir = process.env.TASK_OUTPUT_DIR || ".";
// ... 校验产物 ...

if (failures.length > 0) {
  console.log(JSON.stringify(failures, null, 2));
  process.exit(1);
} else {
  console.log("PASS");
  process.exit(0);
}
```

## 标准创建流程（5 步，替代满仓乱扫）

1. **读源能力** — 读要封装的 skill/脚本本体，搞懂它接受什么、产出什么。只读这一个目录，别扩散。
2. **定参数** — 哪些值每次运行会变？把它们定为 `contract.json` 的 `runtimeInput`。固定值写进脚本/spec，别参数化。
3. **照样本写五件套** — `ls ~/.pi/agent/tasks/` 找一个**真实样本**对照，按上面格式填五个文件。
4. **手验 verify.mjs** — 自己设 `TASK_INPUT` / `TASK_OUTPUT_DIR` 环境变量跑一遍 verify，确认它真能判对错。这步省不得，验收脚本错了 task 永远过不了或假通过。
5. **落盘 + 试跑** — 五件套写到 scope 目录，`/task run <name> <自然语言输入>` 试一次，看 PASS。

## 铁律

- **taskbook 是最小单位，不可嵌套**。一个 taskbook = 一个原子任务。
- **参数只从 `runtimeInput` 进**。固定逻辑写进 skill.md/脚本，不要把"每次都一样的值"也参数化。
- **verify 是机器验收，不是人**。它只能看文件内容/格式，不能看"做得好不好看"。验收项要可机器判定。
- **`/task run` 的输入是自然语言**，dispatcher agent 会把它翻译成 `runtimeInput` 的值。contract.json 的 `runtimeInputMeta.description` 要写得让翻译不会出错。
- **需求驱动匹配**：别为了"凑 taskbook"而封装。只有这个能力会被**多次、参数化地**复用时，才值得做成 task。

## 反模式（别这么干）

- ❌ 满仓 `find **/*task*` 找 taskbook 存哪 —— 位置就在上面的表格里。
- ❌ 读 ugk-core 的 `task-guide.ts` 想搞懂"怎么创建" —— 那是"导览**已有** taskbook"的，不是创建指南。
- ❌ 凭空捏造五件套格式 —— 先 `ls ~/.pi/agent/tasks/` 找真实样本。
- ❌ 把 taskbook 放进 skills/ 目录 —— skill 和 taskbook 是两个系统，位置不同。
