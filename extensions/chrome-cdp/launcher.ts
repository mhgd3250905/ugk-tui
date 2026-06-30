import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findCommandOnPath } from "../shared/binary.ts";

export interface ChromeLaunchCommand {
	command: string;
	args: string[];
	profilePath: string;
}

export interface ChromeBinaryResolution {
	found: boolean;
	command: string;
}

export function getDefaultChromeProfilePath(homeDir = os.homedir()): string {
	return path.join(homeDir, ".ugk", "chrome-cdp-profile");
}

// Windows 上 Chrome 可能装在 Program Files / Program Files (x86) / 用户目录,按顺序找
function findWindowsChrome(): string | null {
	const candidates = [
		path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
		path.join(
			process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
			"Google",
			"Chrome",
			"Application",
			"chrome.exe",
		),
		path.join(
			process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
			"Google",
			"Chrome",
			"Application",
			"chrome.exe",
		),
	];
	for (const c of candidates) {
		try {
			if (fs.existsSync(c)) return c;
		} catch {
			/* 忽略权限/路径错误,继续找下一个 */
		}
	}
	return null;
}

export function resolveChromeBinary(options: {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
} = {}): ChromeBinaryResolution {
	const platform = options.platform ?? process.platform;
	if (platform === "darwin") {
		const command = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
		return { command, found: fs.existsSync(command) };
	}
	if (platform === "win32") {
		const installed = findWindowsChrome();
		if (installed) return { command: installed, found: true };
		const onPath = findCommandOnPath("chrome.exe", options.env);
		return { command: onPath ?? "chrome.exe", found: Boolean(onPath) };
	}
	const onPath = findCommandOnPath("google-chrome", options.env);
	return { command: onPath ?? "google-chrome", found: Boolean(onPath) };
}

export function getChromeLaunchCommand(options: {
	port: number;
	homeDir?: string;
	platform?: NodeJS.Platform;
}): ChromeLaunchCommand {
	const profilePath = getDefaultChromeProfilePath(options.homeDir);
	const platform = options.platform ?? process.platform;
	let command: string;
	if (platform === "darwin") {
		command = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	} else if (platform === "win32") {
		command = findWindowsChrome() ?? "chrome.exe"; // 找不到就交给 PATH 兜底
	} else {
		command = "google-chrome";
	}
	return {
		command,
		profilePath,
		args: [`--remote-debugging-port=${options.port}`, `--user-data-dir=${profilePath}`],
	};
}

// ponytail: ugk 自己起的调试 Chrome 句柄。agent 进程退出时主动回收,
// 避免 --remote-debugging-port + 用户登录态 Chrome 永久驻留(持久攻击面)。
// detached 保留:Chrome 用户可能想继续用窗口;但 agent 退出该清掉它启动的调试实例。
const managedChromeChildren = new Set<ChildProcess>();
let teardownHookInstalled = false;

// ponytail: 必须杀整棵进程树,不能只杀主进程。Chrome 启动后会派生大量子进程
// (renderer/gpu/crashpad/utility...),窗口由整棵树支撑。只 child.kill() 主进程:
//   - Windows:子进程不级联,窗口残留(实测验证:主进程被 kill 但 PID 树下的 renderer
//     仍存活,Chrome 窗口不消失)。
//   - Unix:detached:true 让 Chrome 成新进程组长,kill(-pid) 整组才彻底。
function killChromeTree(child: ChildProcess): void {
	const pid = child.pid;
	if (pid === undefined) return;
	try {
		if (process.platform === "win32") {
			// taskkill /T 递归 kill 进程树;/F 强制。同步且无子进程残留。
			spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		} else {
			// 负 PID = 杀整个进程组(detached:true 时 Chrome 是组长)。先组,再单独兜底。
			try { process.kill(-pid, "SIGTERM"); } catch { /* 组可能不存在,fallthrough */ }
			try { child.kill("SIGTERM"); } catch { /* 主进程可能已退出 */ }
		}
	} catch { /* best-effort:进程可能已退出 */ }
}

// ponytail: test override —— 让测试注入 fake kill(避免真调系统 taskkill/process.kill),
// 验证 teardown 是否对每个 managed child 都调了进程树 kill。
let killChromeTreeImpl: (child: ChildProcess) => void = killChromeTree;

function teardownManagedChrome(): void {
	for (const child of managedChromeChildren) {
		killChromeTreeImpl(child);
	}
	managedChromeChildren.clear();
}

function ensureTeardownHook(): void {
	if (teardownHookInstalled) return;
	teardownHookInstalled = true;
	// beforeExit:Node 事件循环空了准备退出(正常退出路径)。
	// exit:进程即将退出(同步,最后兜底)。
	process.once("beforeExit", teardownManagedChrome);
	process.once("exit", teardownManagedChrome);
	// ponytail: 信号退出。Windows 无真实 SIGTERM/SIGKILL,但 Git Bash 下 SIGINT(Ctrl+C)可捕获。
	// 注册失败(已被占用/平台不支持)不阻塞 launch 主流程。
	try {
		process.once("SIGINT", () => { teardownManagedChrome(); process.exit(130); });
		process.once("SIGTERM", () => { teardownManagedChrome(); process.exit(143); });
	} catch { /* 信号 hook 注册失败忽略 */ }
}

export function launchChromeCdp(port: number): string {
	const { command, args, profilePath } = getChromeLaunchCommand({ port });
	try {
		// 绝对路径直接走 CreateProcess;只有 PATH 兜底(chrome.exe)时才需要 shell 解析
		const useShell = !path.isAbsolute(command);
		const child = spawn(command, args, {
			detached: true,
			stdio: "ignore",
			shell: useShell,
		});
		managedChromeChildren.add(child);
		// ponytail: Chrome 自行退出时(用户叉掉/崩溃)从 Set 清掉,teardown 不再 kill 已死进程。
		child.on("exit", () => { managedChromeChildren.delete(child); });
		ensureTeardownHook();
		child.unref();
		return `Started Chrome CDP on 127.0.0.1:${port}\nProfile: ${profilePath}\nBinary: ${command}`;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Failed to launch Chrome CDP: ${msg}\nLooked for: ${command}\nTry setting CHROME_PATH env var or installing Chrome.`,
		);
	}
}

// ponytail: 测试专用导出。不真 spawn Chrome,直接验证 Set 注册 + teardown kill 语义。
// killChromeTree 单独导出:端到端测试要直接验证"杀整棵进程树"的系统行为(单元 mock 测不到)。
export const __testOnly = {
	get managedChildren(): Set<ChildProcess> { return managedChromeChildren; },
	teardown: teardownManagedChrome,
	killChromeTree,
	resetTeardownHook(): void { teardownHookInstalled = false; },
	setKillImpl(fn: (child: ChildProcess) => void): () => void {
		const prev = killChromeTreeImpl;
		killChromeTreeImpl = fn;
		return () => { killChromeTreeImpl = prev; };
	},
};

export interface ChromeCdpReadinessResult {
	ready: boolean;
	elapsedMs: number;
	error?: string;
}

// launch 后轮询 /json/version,直到 Chrome 真的能接连接或超时。
// 解决"spawn 完立刻 fetch → fetch failed"的启动竞态。
export async function waitForChromeCdpReady(options: {
	port: number;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	intervalMs?: number;
}): Promise<ChromeCdpReadinessResult> {
	const { port, fetchImpl = fetch, timeoutMs = 15000, intervalMs = 250 } = options;
	const deadline = Date.now() + timeoutMs;
	let lastError = "";
	while (Date.now() < deadline) {
		try {
			const res = await fetchImpl(`http://127.0.0.1:${port}/json/version`);
			if (res.ok) {
				return { ready: true, elapsedMs: timeoutMs - (deadline - Date.now()) };
			}
			lastError = `HTTP ${res.status}`;
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	return { ready: false, elapsedMs: timeoutMs, error: lastError };
}

export async function launchChromeCdpAndWait(port: number): Promise<string> {
	const message = launchChromeCdp(port);
	const readiness = await waitForChromeCdpReady({ port });
	if (readiness.ready) {
		return `${message}\nReady (waited ${readiness.elapsedMs}ms).`;
	}
	return `${message}\nNot yet reachable after ${readiness.timeoutMs ?? 15000}ms (${readiness.error}). Chrome may still be starting — retry /cdp status in a moment.`;
}
