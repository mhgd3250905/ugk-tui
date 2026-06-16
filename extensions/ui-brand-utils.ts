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

export function buildUgkHeaderLines(options: UgkHeaderOptions): string[] {
	const model = options.modelId || "model not selected";
	return [
		hardTruncate(`ugk v${options.version}  // ${options.cwdName}`, options.width),
		hardTruncate("terminal coding agent · plan mode · subagents · cron · android tools", options.width),
		hardTruncate(`model ${model} · /plan · /implement · /check-env · @agent`, options.width),
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
