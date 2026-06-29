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
	assert.match(result.summary, /bash 可用/);
});

test("checkBash persists resolved Windows Git Bash path for child agent sessions", async () => {
	const agentDir = "C:\\Users\\tester\\.pi\\agent";
	const settingsPath = "C:\\Users\\tester\\.pi\\agent\\settings.json";
	const writes = new Map<string, string>();
	const createdDirs: string[] = [];

	const result = await checkBash({
		platform: "win32",
		agentDir,
		resolveBash: () => ({ command: "C:\\Program Files\\Git\\bin\\bash.exe", source: "common Git Bash location" }),
		exec: async () => ({ stdout: "ok\n" }),
		readFile: () => JSON.stringify({ model: "deepseek-v4-pro" }),
		writeFile: (filePath: string, content: string) => writes.set(filePath, content),
		mkdir: (dirPath: string) => {
			createdDirs.push(dirPath);
		},
	});

	assert.equal(result.status, "pass");
	assert.deepEqual(createdDirs, [agentDir]);
	const settings = JSON.parse(writes.get(settingsPath) ?? "{}");
	assert.deepEqual(settings, {
		model: "deepseek-v4-pro",
		shellPath: "C:\\Program Files\\Git\\bin\\bash.exe",
	});
});

test("checkBash fails when bash cannot execute", async () => {
	const result = await checkBash({
		resolveBash: () => ({ command: "bash", source: "PATH" }),
		exec: async () => {
			throw new Error("spawn bash ENOENT");
		},
	});
	assert.equal(result.status, "fail");
	assert.match(result.summary, /bash 不可用/);
	assert.deepEqual(result.nextSteps, ["检查 PATH 或安装 bash 兼容 shell。"]);
});

test("resolveBashCommand prefers Windows shellPath from settings", () => {
	const shellPath = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";
	const result = resolveBashCommand({
		platform: "win32",
		agentDir: "C:\\Users\\tester\\.pi\\agent",
		exists: (candidate) => candidate === shellPath,
		readFile: () => JSON.stringify({ shellPath }),
	});

	assert.deepEqual(result, { command: shellPath, source: "settings.json shellPath" });
});

test("resolveBashCommand falls back to common Windows Git Bash locations", () => {
	const shellPath = "C:\\Program Files\\Git\\bin\\bash.exe";
	const result = resolveBashCommand({
		platform: "win32",
		agentDir: "C:\\Users\\tester\\.pi\\agent",
		exists: (candidate) => candidate === shellPath,
		readFile: () => "{}",
	});

	assert.deepEqual(result, { command: shellPath, source: "common Git Bash location" });
});

test("checkBash does not overwrite an unreadable settings file", async () => {
	let wrote = false;
	const result = await checkBash({
		platform: "win32",
		agentDir: "C:\\Users\\tester\\.pi\\agent",
		resolveBash: () => ({ command: "C:\\Program Files\\Git\\bin\\bash.exe", source: "common Git Bash location" }),
		exec: async () => ({ stdout: "ok\n" }),
		exists: () => true,
		readFile: () => "{broken",
		writeFile: () => {
			wrote = true;
		},
		mkdir: () => {},
	});

	assert.equal(result.status, "pass");
	assert.equal(wrote, false);
});

test("checkBash passes when persisting the resolved bash path fails", async () => {
	const result = await checkBash({
		platform: "win32",
		agentDir: "C:\\Users\\tester\\.pi\\agent",
		resolveBash: () => ({ command: "C:\\Program Files\\Git\\bin\\bash.exe", source: "common Git Bash location" }),
		exec: async () => ({ stdout: "ok\n" }),
		readFile: () => "{}",
		writeFile: () => {
			throw new Error("access denied");
		},
		mkdir: () => {},
	});

	assert.equal(result.status, "pass");
	assert.match(result.summary, /bash 可用/);
});

test("checkDeepSeekApi passes and fails using existing status text", async () => {
	const pass = await checkDeepSeekApi({ env: { DEEPSEEK_API_KEY: "sk-test" }, readFile: () => "" });
	assert.equal(pass.status, "pass");
	assert.match(pass.summary, /DEEPSEEK_API_KEY/);

	const fail = await checkDeepSeekApi({ env: {}, authPath: "auth.json", readFile: () => "{}" });
	assert.equal(fail.status, "fail");
	assert.deepEqual(fail.details, ["底栏模型名只表示当前选择的模型,不代表 DeepSeek API 已配置。"]);
	assert.deepEqual(fail.nextSteps, ["设置 DEEPSEEK_API_KEY 或运行 /login。"]);
});

test("checkChromeBinary reports found and missing binaries", async () => {
	const found = await checkChromeBinary({
		resolveChromeBinary: () => ({
			found: true,
			command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		}),
	});
	assert.equal(found.status, "pass");
	assert.match(found.summary, /已找到 Chrome/);

	const missing = await checkChromeBinary({ resolveChromeBinary: () => ({ found: false, command: "google-chrome" }) });
	assert.equal(missing.status, "fail");
	assert.match(missing.summary, /未找到 Chrome/);
	assert.deepEqual(missing.nextSteps, ["安装 Chrome 或检查 PATH。"]);
});

test("checkChromeCdp reports reachable and unreachable status", async () => {
	const online = await checkChromeCdp({
		resolvePort: () => 9222,
		getStatus: async () => ({ online: true, port: 9222, tabs: [] }),
	});
	assert.equal(online.status, "pass");
	assert.match(online.summary, /Chrome CDP 可连接/);

	const offline = await checkChromeCdp({
		resolvePort: () => 9333,
		getStatus: async () => ({ online: false, port: 9333, error: "fetch failed" }),
	});
	assert.equal(offline.status, "warn");
	assert.match(offline.summary, /无法连接: 127\.0\.0\.1:9333/);
	assert.deepEqual(offline.nextSteps, ["/cdp launch", "/cdp status"]);
});

test("createCoreDoctorChecks keeps the core check list fixed", () => {
	const ids = createCoreDoctorChecks().map((check) => check.id);
	assert.deepEqual(ids, ["shell.bash", "api.deepseek", "chrome.binary", "chrome.cdp"]);
});
