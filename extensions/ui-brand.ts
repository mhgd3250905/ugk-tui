import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { buildUgkFooterLines, buildUgkHeaderLines, type UgkFooterUsage } from "./ui-brand-utils.ts";

const VERSION = "1.0.0";
const ENABLED_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const DISABLED_ENV_VALUES = new Set(["0", "false", "no", "off"]);

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

function colorHeaderLine(line: string, index: number, theme: any): string {
	if (line.includes("█")) {
		return theme.bold(theme.fg("success", line));
	}
	if (line.startsWith("ugk v")) {
		const [brand, ...rest] = line.split("  // ");
		const tail = rest.length ? `  // ${rest.join("  // ")}` : "";
		return `${theme.bold(theme.fg("success", brand))}${theme.fg("dim", tail)}`;
	}
	if (index === 0 || line.startsWith("terminal coding agent")) return theme.fg("muted", line);
	return line
		.replace("model", theme.fg("dim", "model"))
		.replace("/plan", theme.fg("success", "/plan"))
		.replace("/implement", theme.fg("success", "/implement"))
		.replace("/check-env", theme.fg("success", "/check-env"))
		.replace("@agent", theme.fg("success", "@agent"));
}

class UgkHeader implements Component {
	private readonly ctx: ExtensionContext;
	private readonly theme: any;

	constructor(ctx: ExtensionContext, theme: any) {
		this.ctx = ctx;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const cwd = this.ctx.sessionManager?.getCwd?.() ?? this.ctx.cwd ?? process.cwd();
		const lines = buildUgkHeaderLines({
			version: VERSION,
			cwdName: path.basename(cwd),
			modelId: this.ctx.model?.id,
			width,
		});
		return ["", ...lines.map((line, i) => colorHeaderLine(line, i, this.theme)), ""];
	}
}

function collectUsage(ctx: ExtensionContext): UgkFooterUsage {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	const entries = ctx.sessionManager?.getEntries?.() ?? ctx.sessionManager?.getBranch?.() ?? [];
	for (const entry of entries) {
		const message = (entry as any).message as AssistantMessage | undefined;
		if ((entry as any).type !== "message" || message?.role !== "assistant" || !message.usage) continue;
		input += message.usage.input || 0;
		output += message.usage.output || 0;
		cacheRead += message.usage.cacheRead || 0;
		cacheWrite += message.usage.cacheWrite || 0;
		cost += message.usage.cost?.total || 0;
	}
	const context = ctx.getContextUsage?.();
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		cost,
		contextPercent: context?.percent ?? null,
		contextWindow: context?.contextWindow ?? ctx.model?.contextWindow ?? 0,
	};
}

class UgkFooter implements Component {
	private unsubscribe?: () => void;
	private readonly ctx: ExtensionContext;
	private readonly theme: any;
	private readonly footerData: any;
	private readonly tui: { requestRender(): void };

	constructor(ctx: ExtensionContext, theme: any, footerData: any, tui: { requestRender(): void }) {
		this.ctx = ctx;
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
		const cwd = this.ctx.sessionManager?.getCwd?.() ?? this.ctx.cwd ?? process.cwd();
		const lines = buildUgkFooterLines({
			cwd,
			branch: this.footerData.getGitBranch?.() ?? null,
			modelId: this.ctx.model?.id || "no-model",
			thinkingLevel: (this.ctx as any).session?.state?.thinkingLevel,
			statuses,
			usage: collectUsage(this.ctx),
			width,
		});

		const [pwd, usage, status] = lines;
		const coloredPwd = pwd.replace(/^ugk/, this.theme.fg("success", "ugk"));
		const coloredUsage = usage.replace(/([^\s]+)$/, this.theme.fg("success", "$1"));
		const rendered = [this.theme.fg("dim", coloredPwd), this.theme.fg("dim", coloredUsage)];
		if (status.trim()) rendered.push(this.theme.fg("dim", status));
		return rendered.map((line) => {
			if (visibleWidth(line) <= width) return line;
			return truncateToWidth(line, width, this.theme.fg("dim", "..."));
		});
	}
}

function applyBrandUi(pi: ExtensionAPI, ctx: ExtensionContext): void {
	ctx.ui.setHeader((_tui, theme) => new UgkHeader(ctx, theme));
	ctx.ui.setFooter((tui, theme, footerData) => new UgkFooter(ctx, theme, footerData, tui));
	ctx.ui.setTitle(formatTitle(pi, ctx.sessionManager?.getCwd?.() ?? ctx.cwd ?? process.cwd()));
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
			const action = args.trim().toLowerCase() || "status";
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
		applyBrandUi(pi, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearBrandUi(ctx);
	});
}
