# Flow 判定记录签名链设计

日期:2026-06-18

状态:设计稿(待确认后实现)

## 一、问题

现状下 `.flow/` 的判定记录(task 状态、review 结论、validation 结果)全是明文 JSON,和 agent 的劳动产物(SKILL.md / output/ / evidence/)共享同一文件系统。runtime 用状态机保证"通过 API 的写入合法",但 agent 有 write/edit 工具,能直接 `writeFileSync` 改任何判定文件,绕过状态机。

实测暴露的真实 bug:agent 在 review 阶段没走 `/flow task accept`,而是自己手写了 review.json(status 写成 `"verified"` —— 一个从来不是合法 review status 的值)和 task.json(status 写成 `"active"`),导致后续 `/flow run` 因校验不过被拦。这是"agent 不小心写错格式"的典型;但同样的机制下,agent 也能**蓄意伪造**(把失败 run 标成 accepted)。

物理保护(chmod 444)只能锁部分文件、部分时段,且无法在文件系统层区分"runtime 写"和"agent 写"。只要真相存在 agent 能碰的文件里,agent 就能伪造真相。

## 二、目标(打卡机模型)

把 Flow 的判定记录从"文件即真相"改成"签名即真相":

- agent 仍能写文件(它的劳动产物 SKILL/output/evidence 必须能写,否则干不了活)。
- 但 agent 伪造不了"已被 runtime 接受"这个事实——因为判定记录的关键字段带 HMAC 签名,签名密钥 agent 拿不到。
- runtime 读判定记录时验签,验不过的当伪造丢弃。

核心:隔离靠**密码学**,不靠"文件放哪"或"chmod"。

## 三、威胁模型

**威胁**:Flow agent(当前项目里跑的 LLM)。它能读写工作区(cwd 内)文件,有 write/edit/bash 工具。

**不是威胁**:
- 恶意本地进程(超出范围;本地权限模型由 OS 管)
- 跨设备攻击者

**agent 的实际行为模式**:主要是"顺手改了 task.json 觉得这样对"(不小心写错),不是"先偷密钥再伪造"(蓄意攻击)。但设计必须能防后者,否则隔离是假的。

## 四、密钥模型

### 主密钥
- 位置:`~/.flow-master-key`(用户 home 目录,不在任何项目 `.flow/` 内)。
- 内容:32 字节随机,base64 存储。
- 权限:0600(Unix)/ ACL 限当前用户(Windows)。
- 生成:首次需要时自动生成(若无)。
- **不可恢复**:丢失即丢失,见第七节。

### 项目密钥(派生,不存储)
- `projectKey = HKDF-SHA256(masterKey, salt = SHA256(path.resolve(cwd)), info = "flow-task-signing")`
- 派生而非存储:同用户 + 同项目路径始终派生出同密钥;无需每项目存密钥文件。
- 路径敏感性:项目改路径 → 派生不同密钥 → 旧签名失效 → 触发首次重签(见第八节)。

### 为什么 agent 拿不到密钥
- 主密钥在 `~/`,agent 工具默认操作 cwd 内文件;`~/.flow-master-key` 不在它的常规工作上下文里。
- 这是"实际隔离"而非"密码学绝对隔离"——如果 agent 被指示"去读 ~/.flow-master-key",它能读到。但结合威胁模型(agent 不蓄意偷密钥),这个隔离度足够。
- 项目密钥从不落盘(派生),agent 无文件可读。

## 五、签名覆盖范围

不是签整个文件,是签**判定记录的关键字段**(最小签名面,降低维护成本)。

### task.json
签 `taskSignature` 覆盖:`{ id, status, version, latest_review_run, ready_origin }`
- 这是状态机的核心字段;agent 改其中任何一个而不知会 runtime → 签名失效。

### review.json
签 `reviewSignature` 覆盖:`{ taskId, runId, status, taskVersion, acceptedAt }`
- 防 agent 把 rejected 改成 accepted,或伪造 acceptedAt。

### validation.json
签 `validationSignature` 覆盖:`{ taskId, runId, result, scope, createdAt }`
- 防 agent 把 FAIL 改成 PASS。

### 不签的字段
- task.json 的 goal/scope/tags/description:这些是 task 设计内容,agent 在 review 写回经验时**该**改,不该锁。
- review.json 的 decisions/updatedFiles:复盘叙述,允许 agent 写。
- 留文件的产物(SKILL.md/output/evidence):完全不签,agent 自由写。

## 六、签名与验证

### 签名算法
`HMAC-SHA256(projectKey, canonicalJSON(coveredFields))`

canonicalJSON:对象 key 按 ASCII 排序,UTF-8,无多余空白。确保序列化确定(同字段值永远同签名)。

### 存储
判定记录文件里加一个 `_sig` 字段:
```json
{
  "id": "xxx",
  "status": "ready",
  "version": 1,
  ...,
  "_sig": {
    "alg": "hmac-sha256",
    "covered": ["id", "status", "version", "latest_review_run", "ready_origin"],
    "value": "base64...",
    "signedAt": "2026-06-18T..."
  }
}
```
`covered` 列出签了哪些字段,便于验签时知道覆盖范围(防"加了个字段但没签"的漏签)。

### 验证时机
- runtime **每次读**判定记录(task.json / review.json / validation.json)时验签。
- 验签流程:取 `covered` 字段 → canonicalJSON → HMAC → 比对 `_sig.value`。
- 验过:信任记录。
- 验不过(或无 `_sig` 且非首次迁移窗口):当伪造,丢弃该记录,runtime 按记录缺失处理(如 task 状态未知 → 当 draft;或报错让用户 reset)。

### 反馈安全要求(铁律)

**验签失败的反馈绝不能向 agent 暴露签名机制的存在。** 否则反馈本身成了伪造指南——告诉 agent "存在签名/密钥/你需要拿到密钥",等于给它攻击路线图。

实现时必须遵守:
1. **禁止出现的词**(在任何 agent 可见的反馈/prompt/错误信息里):签名、密钥、HMAC、`_sig`、签名验证、signature、key。
2. **验签失败的反馈伪装成普通数据损坏**:用"状态记录已损坏"、"无法读取 task 状态"、"task 元数据不可用"这类中性措辞,和"文件读不到 / JSON 解析失败"用同一套语气。
3. **只给恢复动作,不给失败原因**:反馈只说"请重新 prove"或提示 reset,不解释为什么记录不可信。
4. **agent 可见与不可见反馈区分**:签名相关的诊断细节(哪个字段、签名值)只能进 runtime 内部日志(不发给 agent);发给 agent 的是中性错误。

这条是安全设计的一部分,实现时必须逐条对照检查,review 时也要专门验证"反馈里有没有泄露签名机制的字眼"。

### 写入流程(runtime 独占)
- 状态机 `transition()` / `acceptFlowReview()` / `validateFlowRun()` 等写判定记录时,计算签名一并写入。
- agent 没有签名能力(拿不到 projectKey)→ 它写的任何改动都不会有合法 `_sig`。

## 七、密钥丢失处理(不可恢复 + reset)

- 主密钥丢失:所有历史 `_sig` 验不过。
- 不提供"找回"——诚实承认丢了就是丢了。
- 提供 `/flow reset-signing` 命令:
  - 扫描所有当前验不过的判定记录。
  - **一次性**信任它们的当前内容 + 重新签名(用新/恢复后的密钥)。
  - 明确警告"将重新签名 N 条记录,这等于信任它们当前的内容"。
  - 留痕:写 `.flow/.signing-reset-log`,记录时间 + 重签的记录列表。
- reset 是用户**主动、显式、有警告**的操作,不是静默发生。

## 八、迁移(旧数据 + 换路径)

### 旧数据(无 `_sig` 字段)
- runtime 启动时检测:记录无 `_sig` 且本机首次见到该项目(无 `.flow/.migrated` 标记)。
- 触发一次性迁移:信任旧记录当前内容 + 用本机项目密钥签名 + 写 `.flow/.migrated`。
- 之后:无 `_sig` 的记录不再被信任(当伪造丢弃)。

### 换路径 / 换机器
- 项目路径变 → 派生密钥变 → 旧 `_sig` 验不过。
- 等同于"旧数据"场景:首次在新路径启动 → 一次性重签 + 写 `.flow/.migrated`(针对新路径)。
- 复制 `.flow/` 到新机器:首次启动重签一次,之后正常。**满足"复制解压即可迁移"**,代价是一次性重签。

## 九、性能

- HMAC-SHA256 处理 Flow 记record(几百字节)耗时约 0.0000005 秒(微秒级)。
- runtime 一次状态读 = 一次 readFileSync(毫秒级)+ 一次 HMAC(微秒级)。HMAC 相对磁盘 IO 可忽略。
- 全会话状态读撑死几百次,签名总耗时 < 1 毫秒。用户无感。

## 十、不在本设计范围

- agent 劳动产物(SKILL.md / output/ / evidence/)的完整性:不签,agent 自由写。
- driver 期间的物理只读保护:保留(防 agent 改 task 设计资产),与本机制正交。
- 跨用户/跨设备同步:超出范围(单机单用户模型)。

## 十一、实现顺序(建议)

1. **签名基础设施**:`flow-signing.ts`(密钥派生 + HMAC + canonicalJSON + 验签)。单元测试。
2. **task.json 签名接入**:状态机 `transition()` 写时签名,`readTaskMetadata`/`readFlowTask` 读时验签。集成测试。
3. **review.json / validation.json 签名接入**:同理。
4. **迁移逻辑**:首次重签 + `.flow/.migrated`。
5. **`/flow reset-signing` 命令**。
6. **旧数据兜底**(临时):lifecycle-gates 对 `verified` 等旧 status 的识别(在迁移落地前的过渡保护)。

每步跑全量测试,任何一步验签失败不能让流程继续(防"验不过就放过"的降级)。

## 十二、待确认/风险

- **canonicalJSON 实现必须严格**:字段顺序、数字表示、Unicode。出错会导致合法记录验不过。需用确定性序列化 + 测试覆盖。
- **`_sig` 字段不能被 agent 当普通字段签**:agent 即使模仿格式,没有 projectKey 也算不出正确 value。
- **密钥派生的路径敏感性**:用户改项目文件夹名 → 重签。可接受(一次性),但要在文档/warning 里说明。
- **node:sqlite 已验证可用(Node 24 内置)**,但本设计不依赖 sqlite;HMAC 用 Node 内置 crypto,零新依赖。

## 十三、为什么不用 sqlite

评估过 sqlite(含放工作区外)。结论:
- sqlite 解决查询/事务,但**不解决伪造**(除非配合工作区外 + 仍要管密钥)。
- sqlite 引入 schema 迁移负担 + 二进制调试难 + 仍是磁盘文件可被覆盖。
- 签名链直击伪造(密码学),保留 JSON 可读性,零新依赖,迁移简单(复制 + 一次性重签)。
- sqlite 的查询优势对 Flow 的数据量(每项目几十条记录)无意义——遍历 JSON 足够快。
