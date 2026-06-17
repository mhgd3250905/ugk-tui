export interface CronJob {
	id: string;
	name: string;
	schedule: string;
	prompt: string;
	model?: string;
	cwd?: string;
	enabled: boolean;
	createdAt: string;
}

export interface CronRun {
	id: string;
	jobId: string;
	jobName: string;
	startedAt: string;
	finishedAt?: string;
	exitCode: number | null;
	outputFile?: string;
	stderrSnippet?: string;
}

export interface CronHealth {
	jobs: number;
	scheduled: number;
	port: number;
}

export const CRON_PATHS = {
	health: "/health",
	jobs: "/jobs",
	job: (id: string) => `/jobs/${id}`,
	jobRuns: (id: string) => `/jobs/${id}/runs`,
	runs: "/runs",
} as const;

export function formatCronHealth(health: CronHealth, baseUrl: string): string {
	return `⏱️ Cron service\n✅ online\n📋 jobs: ${health.jobs} (scheduled ${health.scheduled})\n📍 ${baseUrl}`;
}

export function formatCronJobList(jobs: CronJob[]): string {
	if (jobs.length === 0) return "📭 没有定时任务。用 action=add 新增(schedule + prompt)。";
	const lines = jobs.map(
		(j) =>
			`${j.enabled ? "✅" : "⏸️"} ${j.name} [${j.schedule}]${j.model ? ` (${j.model})` : ""}\n   id: ${j.id}\n   任务: ${j.prompt}`,
	);
	return `📋 定时任务(${jobs.length} 个):\n\n${lines.join("\n\n")}`;
}

export function formatCronJobCreated(job: CronJob): string {
	return `✅ 已新增任务: ${job.name}\n⏰ 调度: ${job.schedule}\n🧾 任务: ${job.prompt}${job.model ? `\n🤖 模型: ${job.model}` : ""}\n🆔 id: ${job.id}\n\n到点会自动执行,结果在 ~/.pi/agent/cron-output/`;
}

export function formatCronRunHistory(runs: CronRun[]): string {
	if (runs.length === 0) return "📭 没有执行历史(任务还没到点触发过)。";
	const lines = runs.map((r) => {
		const icon = r.exitCode === 0 ? "✅" : r.exitCode === null ? "⏳" : "❌";
		const fin = r.finishedAt ? ` → exit=${r.exitCode}` : " (进行中)";
		const stderr = r.stderrSnippet && r.exitCode !== 0 && r.exitCode !== null ? `\n   💥 错误: ${r.stderrSnippet}` : "";
		return `${icon} ${r.jobName}${fin}\n   ${r.startedAt}${r.outputFile ? `\n   输出:${r.outputFile}` : ""}${stderr}`;
	});
	return `📜 执行历史(最近 ${runs.length} 条):\n\n${lines.join("\n\n")}`;
}
