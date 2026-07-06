# Task-creator 测试管道打通 — 行动计划

> **给执行者(同事)**:这是继"task 测试随包迁移"之后的收尾改动。上次把测试资产迁进 task 包,这次让 **task 创建流程能自动产出 tests/**,并打通 reviewer→落盘 的管道。
> **方案**:混合方案——打通管道(必做)+ SKILL.md 加章节(必做),**不**加 TEST DESIGN GATE 问卷(不做)。
> **基线**:main = `cd5b6ff`。

---

## 0. 背景与方案选择

### 0.1 为什么做这件事
上次"task 测试随包迁移"完成了结构定义和存量迁移,但**新建 task 仍不会自动产 tests/**。task-creator SKILL.md 里只在"自验 4"顺带提了 `tests/eval.cases.json`,完全没提 `verify.test.mjs` / `collect.test.mjs`。这是文档脱节 + 管道缺失。

### 0.2 方案:混合(给能力,不给强制)
- ✅ **打通管道**:reviewer 能产 `tests` 字段 → 解析 → saveTaskbook 落盘 `tests/` 目录
- ✅ **SKILL.md 加章节**:告诉 agent/人"还能为 task 补这些测试",给代码模板
- ❌ **不加 TEST DESIGN GATE 问卷**:简单 task(只有 contract+skill)创建时不被打扰,复杂 task agent 自己判断

**哲学**:不加无用抽象(GATE 对简单 task 是负担),但补齐真实缺口(管道+文档)。

### 0.3 不做什么(明确边界)
- ❌ 不改 loadFromDir / LoadedTaskbook(tests/ 是磁盘资产,和 scripts/ 一致,不进内存模型)
- ❌ 不改 publish / install / marketplace(管道已 agnostic,上次验证过)
- ❌ 不改 worker / verify 引擎(它们通过 TASK_DIR 引用,不扫目录)
- ❌ 不加 TEST DESIGN GATE(不强制问)

---

## 1. 改动清单(4 文件,7 注入点)

按数据流顺序,从类型定义到落盘:

### 改动 1:`extensions/task/task-state.ts` — 类型定义
**位置**:`TaskReviewResult` interface(当前 L6-12)

**当前**:
```ts
export interface TaskReviewResult {
	description: string;
	skill: string;
	verify: string;
	contract: unknown;
	tags?: string[];
}
```

**改为**(加一个可选 tests 字段):
```ts
export interface TaskReviewResult {
	description: string;
	skill: string;
	verify: string;
	contract: unknown;
	tags?: string[];
	/** task 自带测试资产(文件名→内容),落盘到 tests/ 子目录。可选,无则不写 tests/。 */
	tests?: Record<string, string>;
}
```

**要点**:`tests` 必须可选(`?`),否则破坏所有旧 reviewResult 的兼容。

---

### 改动 2:`extensions/task/task-prompts.ts` — 两处

#### 2a. `normalizeTaskReviewResult` 返回类型 + 解析(L111-134)

**当前返回类型**(L111-117)是内联字面量,和 TaskReviewResult 同形但双源:
```ts
function normalizeTaskReviewResult(value: unknown): {
	description: string;
	skill: string;
	verify: string;
	contract: unknown;
	tags?: string[];
} | undefined {
```

**改为**(返回类型加 tests,函数体加解析):
```ts
function normalizeTaskReviewResult(value: unknown): {
	description: string;
	skill: string;
	verify: string;
	contract: unknown;
	tags?: string[];
	tests?: Record<string, string>;
} | undefined {
```

函数体里(在 return 前)加 tests 解析,容错风格参照 tags:
```ts
	// tests:必须是 plain object 且所有 value 是 string,否则 undefined(容错,不硬 fail)
	let tests: Record<string, string> | undefined;
	if (record.tests && typeof record.tests === "object" && !Array.isArray(record.tests)) {
		const entries = Object.entries(record.tests as Record<string, unknown>);
		const allStringVals = entries.every(([, v]) => typeof v === "string");
		if (allStringVals && entries.length > 0) {
			tests = Object.fromEntries(entries) as Record<string, string>;
		}
	}
```

return 对象里加 `tests,`。

**要点**:
- 容错优先:非 object 或 value 含非 string 时降级 `undefined`,不抛错(参照 tags 处理)
- 路径穿越防护放在 saveTaskbook(改动 3),这里只做类型校验

#### 2b. `TASK_REVIEW_PROMPT` 的 JSON 示例(L67-82)

**当前** prompt 末尾要求 reviewer 输出固定 schema JSON。在 JSON 示例里加可选 tests 字段:

```json
{
	"description": "...",
	"tags": [...],
	"skill": "...",
	"verify": "...",
	"contract": {...}
}
```

**改为**(加 tests 可选示例):
```json
{
	"description": "...",
	"tags": [...],
	"skill": "...",
	"verify": "...",
	"contract": {...},
	"tests": {
		"verify.test.mjs": "import ... test('verify passes on sample', ...) ..."
	}
}
```

在 prompt 步骤说明里(第 6 步 verify.mjs 之后)加一段:
```
7. (可选)如果该 task 有 verify.mjs,推荐补 tests/verify.test.mjs——用 runVerify 跑包内 verify.mjs,测 PASS 样本(合格产物)和 FAIL 样本(空/缺字段)。key 是相对 tests/ 的文件名(如 "verify.test.mjs"),value 是文件全文。有 scripts/ 且脚本支持 UGK_COLLECTOR_SELFTEST 时同理补 tests/collect.test.mjs。简单 task(无 verify.mjs)可跳过。
```

**要点**:
- 标注"可选",不强制
- 给明确触发条件("有 verify.mjs" → 补 verify.test.mjs)
- 引用 SKILL.md 的模板(避免 prompt 太长)

---

### 改动 3:`extensions/task/task-book.ts` — saveTaskbook 落盘(L126-157)

**当前** data 入参(L127-133)和 Promise.all(L149-155)写 5 核心文件。

**改为**:
1. data 入参类型加 `tests?: Record<string, string>`
2. 在 Promise.all 之后加 tests 落盘逻辑:

```ts
// tests/ 子目录(可选,task 自带测试资产)。路径穿越防护:key 不含 .. / 非绝对路径。
if (data.tests && Object.keys(data.tests).length > 0) {
	const testsDir = path.join(dir, "tests");
	await mkdir(testsDir, { recursive: true });
	await Promise.all(Object.entries(data.tests).map(async ([fname, content]) => {
		// 防 .. 穿越 和绝对路径(Windows/Unix)
		if (fname.includes("..") || path.isAbsolute(fname) || path.win32.isAbsolute(fname)) {
			throw new Error(`Invalid tests filename: ${fname}`);
		}
		await writeFile(path.join(testsDir, fname), content, "utf8");
	}));
}
```

**要点**:
- **路径穿越防护必做**(reviewer 产出的 key 不能写任意文件)
- 用 `Promise.all` 并发写(和 5 核心文件风格一致)
- tests/ 目录只在有 tests 时创建(无 tests 不建空目录)

---

### 改动 4:`extensions/task/task.ts` — 两处 saveTaskbook 调用(L2097-2104, L2121-2128)

**当前**两处构造 saveTaskbook 入参,手 spread reviewResult 字段(没用 `{...state.reviewResult}`):

```ts
await saveTaskbook(scope, cwdOf(ctx), finalName.trim(), {
	description: state.reviewResult.description,
	spec: state.spec,
	skill: state.reviewResult.skill,
	verify: state.reviewResult.verify,
	contract: state.reviewResult.contract,
	tags: state.reviewResult.tags,
});
```

**改为**(两处都加一行 `tests:`):

```ts
await saveTaskbook(scope, cwdOf(ctx), finalName.trim(), {
	description: state.reviewResult.description,
	spec: state.spec,
	skill: state.reviewResult.skill,
	verify: state.reviewResult.verify,
	contract: state.reviewResult.contract,
	tags: state.reviewResult.tags,
	tests: state.reviewResult.tests,
});
```

**要点**:**两处都要改**(L2097 分支 A 无 outputDir 更新 + L2121 分支 B 正式落盘),否则两条路径行为不一致。

---

### 改动 5:`skills/task-creator/SKILL.md` — 加 tests/ 章节

**插入位置**:L304 之后("五件套格式"末尾)、L305 之前("标准创建流程")。

**新章节**(仿现有括号副标题风格,中文,表格+代码块):

```markdown
## tests/ 子目录(可选,给 task 补开发期测试)

task 包可以自带开发期测试资产,随包发布、随包安装,不阻断 /task run。runner 按文件存在性自动识别能跑哪些。结构规范见 `docs/design/task-package-structure.md`。

| 文件 | 什么时候写 | 跑法 | 进 CI? |
|---|---|---|---|
| `tests/eval.cases.json` | 有 runtimeInput、dispatcher 翻译有歧义时 | `npm run eval:dispatcher -- --task=<name>` | ❌ 需 LLM |
| `tests/verify.test.mjs` | task 有 verify.mjs 时 | `node --test tests/verify.test.mjs`(仓库根跑) | ✅ 纯本地 |
| `tests/collect.test.mjs` | task 有 scripts/ 且脚本支持 UGK_COLLECTOR_SELFTEST 时 | `node tests/collect.test.mjs` | ⚠️ 依赖外部环境时本地 |
| `tests/samples/` | verify.test.mjs 的测试样本 | 被 verify.test.mjs 引用 | — |

### verify.test.mjs:验 verify.mjs 自己判得对

用 `runVerify`(`extensions/task/task-verify.ts`)跑包内 verify.mjs,至少覆盖 PASS 样本(合格产物→exit 0)+ FAIL 样本(空/缺字段→exit 1 + failures)。

最小骨架(完整模板见 `docs/handoff/2026-07-06-task-tests-migration.md` §2.2):
```javascript
import { runVerify } from "<仓库根>/extensions/task/task-verify.ts";
import path from "node:path";
const VERIFY_PATH = path.join(process.env.TASK_DIR || "<包绝对路径>", "verify.mjs");
test("verify passes on valid sample", async () => { /* 构造合格产物,断言 passed:true */ });
test("verify fails on empty output", async () => { /* 空产物,断言 passed:false */ });
```

### collect.test.mjs:脚本冒烟

前提:scripts/ 脚本支持 `UGK_COLLECTOR_SELFTEST=1` 自检模式。联网 collector 不支持就跳过,别假冒烟。
```bash
UGK_COLLECTOR_SELFTEST=1 node "$TASK_DIR/scripts/collect.mjs"   # 期望 stdout 含 PASS, exit 0
```

### 什么时候不写
- 简单 task(无 verify.mjs 无 scripts/)→ 只可能写 eval.cases.json
- 脚本无自检入口 → 跳过 collect.test.mjs
- 创建流程不强制补 tests/,但 reviewer 会按 SKILL.md 判断是否顺手补
```

然后在"标准创建流程"(L305-311)的第 3 步末尾加一句呼应:
```
有 verify.mjs / scripts/ 的,可选顺手补 tests/(见上方"tests/ 子目录"),不阻断创建。
```

---

## 2. 验证步骤

### 2.1 单元测试
```bash
cd E:/AII/ugk-core
npm test
# 期望:681 pass / 0 fail(基线不变,因为 tests 字段是可选的,旧 reviewResult 不带 tests 仍正常)
```

### 2.2 新增测试(建议补,保护新逻辑)
在 `tests/task-extension.test.ts` 或新建 `tests/task-book-tests.test.ts` 加:
- `saveTaskbook` 带 tests 入参时,落盘 tests/ 目录且文件内容正确
- `saveTaskbook` 不带 tests 时,不创建 tests/ 目录
- tests filename 含 `..` 或绝对路径时抛错(路径穿越防护)
- `normalizeTaskReviewResult` 解析 tests 字段(合法/非法/缺失三种)

### 2.3 端到端验证
造一个带 verify.mjs 的 task,走完创建流程,确认:
1. reviewer 产出含 tests 字段(看 agent_end 解析后 state.reviewResult.tests)
2. saveTaskbook 后,task 包内出现 tests/verify.test.mjs
3. `node --test <taskdir>/tests/verify.test.mjs` 能跑通

---

## 3. PR 规范

**PR title**:`feat(task): 打通 task-creator 测试管道 + SKILL.md 补 tests 章节`

**commit message 模板**:
```
feat(task): 打通 task-creator 测试管道 + SKILL.md 补 tests 章节

混合方案:给能力(管道),不给强制(不加 TEST GATE 问卷)。

管道打通(reviewer → 落盘):
- TaskReviewResult 加可选 tests 字段(task-state.ts)
- normalizeTaskReviewResult 解析 tests,容错处理(task-prompts.ts)
- TASK_REVIEW_PROMPT 加可选 tests 示例 + 第 7 步说明(task-prompts.ts)
- saveTaskbook 落盘 tests/ 子目录,含路径穿越防护(task-book.ts)
- 两处 saveTaskbook 调用传 tests 字段(task.ts)

文档引导:
- SKILL.md 加"tests/ 子目录"章节(五件套后、标准流程前)
- 标准创建流程第 3 步加呼应

不做(边界):
- 不改 loadFromDir/LoadedTaskbook(tests 是磁盘资产,和 scripts 一致)
- 不改 publish/install(管道已 agnostic)
- 不加 TEST DESIGN GATE 问卷(简单 task 不被打扰)
```

---

## 4. 风险与对抗审查要点(给审核者)

1. **路径穿越防护**:saveTaskbook 的 tests filename 必须防 `..` 和绝对路径。这是 reviewer 产出(半受信),不能写任意文件。审核时看测试是否覆盖。
2. **双源类型同步**:`normalizeTaskReviewResult` 返回类型(内联字面量)和 `TaskReviewResult` interface 必须同步加 tests,否则类型不匹配。
3. **两处调用同步**:task.ts L2097 和 L2121 两处 saveTaskbook 调用都要加 tests,否则更新场景漏写。
4. **可选性**:tests 必须处处可选(`?`),旧 reviewResult 不带 tests 时整个流程仍正常。npm test 基线 681 不变。
5. **容错**:normalizeTaskReviewResult 解析 tests 时,非法值降级 undefined,不抛错(参照 tags)。

---

## 5. 进度跟踪

- [x] 改动 1:task-state.ts 加 tests 字段
- [x] 改动 2a:task-prompts.ts normalizeTaskReviewResult 解析 tests
- [x] 改动 2b:task-prompts.ts TASK_REVIEW_PROMPT 加示例 + 第 7 步
- [x] 改动 3:task-book.ts saveTaskbook 落盘 tests/(含路径防护)
- [x] 改动 4:task.ts 两处 saveTaskbook 调用传 tests
- [x] 改动 5:SKILL.md 加 tests/ 章节
- [x] 新增测试(saveTaskbook tests 落盘 + 路径防护 + normalize 解析)
- [x] npm test 683 total / 681 pass / 2 skipped / 0 fail
- [ ] 端到端验证(造 task 走完流程)
- [ ] PR 提交

---

## 6. 关键文件指针

| 想了解 | 看哪 |
|---|---|
| tests/ 结构规范 | `docs/design/task-package-structure.md` |
| 测试代码模板 | `docs/handoff/2026-07-06-task-tests-migration.md` §2.2/§2.3 |
| 现有 reviewer prompt | `extensions/task/task-prompts.ts:46-84`(TASK_REVIEW_PROMPT) |
| 现有 SKILL/VERIFY GATE 范式 | `task-prompts.ts:54,58`(若以后想加 TEST GATE 仿这里) |
| saveTaskbook 当前实现 | `extensions/task/task-book.ts:126-157` |
| publish 放行 tests/ | `extensions/task/task-share-publish.ts:48`(已验证,不用改) |

按这个计划做,做完叫我审。
