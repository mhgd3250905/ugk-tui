// task worker —— 单个 task 单元(单位 1)的执行体。
// 并行是 run_task({tasks:[...]}) 工具层的事(task.ts 文件头红线②),这里只负责一次执行。
// 不要在 worker 内引入"感知其他 worker / 跨 worker 协调"的逻辑 —— 那违反 task 原子单元语义。
import { peekWorkerLifecycleFactory } from "../shared/worker-lifecycle.ts";
import { discoverAgents } from "../subagent-agents.ts";
import { getFinalOutput, isFailedResult, type SingleResult, type UsageStats } from "../subagent-runtime.ts";
import { runSingleAgent, type OnUpdateCallback } from "../subagent.ts";
// ponytail: worker 运行日志落盘(E 盘,诊断用)。默认开,UGK_WORKER_LOG_DIR 可改路径,设为空字符串关闭。
export async function dumpWorkerLog(input: TaskWorkerInput, result: SingleResult, startedAt: number): Promise<void> {
	try {
		const logDir = process.env.UGK_WORKER_LOG_DIR ?? "E:/AII/ugk-worker-logs";
		if (!logDir) return; // 显式置空 → 关闭
		const { mkdirSync, writeFileSync } = await import("node:fs");
		const { join, basename, dirname } = await import("node:path");
		// ponytail: runId = outputDir 的父目录名(task-<name>-<ts>-<rand>),与 task.ts
		// 启动时/完成时显示给用户的 runId 完全一致。用户拿 runId 来 ugk-worker-logs/
		// grep 文件名必须能命中 —— 旧实现文件名只含 ts(丢 rand),用户 grep 不到,是 bug。
		const runId = basename(dirname(String(input.outputDir || ""))) || `task-unknown-${startedAt}`;
		// taskbook 名从 runId 反推:剥掉 task- 前缀和 -<ts>-<rand> 后缀。
		const taskbook = runId.match(/^task-(.+)-\d+-[a-z0-9]+$/i)?.[1] || "unknown";
		const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
		// ponytail: 文件名 = <runId>-<stamp>,含完整 runId(含随机串),防同 taskbook 同秒
		// 并行 worker 日志互相覆盖,且用户 grep runId 能直接命中。
		const base = `${runId}-${stamp}`;
		mkdirSync(logDir, { recursive: true });

		// 可读文本日志:每行一个事件,相对时间(秒)
		const events: string[] = [];
		const fmtRel = (ms: number) => `[+${(ms / 1000).toFixed(1)}s]`.padStart(12);
		events.push(`# worker-log  taskbook=${taskbook}  runId=${runId}  started=${new Date(startedAt).toISOString()}`);
		events.push(`# outputDir=${input.outputDir}`);
		const phases = result.phases || {};
		events.push(`# phases: ${Object.entries(phases).map(([k, v]) => `${k}=${Math.round(Number(v))}ms`).join("  ") || "(none)"}`);
		events.push("");

		const messages = Array.isArray(result.messages) ? result.messages : [];
		// 找最早 timestamp 作 t0。timestamp 可能是 epoch 毫秒数字(worker message)或 ISO 字符串(其它来源)。
		const tsOf = (m: any): number => {
			const t = m?.timestamp ?? m?.message?.timestamp;
			if (typeof t === "number") return Number.isFinite(t) ? t : NaN;
			if (typeof t === "string") return Date.parse(t);
			return NaN;
		};
		const t0 = messages.reduce((min, m) => {
			const t = tsOf(m);
			return Number.isFinite(t) && (min === 0 || t < min) ? t : min;
		}, 0);

		for (const m of messages) {
			const ts = tsOf(m);
			const rel = Number.isFinite(ts) && t0 ? ts - t0 : 0;
			const role = m?.role || m?.message?.role || m?.type || "?";
			const content = m?.content || m?.message?.content;
			if (!Array.isArray(content)) {
				// 纯文本消息
				const text = typeof content === "string" ? content : "";
				if (text) events.push(`${fmtRel(rel)}  ${role.toUpperCase()}  ${text.slice(0, 200)}`);
				continue;
			}
			for (const part of content) {
				if (part.type === "thinking" && part.thinking) {
					events.push(`${fmtRel(rel)}  THINK       ${part.thinking.slice(0, 180).replace(/\n/g, " ")}`);
				} else if (part.type === "text" && part.text) {
					events.push(`${fmtRel(rel)}  ${role.toUpperCase().padEnd(10)} ${part.text.slice(0, 200).replace(/\n/g, " ")}`);
				} else if (part.type === "tool_use") {
					const inp = part.input || {};
					let inpSummary = "";
					if (part.name === "chrome_cdp") {
						inpSummary = `action=${inp.action || "?"}`;
						if (inp.url) inpSummary += ` url=${String(inp.url).slice(0, 80)}`;
						if (inp.timeoutMs) inpSummary += ` timeoutMs=${inp.timeoutMs}`;
						if (inp.expression) inpSummary += ` exprLen=${String(inp.expression).length}`;
					} else if (part.name === "bash") {
						inpSummary = String(inp.command || "").slice(0, 100);
					} else if (part.name === "write" || part.name === "edit") {
						inpSummary = String(inp.file_path || "").slice(0, 80);
					} else {
						inpSummary = JSON.stringify(inp).slice(0, 120);
					}
					events.push(`${fmtRel(rel)}  TOOL_USE    ${part.name}  ${inpSummary}`);
				} else if (part.type === "tool_result") {
					const raw = typeof part.content === "string" ? part.content : JSON.stringify(part.content || "");
					const ok = part.isError ? "ERR" : "ok";
					events.push(`${fmtRel(rel)}  TOOL_RESULT ${ok}  ${raw.slice(0, 180).replace(/\n/g, " ")}`);
				}
			}
		}
		events.push("");
		events.push(`# done  exitCode=${result.exitCode}  ok=${!isFailedResult(result)}  messages=${messages.length}  stderr=${result.stderr ? result.stderr.length + "chars" : "empty"}`);
		writeFileSync(join(logDir, `${base}.log`), events.join("\n"), "utf8");
		// 原始 JSON(便于程序分析,含完整 input/result)
		writeFileSync(join(logDir, `${base}.json`), JSON.stringify({
			taskbook, runId, startedAt: new Date(startedAt).toISOString(),
			outputDir: input.outputDir,
			runtimeInput: input.runtimeInput,
			phases,
			exitCode: result.exitCode,
			ok: !isFailedResult(result),
			model: result.model,
			usage: result.usage,
			messages,
		}, null, 2), "utf8");
	} catch (e) {
		// 日志失败不影响 worker 主流程
		console.error?.(`[worker-log] dump failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

export interface TaskWorkerInput {
	skill: string;
	contract: unknown;
	runtimeInput: unknown;
	outputDir: string;
	feedback?: unknown;
}

export interface TaskWorkerUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface TaskWorkerResult {
	ok: boolean;
	outputDir: string;
	summary: string;
	errorMessage?: string;
	usage: TaskWorkerUsage;
	model?: string;
	phases?: Record<string, number>; // ponytail: 诊断用,worker 子进程各阶段耗时(ms)
}

type RunSingleAgentLike = typeof runSingleAgent;
let workerRunnerForTests: RunSingleAgentLike | undefined;

export function setTaskWorkerRunnerForTests(runner: RunSingleAgentLike | undefined): void {
	workerRunnerForTests = runner;
}

function compactUsage(usage: UsageStats): TaskWorkerUsage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		cost: usage.cost,
	};
}

export function buildTaskWorkerPrompt(input: TaskWorkerInput, taskDir?: string): string {
	return [
		"你是 /task worker。按 skill 和 contract 完成一次 one-step 任务。",
		"",
		"硬规则:",
		`- 所有产出必须落到: ${input.outputDir}`,
		"- 严格按 contract.artifacts 命名产物",
		"- 只看 skill + contract,不要猜测隐藏验收标准",
		"- 完成后输出简短产出摘要",
		// ponytail: 仅在已落盘 taskbook 的 run 里注入 TASK_DIR(创建自证阶段无 taskDir)。
		// taskbook 可带 scripts/ 子目录,worker 用 $TASK_DIR 定位自带脚本,不必临时现写。
		taskDir ? `- 自带脚本在 $TASK_DIR/scripts/(环境变量 TASK_DIR=${taskDir}),skill.md 里引用的脚本优先从这里调用` : "",
		input.feedback ? `- 上一轮失败反馈: ${JSON.stringify(input.feedback, null, "\t")}` : "",
		"",
		"## skill.md",
		input.skill,
		"",
		"## contract.json",
		JSON.stringify(input.contract, null, "\t"),
		"",
		"## runtime input",
		JSON.stringify(input.runtimeInput, null, "\t"),
	].filter(Boolean).join("\n");
}

// 取 text 的首个非空行(两分支共用)。
function firstNonEmptyLine(content: SingleResult["messages"][number]["content"]): string {
	const text = content.find((part) => part.type === "text")?.text ?? "";
	return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

// ponytail: 用户要"大概步骤 + 关键节点(失败)"。
// 大概步骤 = worker 每轮决策后写的文字 summary(它会说"正在搜索/抓取/写入"),取首行。
// 关键节点 = 工具调用失败 —— 失败的 toolResult 成一行 ✖。
// 成功的工具调用和 toolResult 是噪音(逐条报太繁琐),不推。
// 截断交给下游 formatProgressLines(它对每条 onUpdate 文本都做 120 截断),这里不重复。
function formatMessageProgress(message: SingleResult["messages"][number]): string[] {
	if (message.role === "assistant") {
		const head = firstNonEmptyLine(message.content);
		return head ? [head] : [];
	}
	if (message.role === "toolResult" && message.isError) {
		const head = firstNonEmptyLine(message.content);
		return [`✖ ${message.toolName}: ${head}`];
	}
	return [];
}

export async function dispatchWorker(
	input: TaskWorkerInput,
	opts: { cwd: string; signal?: AbortSignal; onUpdate?: (text: string) => void; env?: Record<string, string | undefined> },
): Promise<TaskWorkerResult> {
	const discovery = discoverAgents(opts.cwd, "both");
	const runner = workerRunnerForTests ?? runSingleAgent;
	// ponytail: 依赖反转 —— task/ 不能 import chrome-cdp/(架构守卫强制)。chrome-cdp 把 lifecycle
	// 工厂注册到 shared/worker-lifecycle(组合根接线时),这里按 env 信号 peek 出来用。
	// 只有会用 chrome_cdp 的 worker(env 带 UGK_TASK_ALLOW_CHROME_CDP)才开 tab;否则 undefined。
	// subagent/parallel/checker/guide/reviewer 路径都不传 lifecycle,零行为变化。
	const factory = peekWorkerLifecycleFactory();
	const cdpPort = opts.env?.UGK_CDP_PORT ? Number(opts.env.UGK_CDP_PORT) : 9222;
	const lifecycle = opts.env?.UGK_TASK_ALLOW_CHROME_CDP && factory ? factory(cdpPort) : undefined;
	const workerStartedAt = Date.now(); // ponytail: worker 日志的 t0(spawn 前)
	let result: SingleResult;
	try {
		result = await runner(
			opts.cwd,
			discovery.agents,
			"worker",
			buildTaskWorkerPrompt(input, opts.env?.TASK_DIR),
			opts.cwd,
			undefined,
			opts.signal,
			opts.onUpdate
				? (partial: Parameters<OnUpdateCallback>[0]) => {
					// ponytail: content 里的流式文本(子进程 tool_execution_update 的 yt-dlp 百分比等)
					// 必须无条件优先推送 —— subagent.ts 注入的 progress partial 把它放在 content,
					// 但 details.results[0].messages 可能非空(worker 已完成 ≥1 轮,message_end 已 push)。
					// 若用 messages.length 判定是否走文本分支,多轮后的 progress 会被丢给 formatMessageProgress
					// 遍历(它只认 assistant/toolResult,不读 content)。先推 content,重复由下游
					// appendUniqueProgressLines 的 Set 去重;messages 遍历作为 assistant summary/失败 toolResult 的补充。
					const text = partial.content.find((part) => part.type === "text")?.text;
					if (typeof text === "string") opts.onUpdate?.(text);
					const result = partial.details?.results?.[0];
					// 全量遍历,重复由下游 appendUniqueProgressLines 去重(worker 轮次有限,遍历成本可忽略)。
					if (result?.messages?.length) {
						for (const message of result.messages) {
							for (const line of formatMessageProgress(message)) opts.onUpdate?.(line);
						}
					}
				}
				: undefined,
			(results) => ({
				mode: "single",
				agentScope: "both",
				projectAgentsDir: discovery.projectAgentsDir,
				results,
			}),
			opts.env,
			lifecycle,
		);
	} catch (error) {
		// ponytail: runSingleAgent 在 signal abort 时 throw "Subagent was aborted"。
		// 把它转成 {ok:false} 正常返回,让 runTaskWithRetry 的 abort 判定 / handleTaskRun
		// 的"已停止"分支生效。只在确实 abort 时吞异常,非 abort 异常照常往上抛(不掩盖真 bug)。
		if (opts.signal?.aborted) {
			return {
				ok: false,
				outputDir: input.outputDir,
				summary: "",
				errorMessage: "worker 被中断",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			};
		}
		throw error;
	}
	const summary = getFinalOutput(result.messages);
	const failed = isFailedResult(result);
	// ponytail: worker 日志落盘(不阻塞返回,失败不影响主流程)
	void dumpWorkerLog(input, result, workerStartedAt);
	return {
		ok: !failed,
		outputDir: input.outputDir,
		summary,
		errorMessage: failed ? (result.errorMessage || result.stderr || summary || `worker exit ${result.exitCode}`) : undefined,
		model: result.model,
		usage: compactUsage(result.usage),
		phases: result.phases,
	};
}
