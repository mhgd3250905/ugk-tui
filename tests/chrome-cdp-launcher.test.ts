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
