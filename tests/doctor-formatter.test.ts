import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
			result: { status: "pass", summary: "bash available", details: ["settings.json shellPath: D:\\Git\\bin\\bash.exe"] },
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
	assert.match(text, /┌─+┬─+┬─+┐/);
	assert.match(text, /│\s*状态\s*│\s*检查\s*│\s*结果\s*│/);
	assert.match(text, /│\s*✅\s*│\s*Shell\s*│\s*bash available\s*│/);
	assert.match(text, /│\s*↳\s*│\s*Shell\s*│\s*settings\.json shellPath: D:\\Git\\bin\\bash\.exe\s*│/);
	assert.match(text, /✨ 核心检查全部通过。/);
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

	assert.match(text, /│\s*⚠️\s*│\s*Chrome\s*│\s*Chrome found, but CDP not reachable\s*│/);
	assert.match(text, /👉 下一步:\n  \/cdp launch\n  \/cdp status/);
	assert.equal((text.match(/\/cdp launch/g) ?? []).length, 1);
});

test("formatDoctorReport follows UI language", () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ugk-doctor-language-"));
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ uiLanguage: "en-US" }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const runs: DoctorCheckRun[] = [
			{
				check: { id: "chrome.cdp", title: "Chrome", category: "chrome", run: async () => ({ status: "warn", summary: "CDP not reachable" }) },
				result: { status: "warn", summary: "CDP not reachable", nextSteps: ["/cdp launch"] },
			},
		];

		const text = formatDoctorReport(runs);

		assert.match(text, /│\s*Status\s*│\s*Check\s*│\s*Result\s*│/);
		assert.match(text, /👉 Next steps:\n  \/cdp launch/);
		assert.doesNotMatch(text, /下一步|状态|检查|结果/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});
