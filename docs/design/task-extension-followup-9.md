# task-extension-followup-9 — dispatcher 翻译质量 eval 框架 + 空对象门禁修复

> **状态:已完成(2026-07-03)。** 新增通用 dispatcher eval 框架(补上翻译质量的测试盲区),并修复一个 dispatcher 在 required 全缺失时返回空对象绕过门禁的缺陷。eval 框架实测把 6 个 taskbook 的 dispatcher 准确率从 91% 提到 100%。`npm test` 603/603 pass。
>
> **更新时间**:2026-07-03

---

## 背景

### 盲区:dispatcher 翻译质量零覆盖

`tests/task-dispatcher.test.ts` 此前**全部用 mock 替身**(`setTaskDispatcherForTests`)短路 LLM 调用,只测机制层(门禁、回退、报错措辞、prompt 模板内容)。dispatcher 把自然语言翻译成 runtimeInput 的**真实翻译质量**没有任何自动化覆盖。

真实 bug 都是 dogfood 人肉抓的:
- dispatcher 算"上周"猜成 16 个月前(用训练数据日期)→ 加了注入当前日期
- `maxChars` vs `maxUnitChars` 未声明字段静默流到下游 → 加了 unknown-field gate

这些没有回归用例钉住。需要一个 eval 框架:用真实 LLM 跑一组真实用户表述,量化翻译准确率。

### 缺陷:required 全缺失时返回空对象绕过门禁

eval 实测发现:用户没给必填字段时(如"转写个视频"缺 file_path),dispatcher 返回空对象 `{}` 而非解析失败。

- prompt 第 51 行写了"required 无法确定就省略它,系统会判定为解析失败"
- 但 `parseCandidate`(`task-dispatcher.ts:64`)把 `{}` 当合法对象返回
- 冲突:dispatcher 确实省略了字段(遵守 prompt),但全 required 缺失时结果是 `{}`,机制层当"成功解析出 0 个字段"而非"解析失败"

生产环境 `coversRequired` 能兜住(headless 抛错、交互问询),但 `{}` 绕过了"解析失败"语义,反馈不清晰。

---

## 修复 1:dispatcher prompt 强化(task-dispatcher.ts)

`buildTaskDispatcherPrompt` 加一条明确指引:

> 如果用户输入完全缺少必要信息,导致所有 required 字段都无法确定,不要输出 JSON,也不要输出空对象,只输出一句简短的自然语言说明缺什么。

**为什么这么改**(而非改机制层):
- 不动 `coversRequired`/`parseCandidate`(它们工作正常,改了会影响所有 taskbook)
- `{}` 在合法场景(所有字段都有 default)是有效的,机制层不能特殊判定
- 给 dispatcher 一个可执行动作(不输出 JSON),`extractRuntimeInputFromText` 返回 undefined,机制层走"无有效输出"分支,语义干净

**影响范围**:prompt 层修复,所有 taskbook 受益。机制层逻辑零改动,生产环境行为不变。

---

## 修复 2:通用 dispatcher eval 框架

### 架构(通用,可插拔)

```
scripts/eval-dispatcher.mjs                    # 通用 runner(--task=<name>)
tests/fixtures/taskbooks/<name>/               # 可插拔 taskbook 样本
    contract.json + skill.md
tests/fixtures/dispatcher-evals/
    <name>.cases.json                          # 可插拔用例集(输入→期望+断言)
    <name>.report.json/.md  (gitignore,运行产物)
tests/task-dispatcher-eval.test.ts             # 离线单测(评判器+prompt 注入)
```

**通用性保证**:runner 只认两个文件路径模式,零 task 专属逻辑。新增一个 task 的 eval = 放 3 个 fixture 文件,runner 永不改。

### 关键设计:复用生产路径

eval **不重写**翻译逻辑,直接调用生产代码:
- `buildTaskDispatcherPrompt(skill, contract, rawInput)`(task-dispatcher.ts:15)→ 产 prompt
- `complete()`(真实 LLM 调用)
- `extractRuntimeInputFromText(text)`(task-dispatcher.ts:73)→ 解析输出

改 prompt / 改 contract 后跑 eval 立刻看到影响。

### 通用评判原语(cases 里用 JSON 声明)

| 原语 | 语义 | 核心用途 |
|---|---|---|
| `equals:<值>` | 严格相等 | 钉死精确翻译 |
| `path-equals:<值>` | 路径归一化(斜杠)后比较 | Windows 路径等价 |
| `omitted` / `absent` | 字段不存在 | **核心**:省略=走自动策略 |
| `present` | 字段存在且有效 | 只关心"有没有" |
| `in:a\|b\|c` | 枚举(支持 `omitted` 成员) | 允许多个正确答案 |

**为什么 `omitted` 是核心**:dispatcher 的"省略 vs 显式输出"对下游行为有本质影响(`runtimeInputWithDefaults` 用 `{...defaults, ...input}`)。video-downloader 的 maxHeight:省略=走 ladder-match 自动选档,显式 1080=走 specified-cap。这是所有 mock 测试测不到的。

**为什么 `path-equals` 必要**:Windows 上 dispatcher 可能把路径正斜杠翻成反斜杠(等价路径),严格 equals 误判。

### 运行模式

- `npm run eval:dispatcher -- --task=<name>`:手动跑真实 LLM,产 JSON+md 报告(花 token)
- **不进 `npm test`/CI**:真实 LLM 调用依赖网络和 API key
- 离线机制单测进 `npm test`:评判器正确性、prompt 注入、fixture 结构完整性

---

## eval 实测结果(6 个 taskbook)

首轮 eval 发现:5 个配音 task 各有 1 条 FAIL,全是同一根因(required 缺失返回 `{}`)。修复 prompt 后重跑:

| task | 修复前 | 修复后 |
|---|---|---|
| video-downloader | 10/14 (71%) | 14/14 (100%) |
| whisper-audio-to-text | 9/10 (90%) | 10/10 (100%) |
| subtitle-cleaner | 7/8 (88%) | 8/8 (100%) |
| subtitle-fluent-translator | 13/14 (93%) | 14/14 (100%) |
| subtitle-to-speech | 10/11 (91%) | 11/11 (100%) |
| video-zh-composer | 9/10 (90%) | 10/10 (100%) |

修复前后的差异主要来自两个修:(1) dispatcher prompt 空对象修复;(2) eval 框架自身的 `in:omitted`/`path-equals` 原语修正(首轮有误判)。

---

## 验收

- `npm test` 603/603 pass(新增 18 个 eval 框架单测 + 2 个 dispatcher prompt 单测)
- 6 个 taskbook 的真实 LLM eval 全部 100% 通过
- runner 零 task 专属逻辑(通用性硬指标)

---

## 文件清单

| 文件 | 改动 |
|---|---|
| `extensions/task/task-dispatcher.ts` | +1 行 prompt(空对象门禁修复) |
| `scripts/eval-dispatcher.mjs` | **新增** 通用 eval runner |
| `tests/task-dispatcher-eval.test.ts` | **新增** 离线单测(评判器+prompt 注入) |
| `tests/task-dispatcher.test.ts` | +2 个 prompt 措辞/行为单测 |
| `tests/fixtures/dispatcher-evals/*.cases.json` | **新增 6 个** 用例集 |
| `tests/fixtures/taskbooks/*/` | **新增 6 个** taskbook 快照 |
| `skills/task-creator/SKILL.md` | +26 行"自验 4:dispatcher eval"指引 |
| `package.json` | `eval:dispatcher` 脚本 |
| `.gitignore` | 排除 eval 报告产物 |

---

## spec 一致性

本次改动不涉及 `subtask-extension-spec.md` 的核心契约(dispatcher 数据流、函数签名、状态机均未变)。`buildTaskDispatcherPrompt` 是 prompt 内容调整(指导 LLM 行为),不改变机制层契约。spec 第 42 行"dispatcher 翻不出来就返回错误,让 LLM 改"的契约反被本次修复强化。

eval 框架是开发者工具,不影响 task 四阶段创造/复用流程,`task-extension-spec.md` 无需同步。
