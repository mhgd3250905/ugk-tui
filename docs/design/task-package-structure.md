# Task 包结构规范(闭环:测试随包)

> **状态**:结构定义已落地,存量 task 待迁移(见文末迁移计划)。
> **第一性原理**:task 是可插拔功能包,出厂无 task。功能包必须自包含——运行时代码、运行时校验、开发期测试都随包走,迁移/发布/安装时整体移动,不依赖宿主仓库。

## 1. 目标结构

```
<taskbook-name>/
├── taskbook.json          # 元数据(name/description/scope/timestamps/tags/runs)
├── spec.json              # 需求规格(goal/hardConstraints/acceptance/forbidden/context)
├── skill.md               # worker 复用指南(不含验收逻辑)
├── verify.mjs             # L1 运行时校验(读 TASK_OUTPUT_DIR/TASK_INPUT,产 VerifyFailure[])
├── contract.json          # worker/verify 契约(runtimeInput/artifacts/required*/maxRetry)
├── scripts/               # 可选,worker 脚本(被 skill/verify 用 $TASK_DIR/scripts/ 引用)
└── tests/                 # 可选,task 自带的开发期测试资产
    ├── eval.cases.json    #   dispatcher eval 用例(自然语言→runtimeInput 翻译测试)
    ├── verify.test.mjs    #   verify.mjs 逻辑测试(给定样本→断言 PASS/FAIL)
    ├── collect.test.mjs   #   可选,scripts/ 脚本冒烟(UGK_COLLECTOR_SELFTEST 模式)
    └── samples/           #   可选,测试样本产物(pass-*.json / fail-*.json)
```

### 1.1 不变的 5 核心 + scripts/
`taskbook.json` / `spec.json` / `skill.md` / `verify.mjs` / `contract.json` 是 task 运行时必需的 5 文件,`scripts/` 是可选 worker 脚本。**本次结构改动不触碰这些**,它们的位置、schema、加载逻辑完全不变。

### 1.2 新增的 tests/ 子目录(本次定义)
task 的**开发期测试**收进 `tests/` 子目录。三类测试统一收纳:

| 文件 | 类型 | 验证什么 | 跑法 | 进 CI? |
|---|---|---|---|---|
| `eval.cases.json` | dispatcher eval | 自然语言→runtimeInput 翻译正确 | `npm run eval:dispatcher -- --task=<name>` | ❌ 需 LLM |
| `verify.test.mjs` | verify 逻辑 | verify.mjs 对样本判定正确(PASS 样本过/FAIL 样本挂) | `node --test tests/verify.test.mjs` | ✅ 纯本地 |
| `collect.test.mjs` | 脚本冒烟 | scripts/ 脚本基本路径能跑 | `node tests/collect.test.mjs` | ⚠️ 依赖外部环境时本地 |

**约定**:
- `tests/` 下文件**全部随包发布**(publish 放行,见 §3)。
- runner 按文件存在性自动识别能跑哪些:无 `eval.cases.json` 就跳过 dispatcher eval,无 `verify.test.mjs` 就跳过 verify 逻辑测试。
- `tests/samples/` 放测试输入样本,`verify.test.mjs` 用 `$TASK_DIR/tests/samples/` 引用(已有 TASK_DIR 注入)。

## 2. 为什么测试要进 task 包

**痛点(本次解决的)**:原结构把 task 的开发期测试散落在仓库根 `tests/fixtures/`:
- `tests/fixtures/taskbooks/<name>/` 放 task 本体副本
- `tests/fixtures/dispatcher-evals/<name>.cases.json` 放 eval cases(与本体分居两个平行目录)
- 引擎单测(`tests/*.test.ts`)硬编码引用这些 fixture

后果:
1. task 删除/迁移 → 引擎单测崩(耦合)
2. 装新 task → 它的开发期测试无处安放,只能往仓库根塞
3. "出厂无 task"原则被破坏(fixture task 事实上成了出厂自带)

**本次改动**:测试收进 task 包内 `tests/`,引擎单测与真实 task 解耦(改用内联样本)。task 作为功能包完整自包含。

## 3. 已落地的引擎改动(本次 PR)

### 3.1 评判器抽离(`extensions/task/task-eval-judge.ts`)
`judgeField` / `judgeCase` 从 `scripts/eval-dispatcher.mjs` 抽到独立模块。runner 和单测都从这里 import,切断"引擎单测 → import 会读 fixture 的 runner"间接耦合。纯函数,行为零变化(14 个单测保护)。

### 3.2 eval runner 改读包内路径(`scripts/eval-dispatcher.mjs`)
runner 按 `--task=<name>` 解析已安装 task 包(user scope 优先 → project scope 兜底),从包内读 contract/skill 和 `tests/eval.cases.json`。报告输出随包走(`<taskDir>/<name>/tests/eval.report.{json,md}`)。
- **迁移期 flag**:`--legacy-fixtures` 回退读老 `tests/fixtures/` 路径。所有 task 迁完后删除。

### 3.3 publish 放行 tests/(`extensions/task/task-share-publish.ts`)
`shouldSkip` 规则:`tests/` 子目录下的文件(含 `*.test.mjs`)放行;包根/scripts/ 散落的 `*.test.mjs` 仍排除(防运行时目录混入测试)。marketplace 管道对文件类型 agnostic,服务端/manifest/安装端零改动。

### 3.4 引擎单测去 fixture 依赖
- `task-dispatcher-eval.test.ts`:import 改到 `task-eval-judge.ts`;2 个 prompt 注入测试改用内联 contract;2 个 cases 结构校验测试删除(迁进 video-downloader 包)
- `task-verify.test.ts`:删除 1 个引用 diabetes fixture 的测试(迁进该 task 包)
- `task-collector-scripts.test.ts`:整文件删除(迁进 diabetes-device-custom-source-news 包)

**验证**:`grep -rn "fixtures/taskbooks\|fixtures/dispatcher-evals" tests/ extensions/ scripts/` 零命中,引擎与真实 task 彻底解耦。

## 4. 迁移计划(后续专人按此执行)

### 4.1 现状清单(12 个 fixture task)

| 批次 | task | 有 verify.mjs? | 有 scripts/? | 迁移复杂度 |
|---|---|---|---|---|
| 1 | video-downloader | ❌ | ❌ | 低(只迁 eval cases) |
| 1 | subtitle-cleaner | ❌ | ❌ | 低 |
| 1 | subtitle-fluent-translator | ❌ | ❌ | 低 |
| 1 | subtitle-to-speech | ❌ | ❌ | 低 |
| 2 | medical-diabetes-news | ✅ | ✅ | 中(补 verify.test.mjs) |
| 2 | diabetes-device-regulatory-signals | ✅ | ✅ | 中 |
| 2 | diabetes-device-custom-source-news | ✅ | ✅ | 中(含 collect 冒烟) |
| 2 | diabetes-news-report-packager | ✅ | ✅ | 中 |
| 2 | diabetes-news-report-renderer | ✅ | ✅ | 中 |
| 2 | diabetes-news-report-translator | ✅ | ✅ | 中 |

### 4.2 单 task 迁移操作模板

```bash
# 1. 确认 task 已安装(user 或 project scope 能 loadTaskbook)
# 2. 定位 task 包目录
TASK_DIR_USER=~/.pi/agent/tasks/<name>          # user scope
TASK_DIR_PROJECT=<cwd>/.tasks/<name>            # project scope

# 3. 建 tests/ 子目录,迁入/新建测试资产
mkdir -p "$TASK_DIR/tests"
#   eval cases(若有老 fixture)
cp tests/fixtures/dispatcher-evals/<name>.cases.json "$TASK_DIR/tests/eval.cases.json"
#   verify 逻辑测试(若有 verify.mjs,参照 task-verify.test.ts 删除的测试写)
#   collect 冒烟(若有 scripts/,参照 task-collector-scripts.test.ts 写)

# 4. 验证 eval 走包内 cases
npm run eval:dispatcher -- --task=<name>

# 5. 删 tests/fixtures/ 下对应旧文件
rm -rf tests/fixtures/taskbooks/<name>
rm tests/fixtures/dispatcher-evals/<name>.cases.json

# 6. 重跑 npm test 确认引擎单测不受影响
npm test
```

### 4.3 清理(所有 task 迁完后)
- 删除 `tests/fixtures/taskbooks/` 和 `tests/fixtures/dispatcher-evals/` 目录本体
- 删除 `scripts/eval-dispatcher.mjs` 的 `--legacy-fixtures` flag 及相关 fallback 代码
- 更新本文档状态为"迁移完成"

### 4.4 关键决策点(迁移时需明确)
- **批次 2 的糖尿病 task 本身在 `.tasks/`(gitignored)**:需决定是迁进用户本地包,还是作为 marketplace 发布版本走。建议:作为 marketplace 发布,让测试随包可分享。
- **是否保留 fixture 副本作引擎冒烟**:本次改动后引擎单测已自造样本,不需要真实 task 冒烟。fixture 可彻底删。

## 5. 后续迭代(本次不做)

- **task 创建流程生成 tests/**:`task-prompts.ts` 加 `TEST DESIGN GATE`(仿 VERIFY DESIGN GATE),`task-state.ts` 的 `TaskReviewResult` 加 `tests` 字段,`saveTaskbook` 写 tests/ 目录。让 reviewer 自动产出测试,而非手写。
- **通用 task 测试 harness**:一个 `run-task-tests <name>` 命令,遍历 task 包内 tests/ 跑所有可跑的测试(无 LLM key 跳过 eval,无外部依赖跑 verify 测试),统一报告。
