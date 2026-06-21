import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	appendRunToTaskbook,
	draftExperienceMd,
	isValidTaskbookName,
	listTaskbooks,
	loadTaskbook,
	saveTaskbook,
	taskbookDir,
	updateTaskbookSpec,
} from "../extensions/judge/taskbook.ts";
import type { DriverSummary, RequirementsSpec } from "../extensions/judge/judge-state.ts";
import type { Taskbook } from "../extensions/judge/taskbook.ts";

const spec: RequirementsSpec = {
	goal: "沉淀 Judge 任务书",
	hardConstraints: ["保留 Judge 监督"],
	acceptance: ["能保存任务书", "能重跑任务书"],
	forbidden: ["复活 flow"],
	context: "taskbook test",
};

const summary: DriverSummary = {
	pathsTried: [],
	artifacts: [],
	runningTools: [],
	turnCount: 2,
	steerCount: 1,
	steerHistory: [{ direction: "补验收证据", reason: "证据不足", turnIndex: 2 }],
	completed: true,
};

async function withTmp<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "ugk-taskbook-"));
	try {
		return await fn(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

test("saveTaskbook writes taskbook, spec, and experience files", async () => {
	await withTmp(async (cwd) => {
		const taskbook = await saveTaskbook(cwd, "judge_task", {
			description: "Judge 任务书",
			spec,
			summary,
		});

		assert.equal(taskbook.name, "judge_task");
		assert.deepEqual(taskbook.runs, []);
		assert.match(await readFile(path.join(taskbookDir(cwd, "judge_task"), "taskbook.json"), "utf8"), /Judge 任务书/);
		assert.match(await readFile(path.join(taskbookDir(cwd, "judge_task"), "spec.json"), "utf8"), /沉淀 Judge 任务书/);
		assert.match(await readFile(path.join(taskbookDir(cwd, "judge_task"), "experience.md"), "utf8"), /关键避坑点/);
	});
});

test("loadTaskbook reads valid files and returns null when missing", async () => {
	await withTmp(async (cwd) => {
		await saveTaskbook(cwd, "judge-task", { description: "desc", spec, summary });

		const loaded = await loadTaskbook(cwd, "judge-task");
		assert.equal(loaded?.taskbook.description, "desc");
		assert.deepEqual(loaded?.spec, spec);
		assert.equal(await loadTaskbook(cwd, "missing"), null);
	});
});

test("loadTaskbook throws on malformed taskbook or spec", async () => {
	await withTmp(async (cwd) => {
		await saveTaskbook(cwd, "broken", { description: "desc", spec, summary });
		await writeFile(path.join(taskbookDir(cwd, "broken"), "taskbook.json"), '{"name":"broken"}', "utf8");

		await assert.rejects(() => loadTaskbook(cwd, "broken"), /Invalid taskbook/);
	});

	await withTmp(async (cwd) => {
		await saveTaskbook(cwd, "broken", { description: "desc", spec, summary });
		await writeFile(path.join(taskbookDir(cwd, "broken"), "spec.json"), '{"goal":"missing arrays"}', "utf8");

		await assert.rejects(() => loadTaskbook(cwd, "broken"), /Invalid spec/);
	});
});

test("loadTaskbook distinguishes missing from corrupt (reviewer Minor 2)", async () => {
	// 完全不存在 → null
	await withTmp(async (cwd) => {
		assert.equal(await loadTaskbook(cwd, "absent"), null);
	});

	// taskbook.json 在但 spec.json 缺失 → 报 corrupt(不是「不存在」)
	await withTmp(async (cwd) => {
		await saveTaskbook(cwd, "half", { description: "desc", spec, summary });
		await rm(path.join(taskbookDir(cwd, "half"), "spec.json"));
		await assert.rejects(() => loadTaskbook(cwd, "half"), /corrupt.*spec\.json/);
	});

	// spec.json 在但 taskbook.json 缺失 → 同样报 corrupt
	await withTmp(async (cwd) => {
		await saveTaskbook(cwd, "other-half", { description: "desc", spec, summary });
		await rm(path.join(taskbookDir(cwd, "other-half"), "taskbook.json"));
		await assert.rejects(() => loadTaskbook(cwd, "other-half"), /corrupt.*taskbook\.json/);
	});
});

test("listTaskbooks returns name, description, and last run", async () => {
	await withTmp(async (cwd) => {
		await saveTaskbook(cwd, "b", {
			description: "second",
			spec,
			summary,
		});
		await appendRunToTaskbook(cwd, "b", {
			timestamp: "2026-06-21T00:00:00.000Z",
			status: "fail",
			steerCount: 1,
			failReason: "bad",
		});
		await saveTaskbook(cwd, "a", { description: "first", spec, summary });

		assert.deepEqual(await listTaskbooks(cwd), [
			{ name: "a", description: "first", lastRun: undefined },
			{ name: "b", description: "second", lastRun: { timestamp: "2026-06-21T00:00:00.000Z", status: "fail", steerCount: 1, failReason: "bad" } },
		]);
	});
});

test("appendRunToTaskbook sorts runs by timestamp and keeps the latest 10", async () => {
	await withTmp(async (cwd) => {
		await saveTaskbook(cwd, "judge", { description: "desc", spec, summary });

		for (let index = 0; index < 12; index += 1) {
			await appendRunToTaskbook(cwd, "judge", {
				timestamp: `2026-06-21T00:00:${String(index).padStart(2, "0")}.000Z`,
				status: "pass",
				steerCount: index,
				evidence: [`e${index}`],
			});
		}

		const loaded = await loadTaskbook(cwd, "judge");
		assert.equal(loaded?.taskbook.runs.length, 10);
		assert.equal(loaded?.taskbook.runs[0].steerCount, 2);
		assert.equal(loaded?.taskbook.runs.at(-1)?.steerCount, 11);
	});
});

test("draftExperienceMd renders goal, acceptance, steer history, and failures", () => {
	const taskbook: Taskbook = {
		name: "judge",
		description: "desc",
		createdAt: "2026-06-21T00:00:00.000Z",
		updatedAt: "2026-06-21T00:00:00.000Z",
		runs: [{ timestamp: "2026-06-21T00:00:00.000Z", status: "fail", steerCount: 1, failReason: "缺测试" }],
	};
	const markdown = draftExperienceMd("judge", spec, summary.steerHistory ?? [], taskbook);

	assert.match(markdown, /^# judge 经验/);
	assert.match(markdown, /- 能保存任务书/);
	assert.match(markdown, /steer #1 \(turn 2\): 补验收证据/);
	assert.match(markdown, /- 缺测试/);
});

test("isValidTaskbookName accepts simple names and rejects path-like names", () => {
	assert.equal(isValidTaskbookName("judge-task_1"), true);
	assert.equal(isValidTaskbookName(""), false);
	assert.equal(isValidTaskbookName("."), false);
	assert.equal(isValidTaskbookName("../x"), false);
	assert.equal(isValidTaskbookName("x\\y"), false);
	assert.equal(isValidTaskbookName("x.y"), false);
});

test("updateTaskbookSpec writes spec without touching experience", async () => {
	await withTmp(async (cwd) => {
		await saveTaskbook(cwd, "judge", { description: "desc", spec, summary });
		const experienceBefore = await readFile(path.join(taskbookDir(cwd, "judge"), "experience.md"), "utf8");
		const nextSpec = { ...spec, goal: "更新后的目标" };

		await updateTaskbookSpec(cwd, "judge", nextSpec);

		assert.equal((await loadTaskbook(cwd, "judge"))?.spec.goal, "更新后的目标");
		// 改 spec 不重渲 experience.md —— 经验是经验,spec 是 spec,语义分离
		assert.equal(await readFile(path.join(taskbookDir(cwd, "judge"), "experience.md"), "utf8"), experienceBefore);
	});
});
