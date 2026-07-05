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
	if (!validation.ok) return textResult(`URL 校验失败: ${validation.reason}`, { ok: false, engine, url });

	await ensureChrome(deps);
	await deps.navigate(WEB_SEARCH_PORT, url, signal);
	await deps.sleep(NAVIGATE_SETTLE_MS, signal);
	const raw = await evaluateSerp(deps, signal);
	const text = typeof raw === "string" ? raw : String(raw ?? "");
	const failure = detectFailure(text);
	if (failure.failed) {
		return textResult(`搜索失败: ${failure.reason}`, { ok: false, engine, url, failure: failure.reason });
	}

	const truncated = truncateContent(text);
	return textResult(truncated.text, {
		engine,
		url,
		truncated: truncated.truncated,
		bytes: truncated.bytes,
	});
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
		if (engine === "google" && result.details.ok === false) {
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
				return textResult(`搜索出错: ${message}; Bing fallback 也失败: ${fallbackMessage}`, {
					ok: false,
					engine,
					error: message,
					fallbackError: fallbackMessage,
				});
			}
		}
		return textResult(`搜索出错: ${message}`, { ok: false, engine, error: message });
	}
}
