import test from "node:test";
import assert from "node:assert/strict";
import {
	abortTask,
	completeTask,
	createTaskState,
	enterPlanning,
	enterReviewing,
	landTask,
	markPlanQuestionnaireUsed,
	markReviewQuestionnaireUsed,
	setTaskReviewResult,
	setTaskSpec,
	startExecuting,
} from "../extensions/task/task-state.ts";

const spec = {
	goal: "下载视频",
	hardConstraints: ["保留原始画质"],
	acceptance: ["文件存在"],
	forbidden: ["不要转码"],
	context: "",
};

test("task state starts inactive with retry defaults", () => {
	assert.deepEqual(createTaskState(), {
		phase: "aborted",
		spec: null,
		summary: "",
		retryCount: 0,
		maxRetry: 3,
		planQuestionnaireUsed: false,
		reviewQuestionnaireUsed: false,
		executeRunDir: undefined,
	});
});

test("planning resets spec, summary, review result and C-2 flags", () => {
	const state = enterPlanning({
		...createTaskState(),
		spec,
		summary: "old",
		phase: "reviewing",
		planQuestionnaireUsed: true,
		reviewQuestionnaireUsed: true,
		reviewResult: { description: "d", skill: "s", verify: "v", contract: {} },
	});

	assert.equal(state.phase, "planning");
	assert.equal(state.spec, null);
	assert.equal(state.summary, "");
	assert.equal(state.planQuestionnaireUsed, false);
	assert.equal(state.reviewQuestionnaireUsed, false);
	assert.equal(state.reviewResult, undefined);
	assert.equal(state.executeRunDir, undefined);
});

test("startExecuting requires planning questionnaire", () => {
	const state = setTaskSpec(enterPlanning(createTaskState()), spec);

	assert.throws(() => startExecuting(state), /questionnaire/);
	assert.equal(startExecuting(markPlanQuestionnaireUsed(state)).phase, "executing");
});

test("questionnaire flags are idempotent and phase-scoped", () => {
	const planning = enterPlanning(createTaskState());
	const markedPlanning = markPlanQuestionnaireUsed(planning);
	assert.equal(markedPlanning.planQuestionnaireUsed, true);
	assert.equal(markPlanQuestionnaireUsed(markedPlanning), markedPlanning);
	assert.equal(markPlanQuestionnaireUsed(createTaskState()).planQuestionnaireUsed, false);

	const reviewing = enterReviewing(startExecuting(markedPlanning), "done");
	const markedReview = markReviewQuestionnaireUsed(reviewing);
	assert.equal(markedReview.reviewQuestionnaireUsed, true);
	assert.equal(markReviewQuestionnaireUsed(markedReview), markedReview);
	assert.equal(markReviewQuestionnaireUsed(planning).reviewQuestionnaireUsed, false);
});

test("review and terminal transitions keep the minimum useful state", () => {
	const executing = startExecuting(markPlanQuestionnaireUsed(setTaskSpec(enterPlanning(createTaskState()), spec)));
	const reviewing = setTaskReviewResult(enterReviewing(executing, "执行摘要"), {
		description: "desc",
		skill: "# skill",
		verify: "process.exit(0)",
		contract: { artifacts: [] },
	});

	assert.equal(reviewing.phase, "reviewing");
	assert.equal(reviewing.summary, "执行摘要");
	assert.equal(reviewing.reviewResult?.description, "desc");
	assert.equal(landTask(reviewing).phase, "landed");
	assert.equal(abortTask(reviewing).phase, "aborted");
	assert.equal(completeTask(reviewing).phase, "done");
});
