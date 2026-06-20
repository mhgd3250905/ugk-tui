import test from "node:test";
import assert from "node:assert/strict";
import {
	abortJudge,
	completeJudge,
	createJudgeState,
	enterAligning,
	setRequirementsSpec,
	startDriving,
} from "../extensions/judge/judge-state.ts";

const spec = {
	goal: "实现 Judge 阶段 2",
	hardConstraints: ["不启动 driver"],
	acceptance: ["能解析 RequirementsSpec"],
	forbidden: ["修改 Flow 上层行为"],
	context: "phase 2",
};

test("createJudgeState starts inactive with conservative defaults", () => {
	const state = createJudgeState();

	assert.equal(state.phase, "aborted");
	assert.equal(state.spec, null);
	assert.equal(state.summary, "");
	assert.equal(state.steerCount, 0);
	assert.equal(state.maxSteer, 5);
	assert.equal(state.keepWatching, false);
});

test("enterAligning switches to aligning and enables watching", () => {
	const state = enterAligning(createJudgeState());

	assert.equal(state.phase, "aligning");
	assert.equal(state.keepWatching, true);
	assert.equal(state.steerCount, 0);
});

test("setRequirementsSpec stores spec while preserving phase", () => {
	const state = setRequirementsSpec(enterAligning(createJudgeState()), spec);

	assert.equal(state.phase, "aligning");
	assert.deepEqual(state.spec, spec);
});

test("startDriving requires a spec and moves to driving", () => {
	const aligned = setRequirementsSpec(enterAligning(createJudgeState()), spec);
	const driving = startDriving(aligned);

	assert.equal(driving.phase, "driving");
	assert.deepEqual(driving.spec, spec);
	assert.equal(driving.keepWatching, true);
});

test("abortJudge and completeJudge produce terminal phases", () => {
	assert.equal(abortJudge(enterAligning(createJudgeState())).phase, "aborted");
	assert.equal(completeJudge(enterAligning(createJudgeState())).phase, "done");
});

test("terminal and active phases clear pending delivery acknowledgement", () => {
	const pending = { ...enterAligning(createJudgeState()), pendingAckStatus: "pass" as const };

	assert.equal(completeJudge(pending).pendingAckStatus, undefined);
	assert.equal(abortJudge(pending).pendingAckStatus, undefined);
	assert.equal(startDriving(pending).pendingAckStatus, undefined);
	assert.equal(enterAligning(pending).pendingAckStatus, undefined);
});
