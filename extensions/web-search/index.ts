import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { uiText } from "../shared/ui-language.ts";
import { getWebSearchStatus, type WebSearchStatus } from "./client.ts";
import {
	WEB_SEARCH_DEFAULT_PORT,
	getDefaultWebSearchProfilePath,
	launchVisibleWebSearchChromeAndWait,
} from "./launcher.ts";
import { doRead } from "./read.ts";
import { doSearch, type WebSearchDeps } from "./search.ts";

export { doRead } from "./read.ts";
export type { WebReadDeps } from "./read.ts";
export { doSearch } from "./search.ts";
export type { WebSearchDeps } from "./search.ts";

interface WebSearchControlDeps {
	status?: (port: number) => Promise<WebSearchStatus>;
	launchVisible?: (port: number) => Promise<string>;
}

type WebSearchRenderDetails = {
	summary?: string;
	fullText?: string;
	fullTextTruncated?: boolean;
	engine?: string;
	query?: string;
	ok?: boolean;
	normal?: boolean;
	failure?: string;
	error?: string;
	results?: Array<{ title?: string; url?: string }>;
};

function shortText(text: string, max = 72): string {
	return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return shortText(url, 40);
	}
}

function compactResult(details: WebSearchRenderDetails | undefined, fallback: string): string {
	if (!details) return fallback;
	const engine = details.engine === "bing" ? "Bing" : "Google";
	const status = details.ok === false ? "失败" : "成功";
	const normal = details.normal ? "正常" : details.ok === false ? "异常" : "未识别";
	const lines = [`${engine} · ${status} · ${normal} · ${shortText(String(details.query ?? ""))}`];

	const reason = details.failure ?? details.error;
	if (reason) lines.push(`原因: ${shortText(reason)}`);

	for (const [index, item] of (details.results ?? []).slice(0, 2).entries()) {
		if (!item.title || !item.url) continue;
		lines.push(`${index + 1}. ${shortText(item.title, 48)} (${hostOf(item.url)})`);
	}

	return lines.join("\n");
}

function formatWebSearchStatus(status: WebSearchStatus): string {
	return [
		`web_search Chrome: ${status.online ? "online" : "offline"}`,
		`Port: ${status.port}`,
		`Profile: ${getDefaultWebSearchProfilePath()}`,
		status.error ? `Error: ${status.error}` : "",
	].filter(Boolean).join("\n");
}

async function resolveWebSearchArgs(args: string, ctx: any): Promise<string | undefined> {
	if (args.trim()) return args.trim();
	if (!ctx.ui?.select) return "status";
	const options = [uiText("查看状态", "Status"), uiText("打开可见 Chrome", "Open visible Chrome"), uiText("退出", "Exit")];
	const selection = await ctx.ui.select("web_search", options);
	if (!selection || selection === options[2]) return undefined;
	if (selection === options[0]) return "status";
	if (selection === options[1]) return "open";
	return undefined;
}

export function registerWebSearch(pi: ExtensionAPI, overrides: WebSearchDeps = {}, controlOverrides: WebSearchControlDeps = {}): void {
	const controlDeps = {
		status: async (port: number) => getWebSearchStatus(port),
		launchVisible: async (port: number) => launchVisibleWebSearchChromeAndWait(port),
		...controlOverrides,
	};
	pi.registerTool(
		defineTool({
			name: "web_search",
			label: uiText("网络搜索", "Web Search"),
			description: uiText(
				"搜索互联网(Google 优先,Bing 中国版兜底)。用于查询训练数据之外的信息。",
				"Search the web (Google first, Bing CN fallback). Use for information outside training data.",
			),
			promptSnippet:
				"当你需要训练数据之外的最新信息时,用 web_search 查询。返回的是搜索引擎结果页面文本,你要自己识别标题、URL、摘要。",
			promptGuidelines: [
				"query 用最关键的几个词,不要整句话",
				"返回内容是 SERP 页面文本,你要自己提取有用信息",
				"如果内容显示被反爬拦截,告诉用户可能要换网络环境",
			],
			parameters: Type.Object({
				query: Type.String({ description: "搜索关键词" }),
				engine: Type.Optional(StringEnum(["google", "bing"] as const, { description: "搜索引擎,默认 google" })),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
				return doSearch({ query: params.query, engine: params.engine }, overrides, signal);
			},
			renderCall(args, theme) {
				const query = typeof args?.query === "string" ? args.query : "";
				const engine = args?.engine === "bing" ? "Bing" : "Google";
				return new Text(theme.fg("toolTitle", theme.bold(`web_search ${engine}`)) + theme.fg("dim", ` ${query}`), 0, 0);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) return new Text(theme.fg("warning", uiText("搜索中...", "searching...")), 0, 0);

				const details = result.details as WebSearchRenderDetails | undefined;
				const content = result.content[0];
				let text = compactResult(details, content?.type === "text" ? content.text : "");

				if (expanded && details?.fullText) {
					text += `\n\n${uiText("完整页面文本:", "Full page text:")}\n${details.fullText}`;
					if (details.fullTextTruncated) text += `\n${uiText("[完整文本已截断]", "[full text truncated]")}`;
				} else if (details?.fullText) {
					text += theme.fg("muted", "\n(Ctrl+O to expand)");
				}

				return new Text(text, 0, 0);
			},
		}),
	);
	pi.registerTool(
		defineTool({
			name: "web_read",
			label: uiText("读取网页", "Read Page"),
			description: uiText(
				"读取任意 http/https 网页正文(用 web_search 同一个隔离 Chrome)。用于跟进搜索结果里的链接读全文。",
				"Read the main text of any http/https page (same isolated Chrome as web_search). Use to follow links from search results.",
			),
			promptSnippet:
				"当你要读某个 URL 的正文(比如 web_search 返回的链接),用 web_read。返回去噪后的正文文本。",
			promptGuidelines: [
				"url 必须是完整 http(s):// 地址",
				"返回的是去噪正文,不是 HTML",
				"读不到正文会返回 ok:false,换链接或告诉用户",
			],
			parameters: Type.Object({
				url: Type.String({ description: "要读取的完整 URL,http(s)://" }),
				maxBytes: Type.Optional(Type.Number({ description: "正文最大字节数,默认 16384" })),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
				return doRead({ url: params.url, maxBytes: params.maxBytes }, overrides, signal);
			},
			renderCall(args, theme) {
				const url = typeof args?.url === "string" ? args.url : "";
				let host = url;
				try {
					host = new URL(url).hostname.replace(/^www\./, "");
				} catch {}
				return new Text(theme.fg("toolTitle", theme.bold("web_read")) + theme.fg("dim", ` ${host}`), 0, 0);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) return new Text(theme.fg("warning", uiText("读取中...", "reading...")), 0, 0);

				const details = result.details as any;
				const content = result.content[0];
				const text = content?.type === "text" ? content.text : "";
				if (expanded) return new Text(text, 0, 0);

				const firstLine = text.split("\n")[0] ?? "";
				const status = details.ok === false ? "失败" : "成功";
				return new Text(
					`web_read · ${status} · ${firstLine}` + (details.fullText ? theme.fg("muted", "\n(Ctrl+O to expand)") : ""),
					0,
					0,
				);
			},
		}),
	);
	pi.registerCommand("web-search", {
		description: "Manage isolated web_search Chrome",
		handler: async (args, ctx) => {
			const resolvedArgs = await resolveWebSearchArgs(args, ctx);
			if (resolvedArgs === undefined) return;
			const action = resolvedArgs.trim();
			const [command, ...flags] = action.split(/\s+/);
			if (!action || action === "status") {
				ctx.ui.notify(formatWebSearchStatus(await controlDeps.status(WEB_SEARCH_DEFAULT_PORT)), "info");
				return;
			}
			if (command === "open" || command === "launch" || command === "visible") {
				if (!flags.includes("--force")) {
					const status = await controlDeps.status(WEB_SEARCH_DEFAULT_PORT);
					if (status.online) {
						ctx.ui.notify(`${formatWebSearchStatus(status)}\n\n已在线;如需重启为可见 Chrome,运行 /web-search restart`, "info");
						return;
					}
				}
				ctx.ui.notify(await controlDeps.launchVisible(WEB_SEARCH_DEFAULT_PORT), "info");
				return;
			}
			if (command === "restart") {
				ctx.ui.notify(await controlDeps.launchVisible(WEB_SEARCH_DEFAULT_PORT), "info");
				return;
			}
			ctx.ui.notify(uiText("用法: /web-search status|open|open --force|restart", "Usage: /web-search status|open|open --force|restart"), "warning");
		},
	});
}

export default registerWebSearch;
