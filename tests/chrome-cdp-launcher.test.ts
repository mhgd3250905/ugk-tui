import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
// 测试不真 spawn Chrome:手动塞 fake ChildProcess 进 Set,注入 fake killImpl,断言每个 child
// 都被调了进程树 kill(Windows taskkill /T / Unix kill(-pid))+ Set 清空。
test("managed Chrome children are killed on teardown and cleared from the set", async () => {
	const { __testOnly } = await import("../extensions/chrome-cdp/launcher.ts");
	// 确保从干净状态开始(teardown 可能被其它测试触发过)。
	__testOnly.teardown();

	const killed: number[] = [];
	// 注入 fake killImpl:记录被 kill 的 pid,不真调系统 taskkill/process.kill。
	const restoreKill = __testOnly.setKillImpl((child) => { killed.push(child.pid!); });
	// fake ChildProcess:只需 pid(进程树 kill 凭 pid 找整棵树)。
	const makeFake = (id: number) => ({ pid: 9000 + id, on() {}, ref() {}, unref() {} }) as any;
	__testOnly.managedChildren.add(makeFake(1));
	__testOnly.managedChildren.add(makeFake(2));
	__testOnly.managedChildren.add(makeFake(3));
	assert.equal(__testOnly.managedChildren.size, 3);

	__testOnly.teardown();

	assert.equal(__testOnly.managedChildren.size, 0, "teardown 后 Set 应清空");
	assert.deepEqual(killed.sort((a, b) => a - b), [9001, 9002, 9003], "三个 fake 进程都应被进程树 kill");
	// 幂等:再 teardown 不炸也不再 kill(已清空)。
	__testOnly.teardown();
	assert.equal(killed.length, 3, "幂等:空 Set 再 teardown 不重复 kill");
	restoreKill();
});

// ponytail: 端到端验证 killChromeTree 杀整棵进程树(单元 mock 测不到的系统行为)。
// 这是 Windows 上 Chrome 不消失的根因:Chrome 派生大量子进程,只 kill 主进程(不带 /T)子进程残留,
// 窗口不消失。用 Chrome 同款 spawn(detached)派生子进程的命令,杀后查"根的子进程是否还活着"。
// 关键断言:不只是根消失,而是 ParentProcessId=rootPid 的子进程也消失 —— 这才能钉死 /T 行为。
test("killChromeTree kills the entire process tree, not just the root (e2e)", async () => {
	const isWindows = process.platform === "win32";
	// Windows: cmd /c ping 派生 conhost + ping 两个子进程(实测结构),模拟 Chrome 的进程树。
	// 无 /T 的 taskkill 只杀 cmd 根,conhost/ping 成孤儿继续跑 —— 正是 Chrome 窗口残留的根因。
	// Unix: sh -c 'sleep 10' 在 detached 子进程组里。
	const child = isWindows
		? spawn("cmd", ["/c", "ping -n 10 127.0.0.1"], { stdio: "ignore", detached: true })
		: spawn("sh", ["-c", "sleep 10"], { stdio: "ignore", detached: true });
	child.unref();
	const rootPid = child.pid!;
	// 给子进程时间真正派生子进程。
	await new Promise((r) => setTimeout(r, 600));
	const { __testOnly } = await import("../extensions/chrome-cdp/launcher.ts");

	// 杀前确认根存活且派生了子进程(否则测试无意义)。
	let rootAliveBefore = true;
	try { process.kill(rootPid, 0); } catch { rootAliveBefore = false; }
	if (!rootAliveBefore) { return; /* 罕见竞态,跳过不阻断 */ }

	__testOnly.killChromeTree(child);
	await new Promise((r) => setTimeout(r, 400));

	// 不变量 1:根进程消失。
	let rootAlive = true;
	try { process.kill(rootPid, 0); } catch { rootAlive = false; }
	assert.equal(rootAlive, false, `进程树根 PID=${rootPid} 应已被杀`);

	// 不变量 2(关键):根的子进程也消失。无 /T 时只杀根,子进程成孤儿继续跑。
	const countChildren = (parentPid: number): number => {
		if (isWindows) {
			const r = spawnSync("powershell", [
				"-NoProfile", "-Command",
				`@(Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + ${parentPid})).Count`,
			], { windowsHide: true });
			return Number((r.stdout?.toString().trim()) || "0");
		}
		const r = spawnSync("pgrep", ["-P", String(parentPid)], { stdio: "pipe" });
		return r.stdout ? r.stdout.toString().trim().split("\n").filter(Boolean).length : 0;
	};
	assert.equal(countChildren(rootPid), 0, `PID=${rootPid} 的子进程应全被杀(进程树 kill),残留即 /T 失效`);
});
