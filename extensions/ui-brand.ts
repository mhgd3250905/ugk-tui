import fs from "node:fs";
import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	buildUgkFooterLines,
	buildUgkHeaderLines,
	buildUgkStartupScreenLines,
	classifyUgkStatusTone,
	resolveUgkDisplayModelId,
	type UgkFooterUsage,
} from "./ui-brand-utils.ts";
import { getDeepSeekStatus } from "./deepseek-status.ts";
import { readSettingsJson } from "./shared/settings-io.ts";

function readUgkVersion(): string {
	try {
		const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		return typeof pkg.version === "string" && pkg.version ? pkg.version : "unknown";
	} catch {
		return "unknown";
	}
}

const VERSION = readUgkVersion();
const ENABLED_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const DISABLED_ENV_VALUES = new Set(["0", "false", "no", "off"]);
const UGK_UI_MENU_OPTIONS = ["Show status", "Turn off", "Turn on", "Exit"];

function envDisablesBrandUi(): boolean {
	const raw = process.env.UGK_UI;
	return raw ? DISABLED_ENV_VALUES.has(raw.toLowerCase()) : false;
}

function envEnablesBrandUi(): boolean {
	const raw = process.env.UGK_UI;
	return raw ? ENABLED_ENV_VALUES.has(raw.toLowerCase()) : false;
}

function formatTitle(pi: ExtensionAPI, cwd: string): string {
	const cwdName = path.basename(cwd);
	const session = pi.getSessionName();
	return session ? `ugk - ${session} - ${cwdName}` : `ugk - ${cwdName}`;
}

function shouldClearStartupScreen(): boolean {
	const rawEnv = process.env.UGK_CLEAR_STARTUP;
	if (rawEnv && DISABLED_ENV_VALUES.has(rawEnv.toLowerCase())) return false;
	if (rawEnv && ENABLED_ENV_VALUES.has(rawEnv.toLowerCase())) return true;

	// BOM-safe 读取(见 shared/settings-io.ts):settings.json 可能带 UTF-8 BOM,
	// 旧实现裸 JSON.parse 会抛错静默降级,这里改用 helper 剥离 BOM。
	const settings = readSettingsJson();
	return (settings?.clearStartupScreen ?? true) !== false;
}

function clearStartupScreen(ctx: ExtensionContext): void {
	if ((ctx as any).hasUI === false || !process.stdout.isTTY) return;
	if (!shouldClearStartupScreen()) return;
	process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}

function hasSessionMessages(ctx: { sessionManager?: { getEntries?: () => unknown[]; getBranch?: () => unknown[] } }): boolean {
	const entries = ctx.sessionManager?.getEntries?.() ?? ctx.sessionManager?.getBranch?.() ?? [];
	return entries.length > 0;
}

function colorHeaderLine(line: string, index: number, theme: any): string {
	const trimmed = line.trimStart();
	if (line.includes("█") && !trimmed.startsWith("│")) {
		return theme.bold(theme.fg("success", line));
	}
	const logoColoredLine = line.replace(/█+/g, (block) => theme.bold(theme.fg("success", block)));
	if (/[░▒▓]/.test(line) || trimmed.startsWith("╭")) {
		return theme.fg("dim", line);
	}
	if (!line.trim()) return line;
	if (/^[┌├└]/.test(trimmed)) {
		return logoColoredLine
			.replace("ugk", theme.bold(theme.fg("success", "ugk")))
			.replace("quick actions", theme.fg("success", "quick actions"))
			.replace("model", theme.fg("success", "model"));
	}
	if (trimmed.startsWith("│")) {
		const colored = logoColoredLine
			.replace(/(workspace|agent|stack|model)/, theme.fg("dim", "$1"))
			.replace("Tips for getting started", theme.fg("success", "Tips for getting started"))
			.replace("What's new", theme.fg("success", "What's new"))
			.replace("/plan", theme.fg("success", "/plan"))
			.replace("/implement", theme.fg("success", "/implement"))
			.replace("/check-env", theme.fg("success", "/check-env"))
			.replace("@agent", theme.fg("success", "@agent"));
		return colorStatefulText(colored, theme);
	}
	if (line.startsWith("  ")) return theme.fg("success", line);
	if (index === 0) return theme.fg("muted", line);
	return line
		.replace("model", theme.fg("dim", "model"))
		.replace("/plan", theme.fg("success", "/plan"))
		.replace("/implement", theme.fg("success", "/implement"))
		.replace("/check-env", theme.fg("success", "/check-env"))
		.replace("@agent", theme.fg("success", "@agent"));
}

function colorStatefulText(text: string, theme: any): string {
	const statefulValues = ["❌ API not configured", "api not configured", "model not selected", "bash unavailable", "subagent not loaded"];
	return statefulValues.reduce((current, value) => {
		if (!current.includes(value)) return current;
		return current.replace(value, theme.fg(classifyUgkStatusTone(value), value));
	}, text);
}

function classifyContextProgressTone(contextText: string): "success" | "warning" | "error" | "dim" {
	const match = /([0-9]+(?:\.[0-9]+)?)%\//.exec(contextText);
	if (!match) return "dim";
	const percent = Number(match[1]);
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

function colorFooterUsageText(usage: string, theme: any): string {
	const match = /^(.*?🧠 )([█▒]{8})( .*)$/.exec(usage);
	if (!match) return theme.fg("dim", usage);
	const filled = match[2].match(/^█*/)?.[0] ?? "";
	const empty = match[2].slice(filled.length);
	return `${theme.fg("dim", match[1])}${filled ? theme.fg(classifyContextProgressTone(match[3]), filled) : ""}${empty ? theme.fg("dim", empty) : ""}${theme.fg("dim", match[3])}`;
}

function colorFooterUsageLine(line: string, theme: any): string {
	const separator = "  ";
	const index = line.lastIndexOf(separator);
	if (index === -1) return theme.fg("dim", line);
	const usage = line.slice(0, index);
	const modelOrState = line.slice(index + separator.length);
	return `${colorFooterUsageText(usage, theme)}${separator}${theme.fg(classifyUgkStatusTone(modelOrState), modelOrState)}`;
}

function colorFooterStatusLine(statuses: string[], fallback: string, theme: any): string {
	const values = statuses.length ? statuses : [fallback];
	return values.map((status) => theme.fg(classifyUgkStatusTone(status), status)).join(" ");
}

interface BrandUiSessionSource {
	cwd: string;
	modelId?: string;
	modelContextWindow?: number;
	thinkingLevel?: string;
	contextUsage?: { percent?: number; contextWindow?: number };
	sessionManager?: {
		getCwd?: () => string;
		getEntries?: () => unknown[];
		getBranch?: () => unknown[];
	};
}

function createBrandUiSessionSource(ctx: ExtensionContext): BrandUiSessionSource {
	return {
		cwd: ctx.cwd ?? process.cwd(),
		modelId: ctx.model?.id,
		modelContextWindow: ctx.model?.contextWindow,
		thinkingLevel: (ctx as any).session?.state?.thinkingLevel,
		contextUsage: ctx.getContextUsage?.(),
		sessionManager: ctx.sessionManager,
	};
}

class UgkHeader implements Component {
	private readonly source: BrandUiSessionSource;
	private readonly theme: any;

	constructor(source: BrandUiSessionSource, theme: any) {
		this.source = source;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const cwd = this.source.sessionManager?.getCwd?.() ?? this.source.cwd;
		const modelId = resolveUgkDisplayModelId(this.source.modelId, getDeepSeekStatus());
		const options = {
			version: VERSION,
			cwdName: path.basename(cwd),
			modelId,
			width,
		};
		const lines = hasSessionMessages(this.source)
			? buildUgkHeaderLines(options)
			: buildUgkStartupScreenLines({
					...options,
					rows: process.stdout.rows || 24,
				});
		const rendered = ["", ...lines.map((line, i) => colorHeaderLine(line, i, this.theme)), ""];
		return rendered;
	}
}

function collectUsage(source: BrandUiSessionSource): UgkFooterUsage {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	const entries = source.sessionManager?.getEntries?.() ?? source.sessionManager?.getBranch?.() ?? [];
	for (const entry of entries) {
		const message = (entry as any).message as AssistantMessage | undefined;
		if ((entry as any).type !== "message" || message?.role !== "assistant" || !message.usage) continue;
		input += message.usage.input || 0;
		output += message.usage.output || 0;
		cacheRead += message.usage.cacheRead || 0;
		cacheWrite += message.usage.cacheWrite || 0;
		cost += message.usage.cost?.total || 0;
	}
	const context = source.contextUsage;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		cost,
		contextPercent: context?.percent ?? null,
		contextWindow: context?.contextWindow ?? source.modelContextWindow ?? 0,
	};
}

class UgkFooter implements Component {
	private unsubscribe?: () => void;
	private readonly source: BrandUiSessionSource;
	private readonly theme: any;
	private readonly footerData: any;
	private readonly tui: { requestRender(): void };

	constructor(source: BrandUiSessionSource, theme: any, footerData: any, tui: { requestRender(): void }) {
		this.source = source;
		this.theme = theme;
		this.footerData = footerData;
		this.tui = tui;
		this.unsubscribe = footerData.onBranchChange?.(() => this.tui.requestRender());
	}

	dispose(): void {
		this.unsubscribe?.();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const statuses = Array.from(this.footerData.getExtensionStatuses?.().values?.() ?? []) as string[];
		const cwd = this.source.sessionManager?.getCwd?.() ?? this.source.cwd;
		const lines = buildUgkFooterLines({
			cwd,
			branch: this.footerData.getGitBranch?.() ?? null,
			modelId: resolveUgkDisplayModelId(this.source.modelId, getDeepSeekStatus()) || "no-model",
			thinkingLevel: this.source.thinkingLevel,
			statuses,
			usage: collectUsage(this.source),
			width,
		});

		const [pwd, usage, status] = lines;
		const coloredPwd = pwd.replace(/^ugk/, this.theme.fg("success", "ugk"));
		const rendered = [this.theme.fg("dim", coloredPwd), colorFooterUsageLine(usage, this.theme)];
		if (status.trim()) rendered.push(colorFooterStatusLine(statuses, status, this.theme));
		return rendered.map((line) => {
			if (visibleWidth(line) <= width) return line;
			return truncateToWidth(line, width, this.theme.fg("dim", "..."));
		});
	}
}

function applyBrandUi(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const source = createBrandUiSessionSource(ctx);
	ctx.ui.setHeader((_tui, theme) => new UgkHeader(source, theme));
	ctx.ui.setFooter((tui, theme, footerData) => new UgkFooter(source, theme, footerData, tui));
	ctx.ui.setTitle(formatTitle(pi, source.sessionManager?.getCwd?.() ?? source.cwd));
}

function clearBrandUi(ctx: ExtensionContext): void {
	ctx.ui.setHeader(undefined);
	ctx.ui.setFooter(undefined);
}

export default function registerUgkBrandUi(pi: ExtensionAPI): void {
	let enabled = !envDisablesBrandUi();

	pi.registerFlag("ugk-ui-off", {
		description: "Disable ugk branded header/footer UI",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("ugk-ui", {
		description: "Toggle ugk branded header/footer UI (on/off/status)",
		handler: async (args, ctx) => {
			let action = args.trim().toLowerCase();
			if (!action && ctx.ui?.select) {
				const selection = await ctx.ui.select("UGK UI", UGK_UI_MENU_OPTIONS);
				if (!selection || selection === "Exit") return;
				if (selection === "Show status") action = "status";
				if (selection === "Turn off") action = "off";
				if (selection === "Turn on") action = "on";
			}
			if (!action) action = "status";
			if (action === "on" || action === "enable") {
				enabled = true;
				applyBrandUi(pi, ctx);
				ctx.ui.notify("ugk UI enabled", "info");
				return;
			}
			if (action === "off" || action === "disable") {
				enabled = false;
				clearBrandUi(ctx);
				ctx.ui.notify("ugk UI disabled", "info");
				return;
			}
			ctx.ui.notify(`ugk UI is ${enabled ? "enabled" : "disabled"}. Use /ugk-ui on or /ugk-ui off.`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const disabledByFlag = pi.getFlag("ugk-ui-off") === true;
		if (disabledByFlag || (envDisablesBrandUi() && !envEnablesBrandUi()) || !enabled) {
			clearBrandUi(ctx);
			return;
		}
		enabled = true;
		clearStartupScreen(ctx);
		applyBrandUi(pi, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearBrandUi(ctx);
	});
}
