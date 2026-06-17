import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createChromeCdpClient, getChromeCdpStatus, type ChromeCdpStatus } from "../chrome-cdp/client.ts";
import { createChromeCdpState, resolveChromeCdpPort } from "../chrome-cdp/config.ts";
import { resolveChromeBinary, type ChromeBinaryResolution } from "../chrome-cdp/launcher.ts";
import { getDeepSeekStatus, type DeepSeekStatusDeps } from "../deepseek-status.ts";
import type { DoctorCheck, DoctorResult } from "./types.ts";

const execFileAsync = promisify(execFile);

export interface BashCheckDeps {
	exec?: (command: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string | Buffer }>;
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
	try {
		const result = await exec("bash", ["-lc", "echo ok"], { timeout: 3000 });
		if (String(result.stdout).includes("ok")) {
			return { status: "pass", summary: "bash available" };
		}
		return {
			status: "fail",
			summary: "bash unavailable: unexpected output",
			nextSteps: ["Check PATH or install a bash-compatible shell."],
		};
	} catch (error) {
		return {
			status: "fail",
			summary: `bash unavailable: ${errorMessage(error)}`,
			nextSteps: ["Check PATH or install a bash-compatible shell."],
		};
	}
}

export async function checkDeepSeekApi(deps: DeepSeekStatusDeps = {}): Promise<DoctorResult> {
	const status = getDeepSeekStatus(deps);
	if (/已配置/.test(status)) {
		return { status: "pass", summary: status.replace(/^deepseek:\s*/, "DeepSeek ") };
	}
	return {
		status: "fail",
		summary: status.replace(/^deepseek:\s*/, "DeepSeek "),
		nextSteps: ["Set DEEPSEEK_API_KEY or run /login."],
	};
}

export async function checkChromeBinary(deps: ChromeBinaryCheckDeps = {}): Promise<DoctorResult> {
	const resolution = (deps.resolveChromeBinary ?? resolveChromeBinary)();
	if (resolution.found) {
		return {
			status: "pass",
			summary: `Chrome found: ${resolution.command}`,
		};
	}
	return {
		status: "fail",
		summary: `Chrome not found: ${resolution.command}`,
		nextSteps: ["Install Chrome or check PATH."],
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
			summary: `Chrome CDP reachable on 127.0.0.1:${status.port}`,
			details: [`Tabs: ${status.tabs?.length ?? 0}`],
		};
	}

	return {
		status: "warn",
		summary: `Chrome CDP not reachable on 127.0.0.1:${status.port}`,
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
