import { truncateToWidth } from "@earendil-works/pi-tui";

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

const UGK_BLOCK_LOGO = [
	"██  ██  █████  ██  ██",
	"██  ██ ██      ██ ██ ",
	"██  ██ ██  ███ ████  ",
	"██  ██ ██   ██ ██ ██ ",
	" ████   █████  ██  ██",
];

function hardTruncate(text: string, width: number): string {
	if (width <= 0) return "";
	const truncated = truncateToWidth(text, width, "");
	return truncated.length <= width ? truncated : truncated.slice(0, width);
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
	return hardTruncate(`│ ${body.padEnd(bodyWidth)} │`, width);
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

export function buildUgkHeaderLines(options: UgkHeaderOptions): string[] {
	return [
		...buildUgkLogoLines(options.width),
		"",
		...buildUgkInfoPanelLines(options),
	];
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
		options.usage.cacheRead ? `R${formatTokens(options.usage.cacheRead)}` : "",
		options.usage.cacheWrite ? `W${formatTokens(options.usage.cacheWrite)}` : "",
		`$${options.usage.cost.toFixed(3)}`,
		context,
	].filter(Boolean);
	const model = options.thinkingLevel ? `${options.modelId} · ${options.thinkingLevel}` : options.modelId;

	return [
		hardTruncate(`ugk ${formatCwd(options.cwd)}${branch}`, options.width),
		hardTruncate(`${usage.join(" ")}  ${model}`, options.width),
		hardTruncate(options.statuses.join(" "), options.width),
	];
}
