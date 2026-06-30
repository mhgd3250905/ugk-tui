import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getChromeLaunchCommand, getDefaultChromeProfilePath } from "../extensions/chrome-cdp/launcher.ts";

test("getDefaultChromeProfilePath uses dedicated ugk profile", () => {
	assert.equal(
		getDefaultChromeProfilePath(path.join("/Users", "demo")),
		path.join("/Users", "demo", ".ugk", "chrome-cdp-profile"),
	);
});

test("getChromeLaunchCommand builds macOS Chrome command with local debugging port and profile", () => {
	const command = getChromeLaunchCommand({ port: 9222, homeDir: path.join("/Users", "demo"), platform: "darwin" });

	assert.equal(command.command, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
	assert.deepEqual(command.args, [
		"--remote-debugging-port=9222",
		`--user-data-dir=${path.join("/Users", "demo", ".ugk", "chrome-cdp-profile")}`,
	]);
});

test("getChromeLaunchCommand falls back to google-chrome on linux", () => {
	const command = getChromeLaunchCommand({ port: 9333, homeDir: path.join("/home", "demo"), platform: "linux" });

	assert.equal(command.command, "google-chrome");
	assert.deepEqual(command.args, [
		"--remote-debugging-port=9333",
		`--user-data-dir=${path.join("/home", "demo", ".ugk", "chrome-cdp-profile")}`,
	]);
});

test("getChromeLaunchCommand resolves Windows chrome.exe when present", () => {
	// 模拟一个标准安装路径,findWindowsChrome 会读到 PROGRAMFILES 指向的 exe
	const fakeProgramFiles = path.join(os.tmpdir(), "ugk-test-pf");
	const chromeExe = path.join(fakeProgramFiles, "Google", "Chrome", "Application", "chrome.exe");
	fs.mkdirSync(path.dirname(chromeExe), { recursive: true });
	fs.writeFileSync(chromeExe, "");
	process.env.PROGRAMFILES = fakeProgramFiles;

	try {
		const command = getChromeLaunchCommand({ port: 9444, homeDir: os.tmpdir(), platform: "win32" });

		assert.equal(command.command, chromeExe);
		assert.deepEqual(
			command.args,
			[`--remote-debugging-port=9444`, `--user-data-dir=${path.join(os.tmpdir(), ".ugk", "chrome-cdp-profile")}`],
		);
	} finally {
		delete process.env.PROGRAMFILES;
		fs.rmSync(fakeProgramFiles, { recursive: true, force: true });
	}
});

test("getChromeLaunchCommand falls back to chrome.exe on Windows if not found", () => {
	// 把所有候选路径都设成不存在的目录,触发 fallback
	process.env.PROGRAMFILES = path.join(os.tmpdir(), "ugk-empty-pf");
	process.env["PROGRAMFILES(X86)"] = path.join(os.tmpdir(), "ugk-empty-pf86");
	process.env.LOCALAPPDATA = path.join(os.tmpdir(), "ugk-empty-local");

	try {
		const command = getChromeLaunchCommand({ port: 9555, homeDir: os.tmpdir(), platform: "win32" });

		assert.equal(command.command, "chrome.exe");
	} finally {
		delete process.env.PROGRAMFILES;
		delete process.env["PROGRAMFILES(X86)"];
		delete process.env.LOCALAPPDATA;
	}
});

// ponytail: 钉死 Chrome 进程 teardown 回归。launchChromeCdp 的 child 句柄曾丢弃 + detached +
// unref,Chrome 永不被 kill(全仓 grep kill 零命中),--remote-debugging-port + 用户登录态永久驻留。
// 测试不真 spawn Chrome:手动塞 fake ChildProcess 进 Set,调 teardown,断言 kill 被调用 + Set 清空。
test("managed Chrome children are killed on teardown and cleared from the set", async () => {
	const { __testOnly } = await import("../extensions/chrome-cdp/launcher.ts");
	// 确保从干净状态开始(teardown 可能被其它测试触发过)。
	__testOnly.teardown();

	const killed: string[] = [];
	// fake ChildProcess:只关心 kill() 和 exit 事件语义。
	const makeFake = (id: string) => ({
		pid: 1000 + Number(id),
		kill(signal?: string) { killed.push(`${id}:${signal ?? "default"}`); return true; },
		on(_event: string, _cb: Function) { /* no-op for fake */ },
		ref() {}, unref() {},
	}) as any;
	__testOnly.managedChildren.add(makeFake("1"));
	__testOnly.managedChildren.add(makeFake("2"));
	__testOnly.managedChildren.add(makeFake("3"));
	assert.equal(__testOnly.managedChildren.size, 3);

	__testOnly.teardown();

	assert.equal(__testOnly.managedChildren.size, 0, "teardown 后 Set 应清空");
	assert.equal(killed.length, 3, "三个 fake 进程都应被 kill");
	// 幂等:再 teardown 不炸也不再 kill(已清空)。
	__testOnly.teardown();
	assert.equal(killed.length, 3, "幂等:空 Set 再 teardown 不重复 kill");
});
