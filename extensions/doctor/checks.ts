import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createChromeCdpClient, getChromeCdpStatus, type ChromeCdpStatus } from "../chrome-cdp/client.ts";
import { createChromeCdpState, resolveChromeCdpPort } from "../chrome-cdp/config.ts";
import { resolveChromeBinary, type ChromeBinaryResolution } from "../chrome-cdp/launcher.ts";
import { getDeepSeekStatus, type DeepSeekStatusDeps } from "../deepseek-status.ts";
import { readSettingsJson, updateSettingsJson } from "../shared/settings-io.ts";
import { uiText } from "../shared/ui-language.ts";
import type { DoctorCheck, DoctorResult } from "./types.ts";

const execFileAsync = promisify(execFile);

export interface BashCheckDeps {
	exec?: (command: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string | Buffer }>;
	resolveBash?: () => BashResolution;
	platform?: NodeJS.Platform;
	agentDir?: string;
	exists?: (candidate: string) => boolean;
	readFile?: (filePath: string) => string;
	writeFile?: (filePath: string, content: string) => void;
	mkdir?: (dirPath: string, options: { recursive: true }) => void;
}

export interface BashResolution {
	command: string;
	source: string;
}

export interface ChromeBinaryCheckDeps {
	resolveChromeBinary?: () => ChromeBinaryResolution;
}

export interface ChromeCdpCheckDeps {
	resolvePort?: () => number;
	getStatus?: (port: number) => Promise<ChromeCdpStatus>;
	timeoutMs?: number;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function defaultAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function readShellPathFromSettings(agentDir: string, readFile: (filePath: string) => string): string | undefined {
	try {
		// BOM-safe 读取(见 shared/settings-io.ts):注入 readFile 以保持可测试性,
		// helper 内部会剥离 UTF-8 BOM 再解析。
		const settings = readSettingsJson({ agentDir, readFile }) ?? {};
		return typeof settings.shellPath === "string" && settings.shellPath.trim() ? settings.shellPath : undefined;
	} catch {
		return undefined;
	}
}

function readSettings(
	agentDir: string,
	readFile: (filePath: string) => string,
	exists: (candidate: string) => boolean,
): Record<string, unknown> | undefined {
	return readSettingsJson({ agentDir, readFile, exists });
}

function persistBashResolutionForChildAgents(resolution: BashResolution, deps: BashCheckDeps): void {
	const platform = deps.platform ?? process.platform;
	if (platform !== "win32" || resolution.source === "settings.json shellPath") return;
	if (!path.win32.isAbsolute(resolution.command) || path.win32.basename(resolution.command).toLowerCase() !== "bash.exe") return;

	// BOM-safe 读-改-写(见 shared/settings-io.ts):updateSettingsJson 内部会剥离
	// BOM 读取,值相同则跳过写入,写回时不带 BOM。
	updateSettingsJson({ shellPath: resolution.command }, {
		agentDir: deps.agentDir,
		exists: deps.exists,
		readFile: deps.readFile,
		writeFile: deps.writeFile,
		mkdir: deps.mkdir,
	});
}

export function resolveBashCommand(deps: BashCheckDeps = {}): BashResolution {
	const platform = deps.platform ?? process.platform;
	if (platform !== "win32") return { command: "bash", source: "PATH" };

	const exists = deps.exists ?? fs.existsSync;
	const readFile = deps.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
	const shellPath = readShellPathFromSettings(deps.agentDir ?? defaultAgentDir(), readFile);
	if (shellPath && exists(shellPath)) {
		return { command: shellPath, source: "settings.json shellPath" };
	}

	const candidates = [
		"D:\\Git\\bin\\bash.exe",
		"D:\\Git\\usr\\bin\\bash.exe",
		"E:\\Application\\Git\\bin\\bash.exe",
		"E:\\Application\\Git\\usr\\bin\\bash.exe",
		"C:\\Program Files\\Git\\bin\\bash.exe",
		"C:\\Program Files\\Git\\usr\\bin\\bash.exe",
	];
	const candidate = candidates.find((item) => exists(item));
	if (candidate) return { command: candidate, source: "common Git Bash location" };

	return { command: "bash", source: "PATH" };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function checkBash(deps: BashCheckDeps = {}): Promise<DoctorResult> {
	const exec = deps.exec ?? execFileAsync;
	const bash = (deps.resolveBash ?? (() => resolveBashCommand(deps)))();
	try {
		const result = await exec(bash.command, ["-lc", "echo ok"], { timeout: 3000 });
		if (String(result.stdout).includes("ok")) {
			try {
				persistBashResolutionForChildAgents(bash, deps);
			} catch {
				// Keep /doctor truthful: bash works even if settings cannot be updated.
			}
			return { status: "pass", summary: uiText(`bash 可用(${bash.source}: ${bash.command})`, `bash available (${bash.source}: ${bash.command})`) };
		}
		return {
			status: "fail",
			summary: uiText("bash 不可用: 输出异常", "bash unavailable: unexpected output"),
			nextSteps: [uiText("检查 PATH 或安装 bash 兼容 shell。", "Check PATH or install a bash-compatible shell.")],
		};
	} catch (error) {
		return {
			status: "fail",
			summary: uiText(`bash 不可用: ${errorMessage(error)}`, `bash unavailable: ${errorMessage(error)}`),
			nextSteps: [uiText("检查 PATH 或安装 bash 兼容 shell。", "Check PATH or install a bash-compatible shell.")],
		};
	}
}

export async function checkDeepSeekApi(deps: DeepSeekStatusDeps = {}): Promise<DoctorResult> {
	const status = getDeepSeekStatus(deps);
	if ((/已配置|configured/i.test(status)) && !/未配置|not configured/i.test(status)) {
		return { status: "pass", summary: status.replace(/^deepseek:\s*/, "DeepSeek ") };
	}
	return {
		status: "fail",
		summary: status.replace(/^deepseek:\s*/, "DeepSeek "),
		details: [uiText("底栏模型名只表示当前选择的模型,不代表 DeepSeek API 已配置。", "The footer model name only shows the selected model; it does not mean the DeepSeek API is configured.")],
		nextSteps: [uiText("设置 DEEPSEEK_API_KEY 或运行 /login。", "Set DEEPSEEK_API_KEY or run /login.")],
	};
}

export async function checkChromeBinary(deps: ChromeBinaryCheckDeps = {}): Promise<DoctorResult> {
	const resolution = (deps.resolveChromeBinary ?? resolveChromeBinary)();
	if (resolution.found) {
		return {
			status: "pass",
			summary: uiText(`已找到 Chrome: ${resolution.command}`, `Chrome found: ${resolution.command}`),
		};
	}
	return {
		status: "fail",
		summary: uiText(`未找到 Chrome: ${resolution.command}`, `Chrome not found: ${resolution.command}`),
		nextSteps: [uiText("安装 Chrome 或检查 PATH。", "Install Chrome or check PATH.")],
	};
}

export async function checkChromeCdp(deps: ChromeCdpCheckDeps = {}): Promise<DoctorResult> {
	const port = (deps.resolvePort ?? (() => resolveChromeCdpPort(createChromeCdpState(), {})))();
	const getStatus =
		deps.getStatus ?? (async (resolvedPort: number) => getChromeCdpStatus(createChromeCdpClient({ port: resolvedPort })));
	const status = await withTimeout(getStatus(port), deps.timeoutMs ?? 5000, "Chrome CDP status");

	if (status.online) {
		return {
			status: "pass",
			summary: uiText(`Chrome CDP 可连接: 127.0.0.1:${status.port}`, `Chrome CDP reachable: 127.0.0.1:${status.port}`),
			details: [uiText(`标签页: ${status.tabs?.length ?? 0}`, `Tabs: ${status.tabs?.length ?? 0}`)],
		};
	}

	return {
		status: "warn",
		summary: uiText(`Chrome CDP 无法连接: 127.0.0.1:${status.port}`, `Chrome CDP not reachable: 127.0.0.1:${status.port}`),
		details: status.error ? [status.error] : undefined,
		nextSteps: ["/cdp launch", "/cdp status"],
	};
}

export function createCoreDoctorChecks(): DoctorCheck[] {
	return [
		{ id: "shell.bash", title: "Shell", category: "shell", run: () => checkBash() },
		{ id: "api.deepseek", title: "API", category: "api", run: () => checkDeepSeekApi() },
		{ id: "chrome.binary", title: "Chrome", category: "chrome", run: () => checkChromeBinary() },
		{ id: "chrome.cdp", title: "Chrome", category: "chrome", run: () => checkChromeCdp() },
	];
}
