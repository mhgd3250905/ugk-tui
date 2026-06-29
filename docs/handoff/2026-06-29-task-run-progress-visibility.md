# Handoff — task 运行进度可见性增强

> 日期：2026-06-29
> 上一份 handoff：`docs/handoff/2026-06-28-linkedin-search-task.md`
> 代码基线：会话开始 `cf54a8f`(477/477/0)→ 会话结束 `260d22b`(**478/478/0**)
> 工作树：干净(已全部 commit)

---

## 本次会话做了什么(2 个主题 + 1 个 PR 审核干预)

### 主题一:worker 运行中进度透传工具调用(ToolCall/toolResult)

**用户痛点**:"task 运行过程中,中间的日志相对来说比较少,第一轮运行失败,希望有具体原因打出来"。

**摸排结论**:这是**机制缺失**,不是 task 内部声明能决定的。task 内部(taskbook 的 skill.md/verify.mjs/contract.json)没有任何手段控制运行中日志丰富度——日志链路完全由机制层决定。

**根因**:`task-worker.ts` 的 `onUpdate` 回调只取 `partial.content` 的 text(LLM 文本流),丢弃了 `partial.details.results[0].messages` 里**已存在**的 ToolCall 和 toolResult message。worker 干活(连 CDP/抓页面/写文件)主要靠工具调用,但 LLM 在思考/调工具时几乎不打字 → 运行中日志稀疏。**数据本来就有,是机制把信息源切窄了。**

**修法**(只改 `extensions/task/task-worker.ts` 一个文件):
- 新增 `formatMessageProgress(msg)`:把 message 转成进度行
  - `ToolCall` → `🔧 <name> <args摘要>`(chrome_cdp 能看到 `🔧 chrome_cdp navigate`,bash 能看到 `🔧 bash <command>`)
  - `toolResult` 成功 → `✔ <name>: <首行>`;失败 → `✖ <name>: <错误首行>`
- onUpdate 改增量索引(`lastSeenIndex`),只发新增 message,不重发历史(下游 `appendUniqueProgressLines` 仍兜底去重)
- `path`/`url`/`file` 类长参数(>40字符)短化成 basename,提升 widget 可读性
- `details/messages` 缺失时 fallback 到旧文本路径(兼容部分模拟场景)

**不改的部分**:
- `task.ts` / `formatProgressLines` / widget / `formatRunResult` —— 工具调用摘要是普通 text 行,自然流进现有管道,零改动
- `subagent.ts` 的通用 `OnUpdateCallback` 契约 —— 只改 task-worker 这一个消费方

**真实验证**(用户实跑 `/task run x-search "GPT5" "3h"`):
```
▸ taskbook "x-search" 运行过程: PASS (18 条)
1. ✖ chrome_cdp: Validation failed for tool "chrome_cdp": ...   ← 第一轮失败的具体原因,改动前看不到
2. 🔧 bash mkdir -p "E:/AII/TUI/TUI-0627/.tasks/runs/.../output"
3. ✔ bash: (no output)
4. 🔧 write x_search_results.json                                ← 路径已短化成 basename
5. ✔ write: Successfully wrote 1880 bytes to ...
```
第 1 行 `✖ chrome_cdp: Validation failed...` **直接命中用户痛点**——以前 worker 第一轮工具失败全程静默,现在能看到是哪个工具、报了什么错。

### 主题二:/task run 回车后补"正在解析输入"提示,消除静默期

**用户痛点**:"我使用 /task run xxxx 然后回车,先会持续显示 ╌╌╌╌ 啥都没有,然后过一会显示 ⏳ taskbook 运行中..."。

**摸排结论**:与主题一同源,但**更早的阶段**。回车后到 worker spawn 之间的执行顺序:

| 步骤 | 耗时 | UI 反馈 |
|---|---|---|
| chooseTaskbookName / loadTaskbook | 快 | 无 |
| resolveTaskWorkerEnv(CDP/MCP 授权) | 快/弹确认 | 无 |
| **resolveRuntimeInput → callDispatcher** | **数秒~十几秒 (LLM)** | **无 ← 真凶** |
| runTaskWithRetry → onWorkerStart | — | ⏳ 运行中 |

**真凶**:`resolveRuntimeInput`(task.ts)→ `callDispatcher`(task-dispatcher.ts)——一次**阻塞的 dispatcher LLM 调用**,把自然语言 input 翻译成结构化参数。这期间 UI 完全静默。

**关键证据:对称缺口**。headless 路径(`executeSubtask`/run_task 工具)**早就有**这个进度提示——task.ts:1124 `setTaskRunWidget(ctx, [title, "正在解析输入..."])`,在 dispatcher 调用前显示。交互式路径 `handleTaskRun` **漏了这一步**。

**修法**(task.ts 一行,与 headless 路径对称):在 `handleTaskRun` 的 `resolveRuntimeInput` 之前补:
```ts
setTaskRunWidget(ctx, [`⏳ taskbook "${finalName}" 准备中...`, "正在解析输入..."]);
```
效果:回车后立即显示"正在解析输入...",dispatcher 翻译完后自然过渡到 `onWorkerStart` 的"⏳ 运行中 / 尝试 1/4 / worker 执行中..."。不再有空白 ╌╌。

### PR #22 审核干预(已合并)

PR #22 是 codex 自动化审核报告(纯文档 +55/-0)。审核结论:
- ✅ 事实层准确(scope/模块清单/跳过理由均核实无误)
- ⚠️ Candidate 1 重构建议(给 settings-io 加 delete helper)不建议执行:违反代码里已用 `ponytail:` 注释固化的 YAGNI 决策。`withDefaultExists` **不是死防御**——实测删除后 `setUiLanguage` 在 settings.json 不存在时会静默失败(`updateSettingsJson` 把 ENOENT 误判为"文件损坏"而保护性 return,不创建文件)。报告称"净 -20~-35 行"夸大,实际净变化持平。
- ✅ Candidate 2/3 报告自身已标注"别做",认同。

**留痕**:在 PR 发了审核评论(https://github.com/mhgd3250905/ugk-tui/pull/22#issuecomment-4827800826),squash 合并后 main `cf54a8f` → `c149a79`。

**踩坑记录(ponytail 教训)**:审核 `withDefaultExists` 时我**两次判断都错**——先说"死防御可删",改主意说"不注入 exists 安全",最终用测试(`node --test` 临时证明脚本)钉死真相:`withDefaultExists` 是必需的适配层,让 `updateSettingsJson` 能区分"文件不存在"和"文件损坏"。**非平凡逻辑必须留 check,不能凭推演。**

---

## 测试基线

- 会话开始:`cf54a8f`(477/477/0)
- 会话结束:**478/478/0**(`260d22b`,+1 个工具调用透传测试)

---

## 改动文件清单(全部已 commit)

| commit | 文件 | 改动 |
|---|---|---|
| `7b4b7a4` | `extensions/task/task-worker.ts` | onUpdate 增量提取 ToolCall/toolResult + `formatMessageProgress` + 长路径短化 |
| `7b4b7a4` | `tests/task-worker.test.ts` | +1 测试:工具调用行/成功失败结果行/增量去重/路径短化 |
| `260d22b` | `extensions/task/task.ts` | `handleTaskRun` 补"正在解析输入"widget(与 headless 路径对称) |
| `c149a79` | `docs/automated-reviews/2026-06-29-cf54a8f.md` | PR #22 合并进来的自动化审核报告(非本会话产出) |

---

## 设计意图核验(改之前做的,确认没破坏既有边界)

1. **subagent 通用契约不动** —— 只改 task-worker 一个消费方,`OnUpdateCallback` 类型签名未变 ✓
2. **task.ts 管道不动** —— 工具调用摘要是普通 text 行,经现有 `formatProgressLines`(去 markdown/去重/截尾 5 条/截断 120 字)处理,零改动 ✓
3. **activeTaskRun 状态语义不动** —— "正在解析输入"widget 在 `activeTaskRun` 创建之前设置,但 widget 是独立 UI 反馈,不破坏 abort/repair 语义(task-extension 62/62 通过证明)✓
4. **dispatcher 契约不动** —— 只在调用前加 UI 提示,不改 dispatcher 行为 ✓

---

## 已知边界 / 本次不做

- **stderr 实时透传(原缺口③)**:worker 子进程崩溃时 stderr 在 `subagent.ts` 累加但只在结束后进 `errorMessage`,运行中没推给 UI。需动 `subagent.ts`(通用契约层),是另一条线,本次按计划不碰。worker 正常调工具的失败已被主题一覆盖(✖ 行),此缺口仅影响"子进程本身崩溃"的边角场景。
- **widget 固定 5 行窗口**:`formatProgressLines` 的 `.slice(-5)` 和 widget 显示 5 行未放宽,够用。

---

## 待验证项(新会话/用户操作)

- 新开 ugk 进程跑 `/task run x-search "GPT5" "3h"`,确认:①回车后立即看到"正在解析输入..."(不再 ╌╌╌) ②运行中看到 `🔧/✔/✖` 工具调用行 ③长路径已短化成 basename
- 其他 task(非 CDP)也应有工具调用透传效果(worker 调 bash/fs 都会显示)

---

## 建议 skills(新会话)

- **ponytail** — 全程遵循(本次审核 `withDefaultExists` 时两次推演错误,靠测试钉底;非平凡逻辑必须留 check)
- **task-creator** — 创建 task 时参考(机制全景节已固化进度可见性相关边界)
