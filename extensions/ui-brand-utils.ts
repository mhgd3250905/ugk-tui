import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const UGK_BRAND_COLORS = {
	accent: "#9be564",
	cyan: "#79e6d9",
	text: "#d8fff7",
	muted: "#7c8588",
	dim: "#5e6669",
	panel: "#20242f",
	panelStrong: "#262b37",
	error: "#ff6b7a",
	warning: "#e4c766",
} as const;

export interface UgkHeaderOptions {
	version: string;
	cwdName: string;
	modelId?: string;
	width: number;
}

export interface UgkStartupScreenOptions extends UgkHeaderOptions {
	rows: number;
}

export interface UgkFooterUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextPercent: number | null;
	contextWindow: number;
}

export interface UgkFooterOptions {
	cwd: string;
	branch: string | null;
	modelId: string;
	thinkingLevel?: string;
	statuses: string[];
	usage: UgkFooterUsage;
	width: number;
}

export type UgkStatusTone = "error" | "warning" | "success" | "dim";

export function resolveUgkDisplayModelId(modelId: string | undefined, deepSeekStatus: string): string | undefined {
	if (!modelId) return undefined;
	const isDeepSeekModel = modelId.toLowerCase().startsWith("deepseek");
	if (isDeepSeekModel && /未配置/.test(deepSeekStatus)) return "❌ API not configured";
	return modelId;
}

export function classifyUgkStatusTone(text: string): UgkStatusTone {
	const normalized = text.toLowerCase();
	if (/\[fail\]|✗|未配置|api not configured|unavailable|not loaded|missing|failed|error/.test(normalized)) {
		return "error";
	}
	if (/\[warn\]|⚠|warn|not reachable|not ready|timeout|skipped/.test(normalized)) return "warning";
	if (/\[pass\]|✓|已配置|configured|available|loaded|reachable|online|success/.test(normalized)) return "success";
	return "dim";
}

const UGK_BLOCK_LOGO = [
	"██  ██  █████  ██  ██",
	"██  ██ ██      ██ ██ ",
	"██  ██ ██  ███ ████  ",
	"██  ██ ██   ██ ██ ██ ",
	" ████   █████  ██  ██",
];

function hardTruncate(text: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, "").replace(/\x1b\[[0-9;]*m/g, "");
}

function padEndVisible(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function formatTokens(count: number): string {
	if (!count) return "0";
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

function panelWidth(width: number): number {
	if (width <= 0) return 0;
	return Math.min(width, 64);
}

function welcomePanelWidth(width: number): number {
	if (width <= 0) return 0;
	return Math.min(width, 120);
}

function fitVisible(text: string, width: number, align: "left" | "center" = "left"): string {
	const clipped = hardTruncate(text, width);
	const padding = Math.max(0, width - visibleWidth(clipped));
	if (align === "center") {
		const left = Math.floor(padding / 2);
		return `${" ".repeat(left)}${clipped}${" ".repeat(padding - left)}`;
	}
	return `${clipped}${" ".repeat(padding)}`;
}

function panelRule(left: string, label: string, right: string, width: number): string {
	const ruleWidth = panelWidth(width);
	if (ruleWidth <= 0) return "";
	const prefix = `${left}─ ${label} `;
	const fill = "─".repeat(Math.max(0, ruleWidth - prefix.length - right.length));
	return hardTruncate(`${prefix}${fill}${right}`, width);
}

function panelEdge(left: string, right: string, width: number): string {
	const ruleWidth = panelWidth(width);
	if (ruleWidth <= 0) return "";
	const fill = "─".repeat(Math.max(0, ruleWidth - left.length - right.length));
	return hardTruncate(`${left}${fill}${right}`, width);
}

function panelRow(label: string, value: string, width: number): string {
	const rowWidth = panelWidth(width);
	if (rowWidth <= 0) return "";
	const bodyWidth = Math.max(0, rowWidth - 4);
	const labelText = label ? `${label.padEnd(12)}${value}` : value;
	const body = hardTruncate(labelText, bodyWidth);
	return hardTruncate(`│ ${padEndVisible(body, bodyWidth)} │`, width);
}

function welcomePanelRule(label: string, width: number): string {
	const rowWidth = welcomePanelWidth(width);
	if (rowWidth <= 0) return "";
	const prefix = `┌─ ${label} `;
	return `${prefix}${"─".repeat(Math.max(0, rowWidth - visibleWidth(prefix) - 1))}┐`;
}

function welcomePanelEdge(width: number): string {
	const rowWidth = welcomePanelWidth(width);
	if (rowWidth <= 0) return "";
	return `└${"─".repeat(Math.max(0, rowWidth - 2))}┘`;
}

function welcomePanelRow(left: string, right: string, rowWidth: number, leftWidth: number): string {
	const rightWidth = Math.max(0, rowWidth - leftWidth - 7);
	return `│ ${fitVisible(left, leftWidth)} │ ${fitVisible(right, rightWidth)} │`;
}

export function buildUgkLogoLines(width: number): string[] {
	return UGK_BLOCK_LOGO.map((line) => hardTruncate(line, width));
}

function buildUgkInfoPanelLines(options: UgkHeaderOptions): string[] {
	const model = options.modelId || "model not selected";
	return [
		panelRule("┌", `ugk v${options.version}`, "┐", options.width),
		panelRow("workspace", options.cwdName, options.width),
		panelRow("agent", "terminal coding agent", options.width),
		panelRow("stack", "plan · subagents · cron · adb", options.width),
		panelRule("├", "quick actions", "┤", options.width),
		panelRow("", "/plan  /implement  /check-env  @agent", options.width),
		panelRow("model", model, options.width),
		panelEdge("└", "┘", options.width),
	];
}

function buildUgkWelcomePanelLines(options: UgkHeaderOptions): string[] {
	const rowWidth = welcomePanelWidth(options.width);
	if (rowWidth < 72) {
		return [
			...buildUgkLogoLines(options.width),
			"",
			...buildUgkInfoPanelLines(options),
		];
	}

	const model = options.modelId || "model not selected";
	const leftWidth = Math.max(28, Math.floor((rowWidth - 7) * 0.45));
	const logoWidth = Math.max(...UGK_BLOCK_LOGO.map((line) => visibleWidth(line)));
	const leftRows = [
		"Welcome back.",
		"",
		...UGK_BLOCK_LOGO.map((line) => fitVisible(padEndVisible(line, logoWidth), leftWidth, "center")),
		"",
		`workspace  ${options.cwdName}`,
		`model      ${model}`,
	];
	const rightRows = [
		"Tips for getting started",
		"/plan      draft before changing files",
		"/implement run the guided pipeline",
		"/check-env verify local tools",
		"",
		"What's new",
		"task runs show worker progress",
		"footer shows usage and ready state",
		"@agent delegates focused work",
	];

	const rowCount = Math.max(leftRows.length, rightRows.length);
	return [
		welcomePanelRule(`ugk v${options.version}`, options.width),
		...Array.from({ length: rowCount }, (_, i) => welcomePanelRow(leftRows[i] ?? "", rightRows[i] ?? "", rowWidth, leftWidth)),
		welcomePanelEdge(options.width),
	];
}

export function buildUgkHeaderLines(options: UgkHeaderOptions): string[] {
	return buildUgkWelcomePanelLines(options);
}

export function buildUgkStartupScreenLines(options: UgkStartupScreenOptions): string[] {
	if (options.width < 72 || options.rows < 16) {
		return buildUgkHeaderLines(options);
	}

	const targetRows = Math.max(12, options.rows - 5);
	const content = buildUgkHeaderLines(options);

	const missing = Math.max(0, targetRows - content.length);
	const topPadding = Math.floor(missing / 2);
	const bottomPadding = missing - topPadding;
	return [...Array(topPadding).fill(""), ...content, ...Array(bottomPadding).fill("")];
}

export function buildUgkFooterLines(options: UgkFooterOptions): string[] {
	const branch = options.branch ? ` (${options.branch})` : "";
	const context =
		options.usage.contextPercent === null
			? `?/${formatTokens(options.usage.contextWindow)}`
			: `${options.usage.contextPercent.toFixed(1)}%/${formatTokens(options.usage.contextWindow)}`;
	const usage = [
		`↑${formatTokens(options.usage.input)}`,
		`↓${formatTokens(options.usage.output)}`,
		options.usage.cacheRead ? `R ${formatTokens(options.usage.cacheRead)}` : "",
		options.usage.cacheWrite ? `W ${formatTokens(options.usage.cacheWrite)}` : "",
		`💰 $${options.usage.cost.toFixed(3)}`,
		`🧠 ${context}`,
	].filter(Boolean);
	const model = options.thinkingLevel ? `🤖 ${options.modelId} · ${options.thinkingLevel}` : `🤖 ${options.modelId}`;

	return [
		hardTruncate(`ugk ${formatCwd(options.cwd)}${branch}`, options.width),
		hardTruncate(`${usage.join(" ")}  ${model}`, options.width),
		hardTruncate(options.statuses.join(" "), options.width),
	];
}
