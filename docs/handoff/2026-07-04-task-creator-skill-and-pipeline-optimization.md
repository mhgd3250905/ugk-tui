# 交接:task-creator skill 优化 + 配音流水线 taskbook 体系

> **交接时间**:2026-07-04
> **上一会话**:从"评估 video-downloader task 设计"开始,演化成 task-creator skill 的系统性优化 + 配音流水线 5 个 task 的实战优化 + 隔离测试验证 skill。
> **新会话目标**:继续制作新 task / 优化旧 task,task-creator skill 是核心工具。

---

## 1. 核心产出:task-creator skill(在 ugk-core 仓库)

**位置**:`E:/AII/worktrees/ugk-core/codex-worktree-1/skills/task-creator/SKILL.md`(691 行)
**安装态**:`C:/Users/29485/AppData/Roaming/npm/node_modules/ugk-agent@/skills/task-creator/`(npm link 指向开发仓库,改开发仓库即生效)
**仓库**:`https://github.com/mhgd3250905/ugk-tui`,分支 `codex/worktree-1`,已推送

### 本会话的 5 次 skill 迭代(都在 main 上)

| commit | 内容 | 驱动证据 |
|---|---|---|
| `d2d4d44` | 沉淀实战标准(4 铁律 + 范本指引 + 自检清单) | 配音流水线优化血泪 |
| `0dea1f1` | 测试迭代循环 4a-4d | 用户"创建初期充分测试"需求 |
| `27e86bc` | 验证已有 task SOP(体检流程) | 用户"体检已有 task"需求 |
| `a6f58b6` | 补 4 个引导缺口(requiredEnv/eval 位置/落盘措辞/outputDir) | 隔离子 agent 反馈 |
| `5dfbf07` | **verify 判别力 ≠ worker 真跑**(核心洞) | 子 agent 没 key 撒谎说收敛 |

### skill 的当前能力边界(新会话必须知道)

**skill 能引导 agent 做的**:
- 创建新 task:走「标准创建流程」5 步 + 「测试迭代循环」4a-4d
- 体检已有 task:走「验证已有 task」流程(真跑+边界刁难+报告)
- 4 条铁律已沉淀:纯函数+单测、preflight fail-loud、verify 深度、错误归因
- 范本指引:主范本 video-downloader,7 个专项范本对照表

**skill 已知的未解决问题(新会话可继续补)**:
- 自验 4(dispatcher eval)对独立作者仍是半残(eval 框架在 ugk-core 仓库,独立 taskbook 作者跑不了,只能 `/task run` 替代)
- 隔离测试还暴露过 `buildAudioDataUrl` 测试与实现不一致(mimo taskbook 里),说明子 agent 的"30 单测全过"报告需抽查核实,不能全信
- skill 没讲 `taskbook.json` 必填字段(`updatedAt` 缺了会静默不显示——隔离测试踩过,见 task-book.ts:103 的 isTaskbook 校验)

---

## 2. 配音流水线 taskbook(在用户目录,不在 git 仓库)

**位置**:`C:/Users/29485/.pi/agent/tasks/`
**备份**:`https://github.com/mhgd3250905/ugk-tasks`(public,仅含 6 个配音流水线 taskbook 的五件套,排除 taskbook.json)

### taskbook 状态表

| taskbook | 本会话改了什么 | 单测 | requiredEnv | 验证状态 |
|---|---|---|---|---|
| `video-downloader` | 分辨率档位链 + 字幕四级优先(早期) | ✓ | — | 已收敛 |
| `whisper-audio-to-text` | **空转写检测 + language 归一 + CLI 校验** | ✓ | — | 已收敛 |
| `subtitle-cleaner` | (未改,审核确认是标杆) | ✓(28个) | — | 已收敛 |
| `subtitle-fluent-translator` | (未改,审核确认扎实) | ✓ | — | 已收敛 |
| `subtitle-to-speech` | **6 路并发加速 + voice/stylePrompt 分工** | ✓ | ✓ MIMO_API_KEY | 已收敛 |
| `video-zh-composer` | **VP9 预判转码 + 字体检测 + 时长预警 + verify 加固** | ✓(34个) | — | 已收敛(端到端验证过 VP9) |
| `bilibili-downloader` | **verify 加固(音频流假通过 + duration 检查)** | — | — | 已收敛 |
| `mimo-speech-recognition` | **子 agent 隔离创建 + 鉴权头修复**(本会话新建) | ✓(30个) | ✓ MIMO_API_KEY | 已收敛(用户真跑通过) |

**未改的 taskbook**(在用户目录但本会话没动):`bili-up-homepage-spider`、`linkedin-search`、`x-search`

### ugk-tasks 备份仓库的同步状态

⚠️ **备份仓库(ugk-tasks)落后于用户目录**——本会话后期改的 taskbook(whisper/composer/tts 的优化、bilibili-downloader 的 verify 加固、mimo 新建)**都没同步到 ugk-tasks**。备份仓库还停在最初创建时的状态(只含 6 个 taskbook 的旧版本)。

新会话如果要同步:从用户目录拷最新五件套到 ugk-tasks 仓库(注意排除 taskbook.json)。

---

## 3. 隔离测试方法(新会话优化 skill 必用)

本会话验证出的 **skill 持续优化的正确方法**:

```
派子 agent(无上下文) + skill 文本 + 一个真实需求
  → 看 agent 卡在哪、误判什么、撒什么谎
  → 那就是下一个要补的缺口
```

**为什么有效**:我自己审稿审不出引导缺口(脑子里有先验知识),子 agent 没包袱,撞到哪报哪。本会话 5 次迭代里有 2 次(a6f58b6 + 5dfbf07)是隔离测试直接驱动的。

**已验证的隔离测试用例**:子 agent + task-creator skill + 小米 ASR API 文档 → 产出 mimo-speech-recognition taskbook。这个 taskbook 现在在用户目录,是真样本。

**新会话复用**:派子 agent 做一个**不同类型**的 task(如数据处理类、CDP 抓取类),看 skill 对不同场景的引导是否有新缺口。

---

## 4. 关键文件位置速查

| 什么 | 在哪 |
|---|---|
| task-creator skill 源码 | `E:/AII/worktrees/ugk-core/codex-worktree-1/skills/task-creator/SKILL.md` |
| dispatcher eval 框架 | `E:/AII/worktrees/ugk-core/codex-worktree-1/scripts/eval-dispatcher.mjs` |
| dispatcher eval 用例集 | `E:/AII/worktrees/ugk-core/codex-worktree-1/tests/fixtures/dispatcher-evals/*.cases.json` |
| eval taskbook 快照 | `E:/AII/worktrees/ugk-core/codex-worktree-1/tests/fixtures/taskbooks/` |
| /task 流程源码 | `E:/AII/worktrees/ugk-core/codex-worktree-1/extensions/task/` |
| 用户 taskbook | `C:/Users/29485/.pi/agent/tasks/` |
| taskbook 备份仓库 | `https://github.com/mhgd3250905/ugk-tasks` |
| ugk-core 主仓库 | `https://github.com/mhgd3250905/ugk-tui`(分支 codex/worktree-1) |
| followup 设计文档 | `E:/AII/worktrees/ugk-core/codex-worktree-1/docs/design/task-extension-followup-9.md`(dispatcher eval 框架) |

---

## 5. 新会话建议的入手点

1. **如果要优化旧 task**:用「验证已有 task」SOP,对还没体检的 taskbook(bili-up-homepage-spider / linkedin-search / x-search)跑一遍边界刁难。参考本会话对 bilibili-downloader 的体检(发现 2 个 verify 假通过)。
2. **如果要创建新 task**:让 agent 按 task-creator SOP 走,重点盯 4a 第二层(worker 真跑)和 4d 第 4 条收敛——这是最容易撒谎的地方。
3. **如果要继续优化 skill**:用隔离测试方法(派子 agent 做不同类型 task),看新缺口。
4. **如果要同步备份**:把用户目录最新 taskbook 同步到 ugk-tasks 仓库(落后了)。

---

## 6. 本会话的关键认知(传给新会话的自己)

- **task 设计的核心矛盾**:不是"让 agent 听话",而是"让 agent 偏航也过不了验收"。决策进脚本(确定性),agent 只翻译意图。
- **测试两层不能混**:verify 判别力(构造产物)≠ worker 真跑(真实资源)。调外部 API 的 task 必须 worker 真跑,否则第一次用就炸。
- **隔离测试是 skill 优化的正确方法**:比作者自己审稿有效得多。
- **范本比抽象规则有用**:task-creator 的「标准范本指引」让 agent 对照真实 taskbook,比读抽象规则有效。主范本是 video-downloader。
