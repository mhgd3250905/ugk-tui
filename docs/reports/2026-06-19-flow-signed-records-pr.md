# Flow 判定记录签名链(防 agent 伪造)

> 这是安全相关的底层改动。给 Flow 的判定记录(task 状态/review/validation)加 HMAC 签名,
> 让 agent 伪造不了"已被 runtime 接受"。审核重点:task.json 签名链是否闭合、反馈是否泄露、
> 已知 TODO 是否可接受。

## TL;DR

Flow 的判定记录原本是明文 JSON,agent 能直接 writeFileSync 改 task 状态/review 结论,绕过状态机。实测 bug:agent 在 review 阶段手写 review.json(status 写成 `"verified"` —— 一个非法值),导致后续 `/flow run` 卡死。本 PR 用 HMAC 签名链根治:判定记录的关键字段带签名,签名密钥从 `~/.flow-master-key` 派生、不在 `.flow/` 里,agent 拿不到密钥就伪造不了。

- **task.json 签名链完整闭合**(核心防线):写签 + 读验 + gate 拦 + 状态机拒 + 中性反馈
- 8 个 commit,每个通过完整测试
- **355 pass / 0 fail**
- 零新依赖(Node 内置 crypto + HKDF)

## 一、设计初衷(为什么改)

起因:用户实测 Flow 时,agent 没走 `/flow task accept`,而是自己手写了 review.json(`status: "verified"`)和 task.json(`status: "active"`),格式不合法导致后续 run 被拦。这不是个例——只要真相存在 agent 能碰的文件里,agent 就能伪造真相。物理保护(chmod 444)只能锁部分文件、部分时段,且无法区分"runtime 写"和"agent 写"。

核心思路(打卡机模型):判定记录带 HMAC 签名,密钥 agent 碰不到。runtime 读时验签,验不过当伪造丢弃。agent 改得了文件内容,但改不了签名——因为算签名需要密钥,而密钥不在它够得到的地方。

## 二、设计决策(都经过产品方确认)

| 决定 | 选择 | 含义 |
|---|---|---|
| 隔离方式 | HMAC 签名链(非 sqlite) | sqlite 不解决伪造(除非配合工作区外);签名链直击伪造,保留 JSON 可读,零依赖 |
| 密钥位置 | `~/.flow-master-key`,派生项目密钥 | 不在 `.flow/`,agent 工作区碰不到;项目密钥 HKDF 派生不落盘 |
| 密钥丢失 | 不可恢复 + reset 命令 | 诚实承认丢了就是丢了;reset 是主动+警告+留痕 |
| 迁移 | 复制 `.flow/` 首次重签 | 一次性,之后严格验证 |
| 反馈安全 | 中性措辞,不泄露签名机制 | 验签失败的反馈伪装成普通数据损坏,禁词清单 |

详见 `docs/design/2026-06-18-flow-signed-records-design.md`。

## 三、已落地(task.json 完整签名链)

```
flow-signing.ts(新):密钥派生(HKDF) + HMAC + canonicalJSON + 验签 + CORRUPT_FEEDBACK
  ↓
task-store.ts:writeFlowTask 写时签名 + 关闭迁移窗口;readFlowTask 读时验签 + _signatureBroken
  ↓
lifecycle-gates.ts:readTaskMetadata 验签,损坏返回中性 CORRUPT_FEEDBACK
  ↓
task-state.ts:transition 拒绝 _signatureBroken 记录(伪造 task 推进不了状态)
```

**核心防线闭合**:agent 改 task.json 的 status → 签名对不上 → readFlowTask 标 broken → gate 返回中性反馈 → transition 拒绝。agent 绕不过。

同时:review-store / run-validation 的**写时签名**已加(start/accept/reject/validateFlowRun 带 cwd 签名)。

## 四、反馈安全(子 agent 确认做得对)

- `CORRUPT_FEEDBACK` 预写中性文案("task 状态记录不可用,建议重新 prove"),测试扫描禁词(签名/密钥/HMAC/_sig/signature/key)零出现。
- 反馈只给安全恢复动作(重新 prove / 交回用户),不删数据、不手动改记录。
- 签名细节(哪个字段、签名值)只进 runtime 内部,不发给 agent。

## 五、已知 TODO(独立 review 发现,诚实记录)

### P1:review.json / validation.json 读取层未验签
- **现状**:写时签名已加(start/accept/reject/validateFlowRun),但 readFlowReview / readFlowRunValidation **不验签**。
- **影响**:agent 仍能改 review.json 的 status 不被发现。
- **临时缓解**:task.json 的 status 是签名保护的,review 即使被改,task 状态仍受状态机 + task.json 签名约束(agent 改不了 task 的 ready/needs-work)。
- **未做原因**:改 readFlowReview/readFlowRunValidation 签名影响所有调用点 + 测试造数据方式,独立 review 后尝试修复导致 10+ 测试不稳,回退到稳定态。需单独一轮。
- **后续**:加 Verified 变体 + 决策点接入 + 测试全面更新。

### P2:迁移窗口多 task + 跨机器
- 窗口是项目级(.flow/.migrated),第一个 task 写入即关闭,其他无签名旧 task 在窗口外被拒。
- 跨机器:.migrated 跟着拷贝 → 卡死,无重签路径。
- **后续**:启动期扫描重签 或 `/flow reset-signing` 命令。

### P3:canonicalJSON 嵌套 undefined 未测
- 当前 covered 字段全是标量,不触发。后续扩展 covered 到对象字段时需补测试。

## 六、验证

```bash
npm test          # 355 pass / 0 fail
git diff --check  # 通过
```

新增测试:
- flow-signing.test.ts(16 个):canonicalJSON 确定性、密钥派生、签名验证(合法/篡改/无签/字段缺失)、反馈禁词扫描。
- flow-task-store.test.ts(+5):签名写入+窗口关闭、窗口内旧数据信任、窗口外篡改检测、窗口外无签拒绝。

## 七、审核建议

重点看:
1. **flow-signing.ts 的密钥模型**:HKDF 派生是否正确,缓存是否跨 cwd 串。
2. **task.json 签名链闭合性**:writeFlowTask→readFlowTask→readTaskMetadata→transition 四层是否真的堵死伪造。
3. **反馈安全**:CORRUPT_FEEDBACK 使用点是否都中性,有没有泄露签名机制。
4. **已知 TODO 是否可接受**:P1(review/validation 验签)有 task.json 缓解,P2(迁移)影响面有限。

## 八、为什么不用 sqlite(评估过)

sqlite 解决查询/事务,但**不解决伪造**——除非配合"放工作区外 + 仍要管密钥"。而且 sqlite 带 schema 迁移负担 + 二进制调试难 + 仍是磁盘文件可被覆盖。签名链直击伪造,保留 JSON 可读,零新依赖。设计文档第十三节有完整对比。

## 关键文件导航

| 文件 | 看什么 |
|---|---|
| `docs/design/2026-06-18-flow-signed-records-design.md` | 完整设计 + 实现状态 + TODO |
| `extensions/flow/flow-signing.ts` | 签名基础设施(最核心) |
| `extensions/flow/task-store.ts` | task.json 签名写入/验签 |
| `tests/flow-signing.test.ts` | 签名机制测试(含禁词扫描) |
