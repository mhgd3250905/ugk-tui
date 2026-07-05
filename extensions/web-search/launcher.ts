import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findCommandOnPath } from "../shared/binary.ts";

export const WEB_SEARCH_DEFAULT_PORT = 9223;

export interface ChromeLaunchCommand {
	command: string;
	args: string[];
	profilePath: string;
}

export interface ChromeBinaryResolution {
	found: boolean;
	command: string;
}

export function getDefaultWebSearchProfilePath(homeDir = os.homedir()): string {
	return path.join(homeDir, ".ugk", "web-search-profile");
}

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
	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) return candidate;
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

export function getWebSearchLaunchCommand(options: {
	port: number;
	homeDir?: string;
	platform?: NodeJS.Platform;
}): ChromeLaunchCommand {
	const profilePath = getDefaultWebSearchProfilePath(options.homeDir);
	const platform = options.platform ?? process.platform;
	let command: string;
	if (platform === "darwin") {
		command = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	} else if (platform === "win32") {
		command = findWindowsChrome() ?? "chrome.exe";
	} else {
		command = "google-chrome";
	}
	return {
		command,
		profilePath,
		args: [
			`--remote-debugging-port=${options.port}`,
			"--remote-debugging-address=127.0.0.1",
			`--user-data-dir=${profilePath}`,
			"--headless=new",
			"--no-first-run",
			"--disable-gpu",
		],
	};
}

// ponytail: 与 chrome-cdp launcher 重复,换来完全隔离；两边同步演进多次再抽 shared。
const managedWebSearchPorts = new Set<number>();
let teardownHookInstalled = false;

function killChromeByPort(port: number): void {
	try {
		if (process.platform === "win32") {
			const result = spawnSync("powershell", [
				"-NoProfile",
				"-Command",
				`Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
					`Where-Object { $_.CommandLine -match '--remote-debugging-port=${port}' } | ` +
					"ForEach-Object { $_.ProcessId }",
			], { windowsHide: true, encoding: "utf8" });
			const pids = (result.stdout || "").split(/\s+/).map((item) => Number(item)).filter((pid) => pid > 0);
			for (const pid of pids) {
				try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {}
			}
		} else {
			const result = spawnSync("pgrep", ["-f", `--remote-debugging-port=${port}`], { encoding: "utf8" });
			const pids = (result.stdout || "").split(/\s+/).map((item) => Number(item)).filter((pid) => pid > 0);
			for (const pid of pids) {
				try { process.kill(pid, "SIGTERM"); } catch {}
			}
		}
	} catch {
		/* best-effort */
	}
}

let killChromeByPortImpl: (port: number) => void = killChromeByPort;

function teardownManagedChrome(): void {
	for (const port of managedWebSearchPorts) killChromeByPortImpl(port);
	managedWebSearchPorts.clear();
}

function ensureTeardownHook(): void {
	if (teardownHookInstalled) return;
	teardownHookInstalled = true;
	process.once("beforeExit", teardownManagedChrome);
	process.once("exit", teardownManagedChrome);
	try {
		process.once("SIGINT", () => { teardownManagedChrome(); process.exit(130); });
		process.once("SIGTERM", () => { teardownManagedChrome(); process.exit(143); });
	} catch {
		/* 信号 hook 注册失败不阻塞搜索 */
	}
}

export function launchWebSearchChrome(port = WEB_SEARCH_DEFAULT_PORT): string {
	const { command, args, profilePath } = getWebSearchLaunchCommand({ port });
	try {
		const useShell = !path.isAbsolute(command);
		const child = spawn(command, args, {
			detached: true,
			stdio: "ignore",
			shell: useShell,
			windowsHide: true,
		});
		child.unref();
		managedWebSearchPorts.add(port);
		ensureTeardownHook();
		return `Started web_search Chrome on 127.0.0.1:${port}\nProfile: ${profilePath}\nBinary: ${command}`;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to launch web_search Chrome: ${msg}\nLooked for: ${command}\nTry installing Google Chrome.`);
	}
}

export const __testOnly = {
	get managedPorts(): Set<number> { return managedWebSearchPorts; },
	teardown: teardownManagedChrome,
	killChromeByPort,
	resetTeardownHook(): void { teardownHookInstalled = false; },
	setKillImpl(fn: (port: number) => void): () => void {
		const previous = killChromeByPortImpl;
		killChromeByPortImpl = fn;
		return () => { killChromeByPortImpl = previous; };
	},
};

export interface WebSearchReadinessResult {
	ready: boolean;
	elapsedMs: number;
	error?: string;
}

export async function waitForWebSearchReady(options: {
	port?: number;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	intervalMs?: number;
} = {}): Promise<WebSearchReadinessResult> {
	const { port = WEB_SEARCH_DEFAULT_PORT, fetchImpl = fetch, timeoutMs = 15000, intervalMs = 250 } = options;
	const started = Date.now();
	const deadline = started + timeoutMs;
	let lastError = "";
	while (Date.now() < deadline) {
		try {
			const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`);
			if (response.ok) return { ready: true, elapsedMs: Date.now() - started };
			lastError = `HTTP ${response.status}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	return { ready: false, elapsedMs: Date.now() - started, error: lastError };
}

export async function launchWebSearchChromeAndWait(port = WEB_SEARCH_DEFAULT_PORT): Promise<string> {
	const message = launchWebSearchChrome(port);
	const readiness = await waitForWebSearchReady({ port });
	if (readiness.ready) return `${message}\nReady (waited ${readiness.elapsedMs}ms).`;
	return `${message}\nNot yet reachable after 15000ms (${readiness.error}). Chrome may still be starting.`;
}
