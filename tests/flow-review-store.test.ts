import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	acceptFlowReview,
	isFlowReviewAccepted,
	readFlowReview,
	rejectFlowReview,
	startFlowReview,
} from "../extensions/flow/review-store.ts";

function makeRun(): { taskDir: string; runDir: string } {
	const cwd = mkdtempSync(path.join(tmpdir(), "flow-review-store-"));
	const taskDir = path.join(cwd, ".flow", "tasks", "demo-task");
	const runDir = path.join(taskDir, "runs", "run-001");
	mkdirSync(runDir, { recursive: true });
	return { taskDir, runDir };
}

test("startFlowReview writes review json and markdown scaffold", () => {
	const { runDir } = makeRun();

	const review = startFlowReview({
		taskId: "demo-task",
		runId: "run-001",
		runDir,
		now: new Date("2026-06-18T01:00:00.000Z"),
	});

	assert.equal(review.status, "in-review");
	assert.equal(review.userConfirmed, false);
	assert.equal(review.taskDesignUpdated, false);
	assert.equal(review.startedAt, "2026-06-18T01:00:00.000Z");
	assert.equal(existsSync(path.join(runDir, "review.json")), true);
	assert.match(readFileSync(path.join(runDir, "review.md"), "utf8"), /User confirmation: pending/);
});

test("readFlowReview reads accepted review and acceptance predicate validates required fields", () => {
	const { runDir } = makeRun();
	writeFileSync(
		path.join(runDir, "review.json"),
		`${JSON.stringify(
			{
				taskId: "demo-task",
				runId: "run-001",
				status: "accepted",
				userConfirmed: true,
				taskDesignUpdated: true,
				taskVersion: 2,
				acceptedAt: "2026-06-18T02:00:00.000Z",
			},
			null,
			"\t",
		)}\n`,
	);

	const review = readFlowReview(runDir);

	assert.equal(review?.status, "accepted");
	assert.equal(isFlowReviewAccepted(review, 2), true);
	assert.equal(isFlowReviewAccepted(review, 3), false);
	assert.equal(isFlowReviewAccepted(review, 2, { taskId: "demo-task", runId: "run-001" }), true);
	assert.equal(isFlowReviewAccepted(review, 2, { taskId: "other-task", runId: "run-001" }), false);
	assert.equal(isFlowReviewAccepted(review, 2, { taskId: "demo-task", runId: "run-002" }), false);
});

test("incomplete review is not accepted", () => {
	const { runDir } = makeRun();
	const review = startFlowReview({ taskId: "demo-task", runId: "run-001", runDir });

	assert.equal(isFlowReviewAccepted(review, 1), false);
	assert.equal(isFlowReviewAccepted(undefined, 1), false);
});

test("acceptFlowReview records accepted review and renders markdown", () => {
	const { runDir } = makeRun();
	startFlowReview({
		taskId: "demo-task",
		runId: "run-001",
		runDir,
		now: new Date("2026-06-18T01:00:00.000Z"),
	});

	const review = acceptFlowReview({
		taskId: "demo-task",
		runId: "run-001",
		runDir,
		taskVersion: 3,
		now: new Date("2026-06-18T02:00:00.000Z"),
	});

	assert.equal(review.status, "accepted");
	assert.equal(review.userConfirmed, true);
	assert.equal(review.taskDesignUpdated, false);
	assert.equal(review.taskDesignDecision, "no-change");
	assert.equal(review.taskVersion, 3);
	assert.equal(isFlowReviewAccepted(readFlowReview(runDir), 3), true);
	const markdown = readFileSync(path.join(runDir, "review.md"), "utf8");
	assert.match(markdown, /Status: accepted/);
	assert.match(markdown, /Task version: 3/);
	assert.match(markdown, /User confirmation: confirmed/);
	assert.match(markdown, /Task design decision: no-change/);
	assert.match(markdown, /Changes to persist: not needed/);
});

test("accepted no-change reviews satisfy the review gate", () => {
	const { runDir } = makeRun();
	writeFileSync(
		path.join(runDir, "review.json"),
		`${JSON.stringify(
			{
				taskId: "demo-task",
				runId: "run-001",
				status: "accepted",
				userConfirmed: true,
				taskDesignUpdated: false,
				taskDesignDecision: "no-change",
				taskVersion: 2,
			},
			null,
			"\t",
		)}\n`,
	);

	assert.equal(isFlowReviewAccepted(readFlowReview(runDir), 2), true);
});

test("acceptFlowReview records updated decision when task assets changed", () => {
	const { runDir } = makeRun();
	writeFileSync(
		path.join(runDir, "review.json"),
		`${JSON.stringify(
			{
				taskId: "demo-task",
				runId: "run-001",
				status: "in-review",
				userConfirmed: false,
				taskDesignUpdated: false,
				updatedFiles: ["SKILL.md"],
				decisions: ["固化路径 A"],
			},
			null,
			"\t",
		)}\n`,
	);

	const review = acceptFlowReview({ taskId: "demo-task", runId: "run-001", runDir, taskVersion: 4 });

	assert.equal(review.taskDesignUpdated, true);
	assert.equal(review.taskDesignDecision, "updated");
	assert.equal(isFlowReviewAccepted(review, 4), true);
});

test("rejectFlowReview records needs-changes reason", () => {
	const { runDir } = makeRun();

	const review = rejectFlowReview({
		taskId: "demo-task",
		runId: "run-001",
		runDir,
		reason: "输出字段缺失",
	});

	assert.equal(review.status, "needs-changes");
	assert.equal(review.userConfirmed, false);
	assert.equal(review.decisions[0], "输出字段缺失");
	assert.equal(isFlowReviewAccepted(readFlowReview(runDir), 1), false);
	assert.match(readFileSync(path.join(runDir, "review.md"), "utf8"), /输出字段缺失/);
});
