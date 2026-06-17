import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const GITHUB_MAIN_COMMIT_URL = "https://api.github.com/repos/mhgd3250905/ugk-tui/commits/main";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UgkUpdateState {
	lastCheckedAt?: string;
	skippedRef?: string;
	skippedAt?: string;
}

export interface UgkUpdateInfo {
	currentRef: string;
	latestRef: string;
	currentVersion: string;
	source: "github-main";
}

export interface UgkUpdateDeps {
	now?: () => Date;
	packageRoot?: string;
	agentDir?: string;
	getCurrentRef?: () => Promise<string | undefined>;
	getLatestRef?: () => Promise<string | undefined>;
	getCurrentVersion?: () => string;
	readState?: () => UgkUpdateState;
	writeState?: (state: UgkUpdateState) => void;
	applyUpdate?: () => Promise<string>;
}

function shortRef(ref: string): string {
	return ref.slice(0, 7);
}

function defaultPackageRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function defaultAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function statePath(agentDir = defaultAgentDir()): string {
	return path.join(agentDir, "ugk-update.json");
}

export function readUgkUpdateState(agentDir = defaultAgentDir()): UgkUpdateState {
	try {
		return JSON.parse(fs.readFileSync(statePath(agentDir), "utf8"));
	} catch {
		return {};
	}
}

export function writeUgkUpdateState(state: UgkUpdateState, agentDir = defaultAgentDir()): void {
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(statePath(agentDir), `${JSON.stringify(state, null, 2)}\n`);
}

export function shouldCheckForUgkUpdate(state: UgkUpdateState, now: Date, force = false): boolean {
	if (force) return true;
	return true;
}

export function shouldPromptForUgkUpdate(state: UgkUpdateState, info: UgkUpdateInfo, now = new Date()): boolean {
	if (state.skippedRef !== info.latestRef) return true;
	if (!state.skippedAt) return true;
	const skippedAt = Date.parse(state.skippedAt);
	if (!Number.isFinite(skippedAt)) return true;
	return now.getTime() - skippedAt >= CHECK_INTERVAL_MS;
}

export function formatUgkUpdateNotice(info: UgkUpdateInfo): string {
	return [
		"UGK 有新版本可用",
		"",
		`当前版本: ${info.currentVersion} (${shortRef(info.currentRef)})`,
		`最新版本: ${shortRef(info.latestRef)}`,
		"",
		"更新内容:",
		"- 同步 UGK 最新功能、修复和文档",
	].join("\n");
}

export async function detectUgkUpdate(deps: UgkUpdateDeps = {}): Promise<UgkUpdateInfo | undefined> {
	const currentRef = await (deps.getCurrentRef || (() => getLocalGitRef(deps.packageRoot)))();
	const latestRef = await (deps.getLatestRef || getGithubMainRef)();
	const currentVersion = (deps.getCurrentVersion || (() => readPackageVersion(deps.packageRoot)))();

	if (!currentRef || !latestRef || currentRef === latestRef) return undefined;

	return {
		currentRef,
		latestRef,
		currentVersion,
		source: "github-main",
	};
}

export async function getLocalGitRef(packageRoot = defaultPackageRoot()): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", packageRoot, "rev-parse", "HEAD"]);
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

export async function getGithubMainRef(): Promise<string | undefined> {
	try {
		const response = await fetch(GITHUB_MAIN_COMMIT_URL, {
			headers: { "user-agent": "ugk-agent/update-check" },
		});
		if (!response.ok) return undefined;
		const body = (await response.json()) as { sha?: string };
		return body.sha;
	} catch {
		return undefined;
	}
}

export function readPackageVersion(packageRoot = defaultPackageRoot()): string {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
		return pkg.version || "unknown";
	} catch {
		return "unknown";
	}
}

export function getPackageManagerCommand(platform = process.platform): string {
	return platform === "win32" ? "npm.cmd" : "npm";
}

export async function applyLocalGitUpdate(packageRoot = defaultPackageRoot()): Promise<string> {
	const status = await execFileAsync("git", ["-C", packageRoot, "status", "--porcelain", "--untracked-files=no"]);
	if (status.stdout.trim()) {
		throw new Error("当前本地项目有未提交的已跟踪改动,为避免覆盖修改,已取消自动更新。");
	}

	await execFileAsync("git", ["-C", packageRoot, "pull", "--rebase", "origin", "main"]);
	await execFileAsync(getPackageManagerCommand(), ["install"], { cwd: packageRoot });
	return "UGK 已更新完成。请重启 ugk 使用新版本。";
}

async function promptAndMaybeUpdate(ctx: any, info: UgkUpdateInfo, deps: UgkUpdateDeps, state: UgkUpdateState): Promise<void> {
	if (!ctx.hasUI || !ctx.ui?.select) {
		ctx.ui?.notify?.(formatUgkUpdateNotice(info), "info");
		return;
	}

	const choice = await ctx.ui.select(formatUgkUpdateNotice(info), ["现在更新", "跳过本次"]);
	if (choice === "跳过本次") {
		(deps.writeState || ((next) => writeUgkUpdateState(next, deps.agentDir)))({
			...state,
			skippedRef: info.latestRef,
			skippedAt: (deps.now || (() => new Date()))().toISOString(),
		});
		ctx.ui.notify("已跳过本次 UGK 更新提示。", "info");
		return;
	}
	if (choice !== "现在更新") return;

	try {
		ctx.ui.notify("正在更新 UGK...", "info");
		const result = await (deps.applyUpdate || (() => applyLocalGitUpdate(deps.packageRoot)))();
		ctx.ui.notify(result, "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : "UGK 更新失败。", "warning");
	}
}

async function checkAndPrompt(ctx: any, deps: UgkUpdateDeps = {}, force = false): Promise<void> {
	const now = (deps.now || (() => new Date()))();
	const readState = deps.readState || (() => readUgkUpdateState(deps.agentDir));
	const writeState = deps.writeState || ((state) => writeUgkUpdateState(state, deps.agentDir));
	const state = readState();

	if (!shouldCheckForUgkUpdate(state, now, force)) return;

	const info = await detectUgkUpdate(deps);
	writeState({ ...state, lastCheckedAt: now.toISOString() });
	if (!info) {
		if (force) ctx.ui.notify("UGK 已是最新版本。", "info");
		return;
	}
	if (!force && !shouldPromptForUgkUpdate(state, info, now)) return;

	await promptAndMaybeUpdate(ctx, info, deps, state);
}

export function registerUgkUpdate(pi: ExtensionAPI, deps: UgkUpdateDeps = {}): void {
	pi.registerCommand("update", {
		description: "检查并更新 UGK",
		handler: async (_args, ctx) => {
			await checkAndPrompt(ctx, deps, true);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		void checkAndPrompt(ctx, deps, false).catch(() => undefined);
	});
}
