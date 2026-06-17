import test from "node:test";
import assert from "node:assert/strict";
import {
	formatDriverPickerOption,
	getDriverPickerOptions,
	parseDriverPickerSelection,
} from "../extensions/flow/driver-picker.ts";
import type { FlowDriverSummary } from "../extensions/flow/types.ts";

const now = new Date("2026-06-17T00:00:14.000Z");

test("formatDriverPickerOption formats visible driver metadata exactly", () => {
	const driver: FlowDriverSummary = {
		taskId: "x",
		runId: "run-001",
		status: "running",
		step: "step 2/5",
		summary: "waiting first page load",
		updatedAt: "2026-06-17T00:00:02.000Z",
		runDir: "x/run-001",
	};

	assert.equal(
		formatDriverPickerOption(driver, now),
		"running  x/run-001  step 2/5  waiting first page load  12s ago",
	);
});

test("getDriverPickerOptions and parseDriverPickerSelection round trip selected driver", () => {
	const drivers: FlowDriverSummary[] = [
		{
			taskId: "x",
			runId: "run-001",
			status: "running",
			step: "step 2/5",
			summary: "waiting first page load",
			updatedAt: "2026-06-17T00:00:02.000Z",
			runDir: "x/run-001",
		},
		{
			taskId: "y",
			runId: "run-002",
			status: "waiting",
			updatedAt: "2026-06-16T23:00:00.000Z",
			runDir: "y/run-002",
		},
	];

	const options = getDriverPickerOptions(drivers, now);

	assert.deepEqual(options, [
		"running  x/run-001  step 2/5  waiting first page load  12s ago",
		"waiting  y/run-002  -  -  1h ago",
	]);
	assert.equal(parseDriverPickerSelection(options[1], drivers, now), drivers[1]);
});

test("parseDriverPickerSelection returns undefined for missing or unknown selection", () => {
	const drivers: FlowDriverSummary[] = [
		{
			taskId: "x",
			runId: "run-001",
			status: "running",
			updatedAt: "not-a-date",
			runDir: "x/run-001",
		},
	];

	assert.equal(formatDriverPickerOption(drivers[0], now), "running  x/run-001  -  -  unknown");
	assert.equal(parseDriverPickerSelection(undefined, drivers, now), undefined);
	assert.equal(parseDriverPickerSelection("running  unknown/run-999  -  -  unknown", drivers, now), undefined);
});
