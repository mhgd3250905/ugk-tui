import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	isFlowTaskState,
	isRunnable,
	normalizeLegacyState,
	transition,
	type FlowTaskEvent,
	type FlowTaskState,
} from "../extensions/flow/task-state.ts";
import { writeFlowTask } from "../extensions/flow/task-store.ts";

function makeTempCwd(): string {
	return mkdtempSync(path.join(tmpdir(), "flow-task-state-"));
}

function seedTask(cwd: string, taskId: string, state: FlowTaskState): void {
	writeFlowTask(cwd, taskId, { id: taskId, version: 1, status: state });
}

const STATES: FlowTaskState[] = ["draft", "proving", "proved", "reviewing", "ready", "needs-work"];

// ---- 纯函数 ----

test("normalizeLegacyState maps verified/active/approved to ready", () => {
	assert.equal(normalizeLegacyState("verified"), "ready");
	assert.equal(normalizeLegacyState("active"), "ready");
	assert.equal(normalizeLegacyState("approved"), "ready");
	assert.equal(normalizeLegacyState("draft"), "draft");
	assert.equal(normalizeLegacyState(undefined), "draft");
	assert.equal(normalizeLegacyState("garbage"), "needs-work"); // 未知值保守归位
});

test("isFlowTaskState guards the 6 canonical states", () => {
	for (const s of STATES) assert.equal(isFlowTaskState(s), true);
	assert.equal(isFlowTaskState("verified"), false);
	assert.equal(isFlowTaskState("active"), false);
	assert.equal(isFlowTaskState("approved"), false);
});

test("isRunnable is true only for ready", () => {
	assert.equal(isRunnable("ready"), true);
	for (const s of STATES) {
		if (s !== "ready") assert.equal(isRunnable(s), false, `${s} should not be runnable`);
	}
});

// ---- transition:合法路径 ----

test("draft --prove-start--> proving", () => {
	const cwd = makeTempCwd();
	seedTask(cwd, "t", "draft");
	const r = transition(cwd, "t", { kind: "prove-start", runId: "run-001" });
	assert.equal(r.ok, true);
	assert.equal((r as { state: string }).state, "proving");
});

test("proving --prove-pass--> proved records structural-pass", () => {
	const cwd = makeTempCwd();
	seedTask(cwd, "t", "proving");
	const r = transition(cwd, "t", {
		kind: "prove-pass",
		runId: "run-001",
		validatedAt: "2026-06-18T00:00:00.000Z",
		nextStep: "review",
	});
	assert.equal(r.ok, true);
	assert.equal((r as { state: string }).state, "proved");
	assert.equal((r as { task: { latest_validation?: string } }).task.latest_validation, "structural-pass");
});

test("proving --prove-fail--> draft records structural-fail", () => {
	const cwd = makeTempCwd();
	seedTask(cwd, "t", "proving");
	const r = transition(cwd, "t", { kind: "prove-fail", runId: "run-001", nextStep: "re-prove" });
	assert.equal(r.ok, true);
	assert.equal((r as { state: string }).state, "draft");
	assert.equal((r as { task: { latest_validation?: string } }).task.latest_validation, "structural-fail");
});

test("proved --review-start--> reviewing", () => {
	const cwd = makeTempCwd();
	seedTask(cwd, "t", "proved");
	const r = transition(cwd, "t", { kind: "review-start", runId: "run-001", nextStep: "main reviewing" });
	assert.equal(r.ok, true);
	assert.equal((r as { state: string }).state, "reviewing");
});

test("reviewing --review-accept--> ready sets ready_origin", () => {
	const cwd = makeTempCwd();
	seedTask(cwd, "t", "reviewing");
	const r = transition(cwd, "t", {
		kind: "review-accept",
		runId: "run-001",
		origin: "local-proved",
		nextStep: "/flow run t",
	});
	assert.equal(r.ok, true);
	assert.equal((r as { state: string }).state, "ready");
	assert.equal((r as { task: { ready_origin?: string } }).task.ready_origin, "local-proved");
});

test("reviewing --review-reject--> needs-work clears ready_origin", () => {
	const cwd = makeTempCwd();
	seedTask(cwd, "t", "reviewing");
	const r = transition(cwd, "t", { kind: "review-reject", runId: "run-001", nextStep: "fix" });
	assert.equal(r.ok, true);
	assert.equal((r as { state: string }).state, "needs-work");
	assert.equal((r as { task: { ready_origin?: string } }).task.ready_origin, undefined);
});

test("needs-work --prove-start--> proving (must re-prove, no shortcut back)", () => {
	const cwd = makeTempCwd();
	seedTask(cwd, "t", "needs-work");
	const r = transition(cwd, "t", { kind: "prove-start", runId: "run-002" });
	assert.equal(r.ok, true);
	assert.equal((r as { state: string }).state, "proving");
});

test("ready --prove-start--> proving (re-run / evolve allowed)", () => {
	const cwd = makeTempCwd();
	seedTask(cwd, "t", "ready");
	const r = transition(cwd, "t", { kind: "prove-start", runId: "run-005" });
	assert.equal(r.ok, true);
	assert.equal((r as { state: string }).state, "proving");
});

test("draft --remote-mark-ready--> ready (sync from remote)", () => {
	const cwd = makeTempCwd();
	seedTask(cwd, "t", "draft");
	const r = transition(cwd, "t", { kind: "remote-mark-ready", origin: "remote-sync" });
	assert.equal(r.ok, true);
	assert.equal((r as { state: string }).state, "ready");
	assert.equal((r as { task: { ready_origin?: string } }).task.ready_origin, "remote-sync");
});

// ---- transition:非法路径(状态机拒绝) ----

function assertIllegal(from: FlowTaskState, event: FlowTaskEvent): void {
	const cwd = makeTempCwd();
	seedTask(cwd, "t", from);
	const r = transition(cwd, "t", event);
	assert.equal(r.ok, false, `${from} --${event.kind}--> should be illegal`);
	assert.match((r as { reason: string }).reason, /Illegal transition/);
}

test("review-accept from non-reviewing states is illegal", () => {
	const ev: FlowTaskEvent = { kind: "review-accept", runId: "r", origin: "local-proved", nextStep: "x" };
	assertIllegal("draft", ev);
	assertIllegal("proving", ev);
	assertIllegal("proved", ev);
	assertIllegal("ready", ev);
});

test("prove-pass from non-proving states is illegal", () => {
	const ev: FlowTaskEvent = { kind: "prove-pass", runId: "r", validatedAt: "t", nextStep: "x" };
	assertIllegal("draft", ev);
	assertIllegal("proved", ev);
	assertIllegal("reviewing", ev);
	assertIllegal("ready", ev);
});

test("review-start from non-proved states is illegal (proving cannot skip to review)", () => {
	const ev: FlowTaskEvent = { kind: "review-start", runId: "r", nextStep: "x" };
	assertIllegal("draft", ev);
	assertIllegal("proving", ev);
	assertIllegal("reviewing", ev);
	assertIllegal("ready", ev);
});

test("prove-start is allowed from draft/needs-work/ready/proved, not from proving/reviewing", () => {
	const ev: FlowTaskEvent = { kind: "prove-start", runId: "r" };
	// 合法
	for (const from of ["draft", "needs-work", "ready", "proved"] as FlowTaskState[]) {
		const cwd = makeTempCwd();
		seedTask(cwd, "t", from);
		assert.equal(transition(cwd, "t", ev).ok, true, `${from} --prove-start--> should be legal`);
	}
	// 非法:已在 proving 不能再 start;reviewing 不能直接跳 prove
	assertIllegal("proving", ev);
	assertIllegal("reviewing", ev);
});

// ---- 落盘验证 ----

test("transition persists status to task.json", () => {
	const cwd = makeTempCwd();
	seedTask(cwd, "t", "draft");
	transition(cwd, "t", { kind: "prove-start", runId: "run-001" });
	// 重新读,确认落盘
	const r2 = transition(cwd, "t", { kind: "prove-pass", runId: "run-001", validatedAt: "t", nextStep: "x" });
	assert.equal(r2.ok, true);
	assert.equal((r2 as { state: string }).state, "proved"); // 从落盘的 proving 继续
});

test("transition rejects unknown task", () => {
	const cwd = makeTempCwd();
	const r = transition(cwd, "ghost", { kind: "prove-start", runId: "r" });
	assert.equal(r.ok, false);
	assert.match((r as { reason: string }).reason, /not found/);
});
