# 交接:worker 写文件慢 + JSON 合法性 + 稳定性全面修复

> **交接时间**:2026-07-04
> **上一会话**:`2026-07-04-worker-write-slow-bug.md`(发现 worker 用 write tool 逐 token 输出 JSON,LinkedIn 实测 +124s)
> **本会话**:从"加 write-output.mjs"演化到"对抗式审查推翻 handoff 部分结论 + 全面修复稳定性 + 两次全量验证"
> **核心**:写文件慢(主目标)+ JSON 合法性 + undefined 路径崩溃 + ASI 陷阱 + 8min 超时,全部修完并两次实证。

---

## 1. 主目标达成:写文件慢彻底解决

**根因(实证)**:worker 是 LLM agent,唯一落盘手段是 `write` tool;skill.md 里的 `fs.writeFileSync` 是误导 LLM 的伪代码(认知根因)。LLM 逐 token 输出 33KB JSON 实测 +124s。

**修复**:5 个 taskbook 改为 worker bash 调 node 脚本,脚本内部 `JSON.stringify` + `writeFileSync`(确定性、<1s)。

| 平台 | 脚本 | 实测耗时 | 旧路径 |
|---|---|---|---|
| linkedin | collect-and-write.mjs | +4.6s(含 CDP 取数) | +124s |
| x-search | collect-and-write.mjs | <1s | 慢 |
| ins | write-output.mjs | <1s | 慢 |
| tiktok | write-output.mjs | <1s | 慢 |
| reddit | write-output.mjs | <1s | 慢 |

---

## 2. 对抗式审查推翻 handoff 的两个结论

### 推翻 1:handoff 的 write-output.mjs 方案对 x/linkedin 无效

handoff 说"5 个 taskbook 都加 write-output.mjs"。对抗式审查发现:
- **Group1(ins/tiktok/reddit)**:数据已在 `_filtered.json`(node 已拥有),write-output.mjs 能直接读 → 方案有效。
- **Group2(x/linkedin)**:数据只在 LLM context(来自 CDP evaluate 返回值),write-output.mjs **无数据可读**;让 LLM 把 rows 传给它,还是要 emit,零收益。

**解决**:验证 CDP 用裸 DevTools Protocol(HTTP /json/list + WS,9222/127.0.0.1),bash 起的 node **能直连**。给 x/linkedin 改用 `collect-and-write.mjs`(node 自己连 CDP 取数 + 写盘,LLM 完全不碰 rows)。

### 推翻 2:原认知"只有 linkedin 滚到底,其他用时间区间判断"部分不准

用户原认知 vs 实际(代理调查):
| 平台 | 用户说 | 实际 |
|---|---|---|
| linkedin | 服务端过滤滚到底 | ✅ 对 |
| x-search | 时间区间判断 | ✅ 对(cutoff_reached,olderStreak>=3) |
| ins | 时间区间判断 | ❌ 不对(靠 rounds/no_new_links 停) |
| tiktok | 时间区间判断 | ❌ 不对(靠 no_new_content/maxScrolls 停) |
| reddit | 时间区间判断 | ❌ 不对(服务端 t=week URL 过滤,像 linkedin 滚到底) |

**关键**:只有 linkedin 踩 5min(300000)超时,其他 4 个分别是 90s/120s/180s/180s,不踩。

---

## 3. 修复的 bug 清单(按发现顺序)

### Bug 1:findTab 按 URL 猜错 tab(首次验证崩)
`collect-and-write.mjs` 用 `findTab({urlContains})` 猜 tab,但 worker 用的是 `UGK_CDP_TAB_ID` 指定的专属隔离 tab(tab-session.ts 机制)。
**修复**:cdp-client.mjs 优先读 `UGK_CDP_TAB_ID`(与框架对齐),找不到立即报错不静默 fallback。

### Bug 2:`return //注释` ASI 陷阱(二次验证崩,根因最难找)
dump-result.js 以 `//` 注释开头。拼接 `(() => { config; return //comment\n IIFE })()` 时,JS 把 `return` 后的注释行注释掉,ASI 插入分号 → `return;` → 返回 undefined。
**修复**:剥掉 DUMP_SCRIPT 头部注释(`replace(/^\/\/.*$/gm, "")`)+ 改用分号分隔(不用 return 包裹)。
**当场验证**:用活 tab + 真实 47 条数据,返回 object 不再 undefined。

### Bug 3:`Number(null)===0` 的 JS 坑
数字字段守卫 `Number.isFinite(Number(x)) ? Number(x) : null`,对 null 输入:`Number(null)===0` → 返回 0 而非 null。
**修复**:`num()` 守卫先判 `x === null || x === undefined || x === ""`。

### Bug 4:框架没注入 TASK_OUTPUT_DIR(undefined 路径崩溃)
worker 的 bash 脚本读 `process.env.TASK_OUTPUT_DIR` 拿到 undefined → 中间文件路径拼成 `E:\...\undefined\_topsearch.json` → ENOENT(ins/tiktok/reddit 全中)。
**根因**:task.ts 只注入 TASK_DIR(line 1278),没注入 TASK_OUTPUT_DIR(只在 prompt 文本里告知)。
**修复**:task.ts:1281 注入 `TASK_OUTPUT_DIR: outputDir`(runTaskWithRetry 内,两条路径都经此,一处全修)。

### Bug 5:reddit raw 写入 ~4min(同款 LLM 逐 token 病,中间文件)
reddit 的 `_raw.json` 也走 LLM write tool,实测 `[+158s]→[+384s]` ≈ 4 分钟。
**修复**:reddit/tiktok 加 `collect-raw.mjs`(node 直连 CDP 循环 evaluate dump-result.js + 写盘)。reddit raw 从 ~4min 降到 +4.1s。

### Bug 6:ins write-output url 字段映射
filter-lib 输出 `postUrl`,但 worker 有时跳过 normalize 直接存(字段是 `url`)。第一次 write-output 崩,worker 重跑才对。
**修复**:mapRow 兼容 `r.postUrl || r.url`。

### Bug 7:tiktok write-output 相对路径崩
worker 传裸 `_filtered.json`(相对路径),node 在安装目录 `D:\Git` 找不到 → ENOENT。
**修复**:write-output.mjs 加 `resolve(args.filtered)`。

### 非 bug 但改了:8min 超时
linkedin scroll 理论 4.6min,5min 偶尔卡边界被切。框架 client.ts:83 钳位上限 300000→480000(5min→8min)。linkedin skill.md timeoutMs 300000→480000。

---

## 4. 两次全量验证(medtrum + touchcare)

### 第一次(medtrum)— 修复过程中
- linkedin:bottom_reached,collect-write +6.2s ✅
- x:collect-write 成功,2 rows ✅
- ins:write-output 重跑(url 错)→ 暴露 Bug 6
- tiktok:write-output 相对路径崩 → 暴露 Bug 7
- reddit:raw 4min → 暴露 Bug 5

### 第二次(touchcare)— 所有修复落地后
- linkedin:bottom_reached 5.1min,collect-write +4.6s ✅
- x:collect-write 成功,0 rows(真实无数据)✅
- ins:write-output **一次成功**(url 修复生效),无 undefined ✅
- tiktok:**collect-raw 首次成功**(58 rows),无 undefined,无自创脚本 ✅
- reddit:**collect-raw raw 从 4min 降到 +4.1s**,bottom_reached ✅

**两次跑零崩溃**(第二次),所有修复实证有效。

---

## 5. 完整改动清单

### 主仓库(E:/AII/ugk-core,需重启生效)
| 文件 | 改动 | commit |
|---|---|---|
| extensions/task/task-worker.ts | timestamp 修复(epoch-ms 数字不再被当字符串) | 13b9b72(已提交) |
| extensions/chrome-cdp/client.ts | evaluate 超时上限 300000→480000(5min→8min) | 待提交 |
| extensions/task/task.ts | runTaskWithRetry 注入 TASK_OUTPUT_DIR(治 undefined 崩) | 待提交 |

### taskbook(~/.pi/agent/tasks/,运行时读无需重启)
5 个 taskbook 各加 `scripts/cdp-client.mjs`(零依赖,UGK_CDP_TAB_ID 优先):
- linkedin/x:`collect-and-write.mjs`(最终产物,node 直连 CDP 取数 + 写盘,ASI 修复)
- ins/tiktok/reddit:`write-output.mjs`(最终产物,读 _filtered.json,resolve + null 守卫 + ins url 兼容)
- reddit/tiktok:`collect-raw.mjs`(中间 raw,治 4min 慢)
- 5 个 skill.md:认知纠正("worker 是 LLM agent 不是 node 进程")+ 步骤重构

### 备份仓库(mhgd3250905/ugk-tasks)
commit `485786a`,已推送。5 个 search taskbook 的 skill.md + scripts/ 全部同步。

---

## 6. 关键认知(传给新会话)

1. **worker 是 LLM agent,不是 node 进程**。唯一落盘手段是 write tool(逐 token,慢 + JSON 易错)。skill.md 里的 `fs.writeFileSync` 是误导,必须改成"worker bash 调 node 脚本"。
2. **CDP 可被 bash node 直连**(HTTP /json/list + WS,9222)。框架的 chrome_cdp 是 LLM 工具,bash 子进程用不了,但能自己连。这是 collect-and-write/collect-raw 的物理基础。
3. **`return //comment` 是 JS ASI 陷阱**。CDP `Runtime.evaluate` 单表达式模式下,dump-result.js 等以注释开头的脚本拼接时会踩中。剥注释 + 分号分隔。
4. **TASK_OUTPUT_DIR 必须作为环境变量注入**,不能只放 prompt 文本。worker 的 bash 脚本读 `process.env` 拿不到 prompt 文本里的值。
5. **JSON 合法性靠 `JSON.stringify` + round-trip 自检**,不靠 LLM 手拼。null 守卫要显式判(避免 `Number(null)===0`)。
6. **collect-raw 不通用**:reddit/tiktok 结构同(单 scroll,window collector),能共用思路。ins 复杂(多种子逐帖 navigate 编排),没做。ins 慢在 navigate 不是写 raw。

---

## 7. 遗留问题(低优先级)

- **ins 没做 collect-raw**:ins 的 raw 是逐帖详情(多种子 navigate 编排),复刻进 node 工作量大。且 ins 本次 write-output 一次成功,raw 慢不是主要矛盾。暂不做。
- **reddit worker 自创 filter-temp.mjs**:filter-lib 步骤 worker 还是倾向自创脚本(不直接用 skill.md 的 node -e 命令)。结果对,但 filter 步骤 skill.md 措辞可加固。低优先级。
- **scroll-and-collect.js 容差停止逻辑**:linkedin 加了 scrollStale 容差(±20px)+ noProgressAtBottom 双信号。根因(到底没识别 vs 滚得慢)未 100% 确认,但 8min 超时托底 + 两次都 bottom_reached,实测稳定。

---

## 8. worktree 状态

- 主仓库 `E:/AII/ugk-core/` 在 main,有未 commit 的 client.ts(8min)+ task.ts(TASK_OUTPUT_DIR)待提交。
- taskbook 在 `C:/Users/29485/.pi/agent/tasks/`(user scope,运行时读)。
- 备份仓库 `https://github.com/mhgd3250905/ugk-tasks` commit `485786a` 已推送。
- ugk npm symlink 指向主仓库,重启 ugk 用主仓库 main 代码。
