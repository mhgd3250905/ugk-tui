import test from "node:test";
import assert from "node:assert/strict";
import {
	CRON_PATHS,
	formatCronHealth,
	formatCronJobCreated,
	formatCronJobList,
	formatCronRunHistory,
} from "../extensions/cron-contract.ts";

test("defines cron HTTP paths in one place", () => {
	assert.equal(CRON_PATHS.health, "/health");
	assert.equal(CRON_PATHS.jobs, "/jobs");
	assert.equal(CRON_PATHS.job("job_123"), "/jobs/job_123");
	assert.equal(CRON_PATHS.jobRuns("job_123"), "/jobs/job_123/runs");
	assert.equal(CRON_PATHS.runs, "/runs");
});

test("formats cron health, job list, created job, and history text", () => {
	assert.equal(formatCronHealth({ jobs: 2, scheduled: 1, port: 17741 }, "http://127.0.0.1:17741"), "⏱️ Cron service\n✅ online\n📋 jobs: 2 (scheduled 1)\n📍 http://127.0.0.1:17741");
	assert.equal(formatCronJobList([]), "📭 没有定时任务。用 action=add 新增(schedule + prompt)。");
	assert.match(
		formatCronJobList([
			{ id: "job_1", name: "daily", schedule: "0 9 * * *", prompt: "日报", enabled: true, createdAt: "2026-06-16T00:00:00.000Z" },
		]),
		/^📋 定时任务\(1 个\):/,
	);
	assert.equal(
		formatCronJobCreated({
			id: "job_1",
			name: "daily",
			schedule: "0 9 * * *",
			prompt: "日报",
			model: "deepseek-v4-pro",
			enabled: true,
			createdAt: "2026-06-16T00:00:00.000Z",
		}),
		"✅ 已新增任务: daily\n⏰ 调度: 0 9 * * *\n🧾 任务: 日报\n🤖 模型: deepseek-v4-pro\n🆔 id: job_1\n\n到点会自动执行,结果在 ~/.pi/agent/cron-output/",
	);
	assert.equal(formatCronRunHistory([]), "📭 没有执行历史(任务还没到点触发过)。");
	assert.match(
		formatCronRunHistory([
			{
				id: "run_1",
				jobId: "job_1",
				jobName: "daily",
				startedAt: "2026-06-16T00:00:00.000Z",
				finishedAt: "2026-06-16T00:00:02.000Z",
				exitCode: 0,
				outputFile: "out.txt",
			},
		]),
		/^📜 执行历史\(最近 1 条\):/,
	);
});

test("formatCronRunHistory includes stderr snippets for failed runs", () => {
	const text = formatCronRunHistory([
		{
			id: "run_1",
			jobId: "job_1",
			jobName: "daily",
			startedAt: "2026-06-16T00:00:00.000Z",
			finishedAt: "2026-06-16T00:00:02.000Z",
			exitCode: 1,
			outputFile: "out.txt",
			stderrSnippet: "missing API key",
		},
	]);

	assert.match(text, /❌ daily → exit=1/);
	assert.match(text, /💥 错误: missing API key/);
});
