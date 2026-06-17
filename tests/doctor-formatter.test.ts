import test from "node:test";
import assert from "node:assert/strict";
import { formatDoctorReport } from "../extensions/doctor/formatter.ts";
import type { DoctorCheckRun } from "../extensions/doctor/types.ts";

test("formatDoctorReport renders passing checks and success footer", () => {
	const runs: DoctorCheckRun[] = [
		{
			check: {
				id: "shell.bash",
				title: "Shell",
				category: "shell",
				run: async () => ({ status: "pass", summary: "bash available" }),
			},
			result: { status: "pass", summary: "bash available" },
		},
		{
			check: {
				id: "api.deepseek",
				title: "API",
				category: "api",
				run: async () => ({ status: "pass", summary: "DeepSeek configured via DEEPSEEK_API_KEY" }),
			},
			result: { status: "pass", summary: "DeepSeek configured via DEEPSEEK_API_KEY" },
		},
	];

	const text = formatDoctorReport(runs);

	assert.match(text, /^🧪 UGK Doctor/);
	assert.match(text, /✅ Shell\s+bash available/);
	assert.match(text, /✨ All core checks passed\./);
});

test("formatDoctorReport de-duplicates next steps from warning and failure checks", () => {
	const runs: DoctorCheckRun[] = [
		{
			check: {
				id: "chrome.binary",
				title: "Chrome",
				category: "chrome",
				run: async () => ({
					status: "warn",
					summary: "Chrome found, but CDP not reachable",
					nextSteps: ["/cdp launch"],
				}),
			},
			result: {
				status: "warn",
				summary: "Chrome found, but CDP not reachable",
				nextSteps: ["/cdp launch", "/cdp status"],
			},
		},
		{
			check: {
				id: "chrome.cdp",
				title: "Chrome",
				category: "chrome",
				run: async () => ({ status: "warn", summary: "CDP not reachable", nextSteps: ["/cdp launch"] }),
			},
			result: { status: "warn", summary: "CDP not reachable", nextSteps: ["/cdp launch"] },
		},
	];

	const text = formatDoctorReport(runs);

	assert.match(text, /⚠️ Chrome\s+Chrome found, but CDP not reachable/);
	assert.match(text, /👉 Next steps:\n  \/cdp launch\n  \/cdp status/);
	assert.equal((text.match(/\/cdp launch/g) ?? []).length, 1);
});
