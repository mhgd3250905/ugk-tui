import {
	buildSearchUrl,
	detectFailure,
	truncateContent,
	validateSearchUrl,
	type SearchEngine,
} from "./config.ts";
import {
	createWebSearchClient,
	evaluateJs,
	getWebSearchStatus,
	navigateToUrl,
	type WebSearchStatus,
} from "./client.ts";
import { WEB_SEARCH_DEFAULT_PORT, launchWebSearchChromeAndWait } from "./launcher.ts";

export const WEB_SEARCH_PORT = WEB_SEARCH_DEFAULT_PORT;
const NAVIGATE_SETTLE_MS = 500;
const EVALUATE_TIMEOUT_MS = 15000;

export type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

export interface SearchResultItem {
	title: string;
	url: string;
	snippet?: string;
}

export interface WebSearchDeps {
	status?: (port: number) => Promise<WebSearchStatus>;
	launch?: (port: number) => Promise<string>;
	navigate?: (port: number, url: string, signal?: AbortSignal) => Promise<unknown>;
	evaluate?: (port: number, expression: string, signal?: AbortSignal) => Promise<unknown>;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function textResult(text: string, details: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text }], details };
}

const ENGINE_LABELS: Record<SearchEngine, string> = {
	google: "Google",
	bing: "Bing",
};

const NOISE_LINES = new Set([
	"跳到主要内容",
	"跳至内容",
	"无障碍功能帮助",
	"辅助功能反馈",
	"登录",
	"全部",
	"网页",
	"购物",
	"图片",
	"视频",
	"短视频",
	"新闻",
	"地图",
	"更多",
	"搜索结果",
	"包含站点链接的网页搜索结果",
	"相关问题",
	"用户还搜索了",
	"网页导航",
	"页脚链接",
	"翻译此页",
	"Rewards",
	"AI 模式",
	"国内版国际版",
	"广告",
	"赞助商搜索结果",
	"Sponsored",
]);

function cleanLine(line: string): string {
	return line.trim().replace(/\s+/g, " ");
}

function isUrlLine(line: string): boolean {
	return /^https?:\/\/\S+/i.test(line);
}

function extractUrl(line: string): string {
	return line.match(/https?:\/\/\S+/i)?.[0] ?? line;
}

function isNoiseLine(line: string): boolean {
	const cleaned = cleanLine(line);
	return !cleaned || NOISE_LINES.has(cleaned) || /^[\d\s]+$/.test(cleaned) || /^[·.\-]+$/.test(cleaned);
}

function trimSnippet(line: string): string {
	return line.length <= 180 ? line : `${line.slice(0, 177)}...`;
}

export function extractResultItems(text: string, maxItems = 5): SearchResultItem[] {
	const lines = text.split(/\r?\n/).map(cleanLine);
	const results: SearchResultItem[] = [];
	const seenUrls = new Set<string>();

	for (let i = 0; i < lines.length && results.length < maxItems; i += 1) {
		if (!isUrlLine(lines[i])) continue;
		const url = extractUrl(lines[i]);
		if (seenUrls.has(url)) continue;

		let title = "";
		for (let j = i - 1; j >= 0; j -= 1) {
			if (isUrlLine(lines[j])) break;
			if (!isNoiseLine(lines[j])) {
				title = lines[j];
				break;
			}
		}
		if (!title) title = url;

		let snippet: string | undefined;
		for (let j = i + 1; j < lines.length; j += 1) {
			if (isUrlLine(lines[j])) break;
			if (!isNoiseLine(lines[j])) {
				snippet = trimSnippet(lines[j]);
				break;
			}
		}

		seenUrls.add(url);
		results.push(snippet ? { title, url, snippet } : { title, url });
	}

	return results;
}

function formatSearchSummary(input: {
	query: string;
	engine: SearchEngine;
	url: string;
	ok: boolean;
	normal: boolean;
	results: SearchResultItem[];
	failure?: string;
}): string {
	const lines = [
		`平台: ${ENGINE_LABELS[input.engine]}`,
		`关键词: ${input.query}`,
		`状态: ${input.ok ? "成功" : "失败"}`,
		`结果: ${input.normal ? "正常搜索结果" : input.ok ? "未识别为正常搜索结果" : "异常页面"}`,
	];
	if (input.failure) lines.push(`原因: ${input.failure}`);
	lines.push(`URL: ${input.url}`);

	if (input.results.length > 0) {
		lines.push("", "缩略结果:");
		input.results.forEach((item, index) => {
			lines.push(`${index + 1}. ${item.title}`, `   ${item.url}`);
			if (item.snippet) lines.push(`   ${item.snippet}`);
		});
	}

	return lines.join("\n");
}

function searchResult(
	query: string,
	engine: SearchEngine,
	url: string,
	text: string,
	failure?: string,
): ToolResult {
	const fullText = truncateContent(text);
	const ok = !failure;
	const results = ok ? extractResultItems(text) : [];
	const normal = ok && results.length > 0;
	const summary = formatSearchSummary({ query, engine, url, ok, normal, results, failure });

	return textResult(ok ? fullText.text : summary, {
		ok,
		query,
		engine,
		url,
		normal,
		results,
		summary,
		failure,
		fullText: fullText.text,
		fullTextTruncated: fullText.truncated,
		truncated: fullText.truncated,
		bytes: fullText.bytes,
	});
}

function errorResult(query: string, engine: SearchEngine, message: string, details: Record<string, unknown> = {}): ToolResult {
	const summary = [
		`平台: ${ENGINE_LABELS[engine]}`,
		`关键词: ${query}`,
		"状态: 失败",
		"结果: 异常页面",
		`原因: ${message}`,
	].join("\n");
	return textResult(summary, { ok: false, query, engine, normal: false, summary, error: message, ...details });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function abortError(): Error {
	const error = new Error("web_search operation aborted");
	error.name = "AbortError";
	return error;
}

export function defaultWebSearchDeps(): Required<WebSearchDeps> {
	return {
		status: async (port) => getWebSearchStatus(port),
		launch: async (port) => launchWebSearchChromeAndWait(port),
		navigate: async (port, url, signal) => navigateToUrl(createWebSearchClient({ port }), url, signal),
		evaluate: async (port, expression, signal) =>
			evaluateJs(createWebSearchClient({ port }), expression, signal, EVALUATE_TIMEOUT_MS),
		sleep,
	};
}

const waitForSerpExpression = `
	(function(){
		return new Promise(function(resolve){
			var start = Date.now();
			function check(){
				var node = document.querySelector('#search, #b_results');
				if (node && node.innerText && node.innerText.trim().length > 50) {
					resolve(document.body.innerText || '');
				} else if (Date.now() - start > 3000) {
					resolve(document.body.innerText || '');
				} else {
					setTimeout(check, 100);
				}
			}
			check();
		});
	})()
`;

async function ensureChrome(deps: Required<WebSearchDeps>): Promise<void> {
	const status = await deps.status(WEB_SEARCH_PORT);
	if (!status.online) await deps.launch(WEB_SEARCH_PORT);
}

async function searchOnce(
	query: string,
	engine: SearchEngine,
	deps: Required<WebSearchDeps>,
	signal?: AbortSignal,
): Promise<ToolResult> {
	const url = buildSearchUrl(query, engine);
	const validation = validateSearchUrl(url);
	if (!validation.ok) {
		const result = errorResult(query, engine, `URL 校验失败: ${validation.reason}`, { url });
		return { ...result, details: { ...result.details, _noFallback: true } };
	}

	await ensureChrome(deps);
	await deps.navigate(WEB_SEARCH_PORT, url, signal);
	await deps.sleep(NAVIGATE_SETTLE_MS, signal);
	const raw = await evaluateSerp(deps, signal);
	const text = typeof raw === "string" ? raw : String(raw ?? "");
	const failure = detectFailure(text);
	if (failure.failed) {
		return searchResult(query, engine, url, text, failure.reason);
	}

	return searchResult(query, engine, url, text);
}

async function evaluateSerp(deps: Required<WebSearchDeps>, signal?: AbortSignal): Promise<unknown> {
	try {
		return await deps.evaluate(WEB_SEARCH_PORT, waitForSerpExpression, signal);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/Inspected target navigated|Execution context was destroyed|Cannot find context|Target closed/i.test(message)) {
			throw error;
		}
		await deps.sleep(NAVIGATE_SETTLE_MS, signal);
		return deps.evaluate(WEB_SEARCH_PORT, waitForSerpExpression, signal);
	}
}

export async function doSearch(
	params: { query: string; engine?: SearchEngine },
	overrides: WebSearchDeps = {},
	signal?: AbortSignal,
): Promise<ToolResult> {
	const query = params.query.trim();
	if (!query) return textResult("query 不能为空。", { ok: false });
	const deps = { ...defaultWebSearchDeps(), ...overrides };
	const engine: SearchEngine = params.engine === "bing" ? "bing" : "google";
	try {
		const result = await searchOnce(query, engine, deps, signal);
		if (engine === "google" && result.details.ok === false && !result.details._noFallback) {
			return searchOnce(query, "bing", deps, signal);
		}
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (engine === "google") {
			try {
				return await searchOnce(query, "bing", deps, signal);
			} catch (fallbackError) {
				const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
				return errorResult(query, engine, `搜索出错: ${message}; Bing fallback 也失败: ${fallbackMessage}`, {
					fallbackError: fallbackMessage,
				});
			}
		}
		return errorResult(query, engine, `搜索出错: ${message}`);
	}
}
