import test from "node:test";
import assert from "node:assert/strict";
import {
	checkBash,
	checkChromeBinary,
	checkChromeCdp,
	checkDeepSeekApi,
	createCoreDoctorChecks,
	resolveBashCommand,
} from "../extensions/doctor/checks.ts";

test("checkBash passes when bash returns ok", async () => {
	const result = await checkBash({ resolveBash: () => ({ command: "bash", source: "PATH" }), exec: async () => ({ stdout: "ok\n" }) });
	assert.equal(result.status, "pass");
	assert.match(result.summary, /bash available/);
});

test("checkBash fails when bash cannot execute", async () => {
	const result = await checkBash({
		resolveBash: () => ({ command: "bash", source: "PATH" }),
		exec: async () => {
			throw new Error("spawn bash ENOENT");
		},
	});
	assert.equal(result.status, "fail");
	assert.match(result.summary, /bash unavailable/);
	assert.deepEqual(result.nextSteps, ["Check PATH or install a bash-compatible shell."]);
});

test("resolveBashCommand prefers Windows shellPath from settings", () => {
	const shellPath = "E:\\Application\\Git\\usr\\bin\\bash.exe";
	const result = resolveBashCommand({
		platform: "win32",
		agentDir: "C:\\Users\\tester\\.pi\\agent",
		exists: (candidate) => candidate === shellPath,
		readFile: () => JSON.stringify({ shellPath }),
	});

	assert.deepEqual(result, { command: shellPath, source: "settings.json shellPath" });
});

test("resolveBashCommand falls back to common Windows Git Bash locations", () => {
	const shellPath = "D:\\Git\\bin\\bash.exe";
	const result = resolveBashCommand({
		platform: "win32",
		agentDir: "C:\\Users\\tester\\.pi\\agent",
		exists: (candidate) => candidate === shellPath,
		readFile: () => "{}",
	});

	assert.deepEqual(result, { command: shellPath, source: "common Git Bash location" });
});

test("checkDeepSeekApi passes and fails using existing status text", async () => {
	const pass = await checkDeepSeekApi({ env: { DEEPSEEK_API_KEY: "sk-test" }, readFile: () => "" });
	assert.equal(pass.status, "pass");
	assert.match(pass.summary, /DEEPSEEK_API_KEY/);

	const fail = await checkDeepSeekApi({ env: {}, authPath: "auth.json", readFile: () => "{}" });
	assert.equal(fail.status, "fail");
	assert.deepEqual(fail.nextSteps, ["Set DEEPSEEK_API_KEY or run /login."]);
});

test("checkChromeBinary reports found and missing binaries", async () => {
	const found = await checkChromeBinary({
		resolveChromeBinary: () => ({
			found: true,
			command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		}),
	});
	assert.equal(found.status, "pass");
	assert.match(found.summary, /Chrome found/);

	const missing = await checkChromeBinary({ resolveChromeBinary: () => ({ found: false, command: "google-chrome" }) });
	assert.equal(missing.status, "fail");
	assert.match(missing.summary, /Chrome not found/);
	assert.deepEqual(missing.nextSteps, ["Install Chrome or check PATH."]);
});

test("checkChromeCdp reports reachable and unreachable status", async () => {
	const online = await checkChromeCdp({
		resolvePort: () => 9222,
		getStatus: async () => ({ online: true, port: 9222, tabs: [] }),
	});
	assert.equal(online.status, "pass");
	assert.match(online.summary, /Chrome CDP reachable/);

	const offline = await checkChromeCdp({
		resolvePort: () => 9333,
		getStatus: async () => ({ online: false, port: 9333, error: "fetch failed" }),
	});
	assert.equal(offline.status, "warn");
	assert.match(offline.summary, /not reachable on 127\.0\.0\.1:9333/);
	assert.deepEqual(offline.nextSteps, ["/cdp launch", "/cdp status"]);
});

test("createCoreDoctorChecks excludes Android checks", () => {
	const ids = createCoreDoctorChecks().map((check) => check.id);
	assert.deepEqual(ids, ["shell.bash", "api.deepseek", "chrome.binary", "chrome.cdp"]);
	assert.equal(ids.some((id) => /adb|scrcpy|android/i.test(id)), false);
});
