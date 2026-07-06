# Task 测试随包迁移 — 整改执行计划

> **给执行者(同事)**:本文件是你的工作清单。按批次顺序做,每个 task 走"单 task 操作模板"。做完一批让我(agent)审核。
> **背景**:见 `docs/design/task-package-structure.md`(结构规范,已合入 main `313ef3a`)。
> **样板**:`video-downloader` 已迁完(批次 1 第 1 个),作为参考样板。
> **基线**:main = `313ef3a`(refactor(task): 定义 task 包 tests/ 结构 + 引擎单测解耦真实 fixture)。

---

## 0. 你需要先知道的

### 0.1 为什么做这件事
task 是可插拔功能包,但它的开发期测试原来散落在仓库根 `tests/fixtures/` 下,和 task 本体分居两个目录。现在定义了新结构:测试收进 task 包内 `tests/` 子目录,随包发布、随包安装。本次只迁测试,**不动 task 本体**(contract/skill/verify/scripts 原地不动)。

### 0.2 新结构(目标)
```
<taskbook-name>/
├── taskbook.json / spec.json / skill.md / verify.mjs / contract.json   # 不动
├── scripts/                                                              # 不动
└── tests/                  ← 你要创建/填充的
    ├── eval.cases.json     #   从 tests/fixtures/dispatcher-evals/<name>.cases.json 复制来
    ├── verify.test.mjs     #   新写(只针对有 verify.mjs 的 task)
    ├── collect.test.mjs    #   新写(只针对有 scripts/ 的 task,冒烟测试)
    └── samples/            #   可选,verify.test.mjs 的测试样本
```

### 0.3 两个目录的关系
- **task 包本体**:`~/.pi/agent/tasks/<name>/`(user scope,gitignored,你本地已装的)
- **仓库 fixture 副本**:`tests/fixtures/taskbooks/<name>/`(进 git,是测试资产副本)

**本次迁移**:把仓库 fixture 里的 eval cases **复制**到 task 包本体的 `tests/` 子目录;为有 verify.mjs 的 task **新建** verify 逻辑测试。**仓库 fixture 副本最后统一清理(批次 3),迁移期间保留。**

---

## 1. 待迁清单(11 个 task,3 批次)

### 批次 1:简单 task(5 个)— 只迁 eval cases
这些 task 只有 contract+skill(无 verify.mjs,无 scripts/),迁移工作 = 复制 eval cases 到包内。

| # | task | 包内现状 | 动作 |
|---|---|---|---|
| ✅ | video-downloader | 已迁(样板) | — |
| 1 | subtitle-cleaner | contract+skill | 复制 eval.cases.json |
| 2 | subtitle-fluent-translator | contract+skill | 复制 eval.cases.json |
| 3 | subtitle-to-speech | contract+skill | 复制 eval.cases.json |
| 4 | video-zh-composer | contract+skill | 复制 eval.cases.json |
| 5 | whisper-audio-to-text | contract+skill | 复制 eval.cases.json |

### 批次 2:完整 task(6 个糖尿病)— eval cases + verify 测试 + collect 冒烟
这些 task 有 verify.mjs + scripts/,除了迁 eval cases,还要新写 verify 逻辑测试和 collect 冒烟测试。

| # | task | 包内现状 | 动作 |
|---|---|---|---|
| 6 | medical-diabetes-news | contract+skill+verify+scripts/collect.mjs | eval + verify.test + collect 冒烟 |
| 7 | diabetes-device-regulatory-signals | contract+skill+verify+scripts/collect.mjs | eval + verify.test + collect 冒烟 |
| 8 | diabetes-device-custom-source-news | contract+skill+verify+scripts/collect.mjs | eval + verify.test + collect 冒烟 **(特殊:含回收的引擎测试,见 §3)** |
| 9 | diabetes-news-report-packager | contract+skill+verify+scripts/pack.mjs | eval + verify.test + pack 冒烟 |
| 10 | diabetes-news-report-renderer | contract+skill+verify+scripts/render.mjs | eval + verify.test + render 冒烟 |
| 11 | diabetes-news-report-translator | contract+skill+verify+scripts/build+prepare.mjs | eval + verify.test + build 冒烟 |

### 批次 3:清理(所有 task 迁完后)
- 删 `tests/fixtures/taskbooks/` 和 `tests/fixtures/dispatcher-evals/` 目录
- 删 `scripts/eval-dispatcher.mjs` 的 `--legacy-fixtures` flag 及相关 fallback 代码
- 更新 `docs/design/task-package-structure.md` 状态为"迁移完成"

---

## 2. 单 task 操作模板(照做)

### 2.1 所有 task 都做:迁 eval cases
```bash
# 1. 确认 task 已安装(user scope)
TASK_DIR=~/.pi/agent/tasks/<name>
ls "$TASK_DIR/contract.json"   # 必须存在

# 2. 建 tests/ 目录,复制 eval cases
mkdir -p "$TASK_DIR/tests"
cp tests/fixtures/dispatcher-evals/<name>.cases.json "$TASK_DIR/tests/eval.cases.json"

# 3. 验证 eval runner 能从包内读 cases(不需要全跑通,能加载即可)
#    (需要 LLM API key;无 key 会跑到调模型那步失败,但路径解析正确就说明 cases 迁对了)
npm run eval:dispatcher -- --task=<name>
#    期望输出: [eval] task=<name> 包=<TASK_DIR> cases=N 解析 model...
#    报告应写到 $TASK_DIR/tests/eval.report.md
```

### 2.2 有 verify.mjs 的 task 额外做:写 verify 逻辑测试
在 `$TASK_DIR/tests/verify.test.mjs` 新建,用 `runVerify` 跑包内 verify.mjs,测 PASS 路径和 FAIL 路径。

**模板**(参照原 `tests/task-verify.test.ts` 删掉的测试逻辑,改成包内路径):
```javascript
import { runVerify } from "<仓库根>/extensions/task/task-verify.ts";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";

const TASK_DIR = "<本 task 包绝对路径>";  // 如 ~/.pi/agent/tasks/medical-diabetes-news
const VERIFY_PATH = path.join(TASK_DIR, "verify.mjs");

test("verify passes on valid sample output", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "verify-"));
  try {
    // 构造一份合格的产物样本(参照该 task 的 contract.artifacts 和 verify.mjs 期望)
    await writeFile(path.join(outputDir, "<artifact-name>"), JSON.stringify({ /* 合格内容 */ }));
    const result = await runVerify({ verifyPath: VERIFY_PATH, outputDir, input: { /* runtime input */ } });
    if (!result.passed) console.error(result.failures);
    assert.equal(result.passed, true);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("verify fails on empty output", async () => {
  const outputDir = await mktemp(path.join(os.tmpdir(), "verify-"));
  try {
    const result = await runVerify({ verifyPath: VERIFY_PATH, outputDir, input: {} });
    assert.equal(result.passed, false);
    assert.ok(result.failures.length > 0);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
```

**怎么构造合格样本**:看该 task 的 `contract.json` 的 `artifacts` 字段(产物文件名)和 `verify.mjs`(它检查什么)。合格样本要满足 verify 的所有断言。**最简单办法**:翻 git 历史找该 task 的真实运行产物,或让 task 跑一次拿真实产物当样本。

### 2.3 有 scripts/ 的 task 额外做:写脚本冒烟测试
在 `$TASK_DIR/tests/collect.test.mjs`(或 pack/render/build,按脚本名)新建,用 `UGK_COLLECTOR_SELFTEST=1` 跑脚本,断言基本路径通。

**模板**(参照原 `tests/task-collector-scripts.test.ts`):
```javascript
import { spawnSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const TASK_DIR = "<本 task 包绝对路径>";
const SCRIPT = path.join(TASK_DIR, "scripts", "collect.mjs");  // 按实际脚本名改

test("collector self-test passes", () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, UGK_COLLECTOR_SELFTEST: "1" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS/);
});
```

**前提**:该 task 的 scripts/ 脚本必须支持 `UGK_COLLECTOR_SELFTEST=1` 自检模式(输出 PASS)。如果不支持,跳过此项并在 PR 里说明。

---

## 3. 特殊任务:diabetes-device-custom-source-news(回收引擎测试)

本次重构从引擎单测里删了两个测试,它们的逻辑要落到这个 task 包内:

1. **`tests/task-verify.test.ts` 删掉的** "custom-source verify tolerates one failed CDP source" 测试
   - 喂一份手工构造的 `diabetes_device_custom_source_news.json`(6 个 source,1 个失败 5 个有 items)
   - 断言 verify.mjs 仍判 PASS(CDP 容错)
   - **落地位置**:`~/.pi/agent/tasks/diabetes-device-custom-source-news/tests/verify.test.mjs`
   - **样本数据**:见 git 历史 `313ef3a^` 的 `tests/task-verify.test.ts:103-165`,完整构造数据在测试代码里

2. **`tests/task-collector-scripts.test.ts` 整文件删掉的** collector 冒烟测试
   - 跑 `UGK_COLLECTOR_SELFTEST=1` collect.mjs,断言 PASS
   - **落地位置**:`~/.pi/agent/tasks/diabetes-device-custom-source-news/tests/collect.test.mjs`

**git 命令取回原测试代码**:
```bash
# 取 task-verify.test.ts 删掉的测试逻辑
git show 313ef3a^:tests/task-verify.test.ts | sed -n '103,165p'   # custom-source 那段
# 取 task-collector-scripts.test.ts 全文
git show 313ef3a^:tests/task-collector-scripts.test.ts
```

---

## 4. 验证(每个 task 迁完后自查)

```bash
# 1. 包内 tests/ 结构完整
ls "$TASK_DIR/tests/"

# 2. eval cases 能被 runner 加载(路径解析正确)
npm run eval:dispatcher -- --task=<name>
# 期望: [eval] task=<name> 包=<TASK_DIR> cases=N ...

# 3. 若写了 verify.test.mjs,手动跑一下
cd <仓库根> && node --test "$TASK_DIR/tests/verify.test.mjs"
# 注意:verify.test.mjs import 仓库的 task-verify.ts,需在仓库根跑

# 4. 全量引擎测试不受影响
cd <仓库根> && npm test
# 期望: 681 pass / 0 fail(基线不应因 task 迁移而变化,因为引擎已解耦)
```

---

## 5. PR 提交规范

每个批次一个 PR,或全部做完一个 PR(你定)。**注意:task 包本体在 `~/.pi/agent/tasks/`(gitignored),不进 git**。所以 PR 只包含:

- **批次 1/2**:理论上无 git 改动(task 包本体 gitignored,仓库 fixture 副本迁移期间保留)
  - 如果你想让已迁的 task 测试样本进 git 供他人参考,可在 `tests/fixtures/taskbooks/<name>/tests/` 也放一份副本,但**非必需**
  - 建议做法:每迁完一个 task,在本文件 §6 表格打勾,PR 只改这一个 md 文件记录进度
- **批次 3**:删 `tests/fixtures/taskbooks/` + `tests/fixtures/dispatcher-evals/` + 删 `--legacy-fixtures` 代码,这是真实 git 改动

**PR title 建议**:
- 批次 1:`chore(task): 迁移批次1 task eval cases 到包内 tests/`
- 批次 2:`chore(task): 迁移批次2 糖尿病 task 测试到包内 tests/`
- 批次 3:`chore(task): 清理旧 fixture 目录 + 移除 --legacy-fixtures`

---

## 6. 进度跟踪表(执行者打勾用)

### 批次 1(简单 task)
- [x] video-downloader(样板,已验证)
- [ ] subtitle-cleaner
- [ ] subtitle-fluent-translator
- [ ] subtitle-to-speech
- [ ] video-zh-composer
- [ ] whisper-audio-to-text

### 批次 2(糖尿病 task)
- [ ] medical-diabetes-news
- [ ] diabetes-device-regulatory-signals
- [ ] diabetes-device-custom-source-news(**含回收的引擎测试,见 §3**)
- [ ] diabetes-news-report-packager
- [ ] diabetes-news-report-renderer
- [ ] diabetes-news-report-translator

### 批次 3(清理)
- [ ] 删 `tests/fixtures/taskbooks/`
- [ ] 删 `tests/fixtures/dispatcher-evals/`
- [ ] 删 `scripts/eval-dispatcher.mjs` 的 `--legacy-fixtures`
- [ ] 更新 `docs/design/task-package-structure.md` 状态

---

## 7. 常见问题

**Q: task 包本体 gitignored,我怎么让同事看到我写的 verify.test.mjs?**
A: 两选一:(1)把它发布到 marketplace,publish 现在放行 tests/ 子目录,同事 install 即得;(2)在仓库 `tests/fixtures/taskbooks/<name>/tests/` 放一份副本进 git。建议优先 (1),marketplace 是 task 分发的正规渠道。

**Q: verify.mjs 的合格样本怎么构造?**
A: 三种途径,从易到难:(1)翻 git 历史找该 task 的真实运行产物;(2)让 task 真跑一次(`run_task`),拿 outputDir 里的产物;(3)读 verify.mjs 源码手动构造满足所有断言的数据。批次 1 的简单 task 无 verify.mjs,不用构造。

**Q: collect 冒烟测试报错(脚本不支持 UGK_COLLECTOR_SELFTEST)?**
A: 跳过此项,在 PR 里说明"该 task 脚本未实现自检模式"。这是可选的,不阻塞迁移。

**Q: 迁完怎么确认没破坏引擎?**
A: `npm test` 应仍 681 pass / 0 fail。引擎已与真实 task 解耦(grep `fixtures/taskbooks` 零命中),task 迁移不影响引擎单测。

---

## 8. 审核约定(给执行者)

每批做完叫我审核。我会查:
1. 包内 `tests/` 结构是否完整(eval.cases.json 必有;有 verify.mjs 的应有 verify.test.mjs)
2. eval runner 能否从包内加载 cases(实跑一条)
3. verify.test.mjs 是否真能跑(PASS/FAIL 路径覆盖)
4. 引擎 `npm test` 不受影响(仍 681 pass)
5. diabetes-device-custom-source-news 的回收测试是否到位(§3)

按这个计划做,有问题随时问。
