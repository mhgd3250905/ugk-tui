# 对抗性代码审查 — ugk-core 全架构

> 日期：2026-06-30
> 审查对象：基线 `26bd68f`(main,测试 475/475/0)
> 审查方法：第一性原则 + ponytail + 对抗性(每条 sub agent 结论都自己复核源码)
> 结论：**3 处真问题已全部修复**(478/478/0),5 处误报已排除并记录
> 修复后基线：测试 **478/478/0**(+3 回归测试)

---

## 审查范围与方法

对 `extensions/`(约 11000 行 TS)做全架构对抗审查,重点:
- 安全敏感:权限门正则、chrome-cdp(本地登录态 Chrome)、命令注入面
- 复杂逻辑:task.ts(2340 行,依赖校验/重试/abort/并行)、并行原语
- 资源管理:子进程 spawn/kill、CDP tab、MCP transport

**对抗流程**:派 sub agent 初审 → **逐条复核源码**(不轻信) → 真问题修、误报标明排除。本轮 sub agent 的初始结论有部分过时/误报,复核纠正了 5 处。这正是对抗审查的意义。

---

## 已修复的真问题(3 处)

### P0-1(安全):权限门正则可绕过 `rm -fr /` 等

**根因**：`extensions/index.ts:349` 旧正则 `/\brm\s+(-rf?|--recursive)/i` 锁定了 `-r` 必须在 `-f` 前。但 rm 的 `-r`/`-f` 是**顺序无关的独立 flag**。

**实测绕过**（node 矩阵验证）：
```
放行(危险)  rm -fr /          # f 在 r 前
放行(危险)  rm -f -r /        # 分写且 f 在前
放行(危险)  rm --force --recursive /  # long flag 反序
```

**修复**：改为顺序无关的"rm 后(同一命令段内,不跨 `|;&` 分隔符)出现含 r 的短选项或 `--recursive`"：
```ts
/\brm\b[^|;&]*(-\w*r\w*|--recursive)/i
```
chmod/chown 777 同理改 `[^|;&]*`。**29 条变体矩阵全过**(node 实测 + 测试钉死)。

**回归测试**：`tests/ugk-command.test.ts` 加参数化用例,18 条应拦截 + 11 条应放行,覆盖所有 flag 顺序/分写/长短选项组合。

---

### P0-2(资源泄漏/攻击面):Chrome 进程永不回收

**根因**：`extensions/chrome-cdp/launcher.ts:92` `launchChromeCdp` 用 `spawn({detached:true})` + `child.unref()`,child 句柄用完即丢。**全仓 grep kill 零命中**——没有任何代码关闭这个 Chrome。带 `--remote-debugging-port` + 用户登录态的 Chrome 永久驻留桌面,端口持续监听。

**修复**(teardown hook,不动 `detached`——保留用户继续用 Chrome 窗口的能力,但 agent 退出时主动回收它自己起的调试实例):
- 模块级 `Set<ChildProcess>` 存句柄
- `ensureTeardownHook()` 注册 `beforeExit`/`exit`/`SIGINT`/`SIGTERM`(Windows Git Bash 下 SIGINT 可捕获,信号注册失败 try/catch 不阻塞 launch)
- `child.on("exit")` 在 Chrome 自行退出时清掉(避免 kill 已死进程)
- 导出 `__testOnly` 给测试

**回归测试**：`tests/chrome-cdp-launcher.test.ts` 加用例,手动塞 fake ChildProcess,调 teardown,断言 kill 被调用 3 次 + Set 清空 + 幂等。

---

### P2-5(健壮性):CDP onmessage 的 JSON.parse 无 try/catch

**根因**：`extensions/chrome-cdp/client.ts:115` `socket.onmessage` 里 `JSON.parse(String(event.data))` 无防护。Chrome 发畸形帧(多帧拼接/二进制/协议错)时抛出,此时 `cleanup()` 未调用、`timer` 未清、`socket` 未关,promise 挂起到 timeout(钳位后最长 5min)。

**修复**：包 try/catch,parse 失败立即 cleanup + close + reject(含截断的原始帧前 200 字符便于诊断)。

**回归测试**：`tests/chrome-cdp-client.test.ts` 加 `MalformedWebSocket` 专用 mock,断言 reject `/malformed message/i` + socket.close 被调用 + 耗时 < 5s(不挂等到 timeout)。

---

## 已排除的误报(5 处,记录以防重复审查)

对抗复核纠正了 sub agent 初始审查的过时/误判:

| # | sub agent 初判 | 复核结论 | 依据 |
|---|---|---|---|
| 1 | PR #21 "未合并且高危,会静默删 CDP autolaunch" | **误报** | `gh pr view 21` 显示 **已 MERGED**(2026-06-28)。那份 review 文档是合并前的审查 |
| 2 | doctor/ 有 `checks.ts`/`formatter.ts` 死代码 | **误报** | 实际 `extensions/doctor/` 只剩 `index.ts`(47 行 legacy notice)。死代码**早已删除** |
| 3 | driver-session.ts 引用残留 | **部分真** | 代码层零引用(已彻底删,改名 `driver-view.ts`)。**仅 docs 残留**——文档债非代码债 |
| 4 | chrome-cdp autolaunch 绕过 ask 授权门 | **误报** | `task-worker.ts:101` 用 `UGK_TASK_ALLOW_CHROME_CDP` env 守门,该 env 只在 taskbook 声明 chrome_cdp **且通过 task 授权门**(`task.ts:767`)时设。授权链完整,设计正确 |
| 5 | findTab 无 target 时 fallback `tabs[0]` 是并发竞态 | **降级为 nit** | worker 路径注入 `UGK_CDP_TAB_ID` 到 sessionTabId,**正常路径不 fallback**。fallback 仅 `/cdp` 手动操作场景,是用户主动选当前 tab 的合理行为,非并发 |

---

## 核实为良好(不计入问题)

- **命令注入面**:`launcher.ts` 的 `port` 走 `parsePort`(严格 1-65535),spawn 用数组参数非 shell 拼接;`/json/new` 用 `encodeURIComponent`;`/json/close/<id>` 的 id 来自 Chrome 返回非用户输入。**无注入**。
- **task.ts 校验链**:env→binary 两条路径(executeSubtask + handleTaskRun)契约一致;`runTaskWithRetry` 的 abort 语义收窄(`workerAborted` vs `signal.aborted`);verifyResult 合成避免 null-guard 散落;parseFailed 隔离批次。**设计严谨,无 bug**。
- **并行原语**:`mapWithConcurrencyLimit`(worker pool,JS 单线程 nextIndex++ 原子,results 按索引保序)、`truncateParallelOutput`(while 切片)。**经典正确实现**。
- **subagent/mcp 资源清理**:subagent worker SIGTERM→超时→SIGKILL→finally;mcp `closingClients` WeakMap 防重复关闭 + `killClientProcess` 强杀 + `closeBestEffort` 带超时。**干净**。
- **DNS rebinding**:Chrome 66+ 内置 Host header 校验已防,本工具无需自己加。
- **仓库卫生**:`nul`/`wangnuanwei-*.md`/`website/` 全部 untracked + gitignored,无害。
- **架构守卫**:`tests/task-extension.test.ts` 用 `assert.doesNotMatch` 强制 task/ 不 import chrome-cdp/mcp/,依赖反转通过 `shared/worker-lifecycle.ts` 中立层。**真实存在且未被破坏**。

---

## 未做(留后续,ponytail YAGNI)

- **端口随机化**(P1-3):launcher 用固定 9222。`--remote-debugging-port=0` + 显式 `--remote-debugging-address=127.0.0.1` 可消除固定端口可预测性。超出本轮"全部修"确认范围,记此。
- **端口绑定显式声明**:launch 命令未显式传 `--remote-debugging-address=127.0.0.1`(靠 Chrome 默认)。纵深防御可补。
- **integration 测试缺口**:task/chrome-cdp/subagent 缺端到端 integration 层(目前只有 MCP 有)。非阻塞。

---

## 验证

```bash
cd E:/AII/ugk-core
npm test   # 478/478/0(+3 回归),8.9s
```

每块修复的回归测试均经过"反向验证"思路确认有效(权限门:旧正则放行 `rm -fr /` 已在初次矩阵测试中显示;teardown/JSON.parse:测试逻辑直接断言 kill/reject 语义)。

---

## 改动清单

```
 extensions/chrome-cdp/client.ts   | 13 +++-   (P2-5 try/catch)
 extensions/chrome-cdp/launcher.ts | 41 +++++-  (P0-2 teardown)
 extensions/index.ts               |  8 +--    (P0-1 正则)
 tests/chrome-cdp-client.test.ts   | 40 ++++   (P2-5 回归)
 tests/chrome-cdp-launcher.test.ts | 30 ++++   (P0-2 回归)
 tests/ugk-command.test.ts         | 48 ++++   (P0-1 回归)
 6 files changed, 176 insertions(+), 4 deletions(-)
```

净增 176 行,其中 118 行是测试。代码改动 58 行(含 ponytail 注释)。三块互不耦合,可独立 cherry-pick。
