import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { uiText } from "../shared/ui-language.ts";
import { doSearch, type WebSearchDeps } from "./search.ts";

export { doSearch } from "./search.ts";
export type { WebSearchDeps } from "./search.ts";

export function registerWebSearch(pi: ExtensionAPI, overrides: WebSearchDeps = {}): void {
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
		}),
	);
}

export default registerWebSearch;
