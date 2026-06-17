import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

function findCommandOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
	const pathValue = env.PATH ?? "";
	const extensions =
		process.platform === "win32"
			? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
			: [""];
	for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
		const lowerCommand = command.toLowerCase();
		const candidates = extensions.map((ext) =>
			path.join(dir, lowerCommand.endsWith(ext.toLowerCase()) ? command : `${command}${ext}`),
		);
		for (const candidate of candidates) {
			try {
				if (fs.existsSync(candidate)) return candidate;
			} catch {
				// Ignore unreadable PATH entries.
			}
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
		child.unref();
		return `Started Chrome CDP on 127.0.0.1:${port}\nProfile: ${profilePath}\nBinary: ${command}`;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Failed to launch Chrome CDP: ${msg}\nLooked for: ${command}\nTry setting CHROME_PATH env var or installing Chrome.`,
		);
	}
}

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
