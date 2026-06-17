import test from "node:test";
import assert from "node:assert/strict";
import {
	clearFlowDriverBanner,
	formatFlowDriverBannerText,
	getFlowDriverBanner,
	setFlowDriverBanner,
	subscribeFlowDriverBanner,
} from "../extensions/flow/driver-banner.ts";

test("formatFlowDriverBannerText formats active banner exactly", () => {
	assert.equal(
		formatFlowDriverBannerText({ taskId: "task-a", runId: "run-001", status: "running" }),
		"FLOW DRIVER ACTIVE  task-a/run-001  running  /flow detach 返回 main",
	);
});

test("setFlowDriverBanner, getFlowDriverBanner, and clearFlowDriverBanner manage current banner", () => {
	clearFlowDriverBanner();

	assert.equal(getFlowDriverBanner(), undefined);

	setFlowDriverBanner({ taskId: "task-a", runId: "run-001", status: "waiting" });
	assert.deepEqual(getFlowDriverBanner(), { taskId: "task-a", runId: "run-001", status: "waiting" });

	clearFlowDriverBanner();
	assert.equal(getFlowDriverBanner(), undefined);
});

test("subscribeFlowDriverBanner notifies until unsubscribed", () => {
	clearFlowDriverBanner();
	let calls = 0;
	const unsubscribe = subscribeFlowDriverBanner(() => {
		calls += 1;
	});

	setFlowDriverBanner({ taskId: "task-a", runId: "run-001", status: "running" });
	clearFlowDriverBanner();
	unsubscribe();
	setFlowDriverBanner({ taskId: "task-a", runId: "run-002", status: "done" });

	assert.equal(calls, 2);
	clearFlowDriverBanner();
});
