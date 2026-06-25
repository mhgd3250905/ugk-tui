import { discoverAgents } from "../subagent-agents.ts";
import { getFinalOutput, isFailedResult, type SingleResult, type UsageStats } from "../subagent-runtime.ts";
import { runSingleAgent } from "../subagent.ts";

export interface TaskWorkerInput {
	skill: string;
	contract: unknown;
	runtimeInput: unknown;
	outputDir: string;
	feedback?: unknown;
}

export interface TaskWorkerResult {
	ok: boolean;
	outputDir: string;
	summary: string;
	errorMessage?: string;
	usage: { input: number; output: number; cost: number };
}

type RunSingleAgentLike = typeof runSingleAgent;
let workerRunnerForTests: RunSingleAgentLike | undefined;

export function setTaskWorkerRunnerForTests(runner: RunSingleAgentLike | undefined): void {
	workerRunnerForTests = runner;
}

function compactUsage(usage: UsageStats): TaskWorkerResult["usage"] {
	return {
		input: usage.input,
		output: usage.output,
		cost: usage.cost,
	};
}

export function buildTaskWorkerPrompt(input: TaskWorkerInput): string {
	return [
		"你是 /task worker。按 skill 和 contract 完成一次 one-step 任务。",
		"",
		"硬规则:",
		`- 所有产出必须落到: ${input.outputDir}`,
		"- 严格按 contract.artifacts 命名产物",
		"- 只看 skill + contract,不要猜测隐藏验收标准",
		"- 完成后输出简短产出摘要",
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

export async function dispatchWorker(
	input: TaskWorkerInput,
	opts: { cwd: string; signal?: AbortSignal; onUpdate?: (text: string) => void; env?: Record<string, string | undefined> },
): Promise<TaskWorkerResult> {
	const discovery = discoverAgents(opts.cwd, "both");
	const runner = workerRunnerForTests ?? runSingleAgent;
	let result: SingleResult;
	try {
		result = await runner(
			opts.cwd,
			discovery.agents,
			"worker",
			buildTaskWorkerPrompt(input),
			opts.cwd,
			undefined,
			opts.signal,
			opts.onUpdate
				? (partial) => {
					const text = partial.content.find((part) => part.type === "text")?.text;
					if (typeof text === "string") opts.onUpdate?.(text);
				}
				: undefined,
			(results) => ({
				mode: "single",
				agentScope: "both",
				projectAgentsDir: discovery.projectAgentsDir,
				results,
			}),
			opts.env,
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
				usage: { input: 0, output: 0, cost: 0 },
			};
		}
		throw error;
	}
	const summary = getFinalOutput(result.messages);
	const failed = isFailedResult(result);
	return {
		ok: !failed,
		outputDir: input.outputDir,
		summary,
		errorMessage: failed ? (result.errorMessage || result.stderr || summary || `worker exit ${result.exitCode}`) : undefined,
		usage: compactUsage(result.usage),
	};
}
