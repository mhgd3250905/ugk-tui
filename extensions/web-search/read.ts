import { truncateContent } from "./config.ts";
import {
	createWebSearchClient,
	evaluateJs,
	getWebSearchStatus,
	navigateToUrl,
	type WebSearchStatus,
} from "./client.ts";
import { WEB_SEARCH_DEFAULT_PORT, launchWebSearchChromeAndWait } from "./launcher.ts";

const NAVIGATE_SETTLE_MS = 800;
const EVALUATE_TIMEOUT_MS = 20000;
const DEFAULT_MAX_BYTES = 16384;

export type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

export interface WebReadDeps {
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
	const error = new Error("web_read operation aborted");
	error.name = "AbortError";
	return error;
}

export function defaultWebReadDeps(): Required<WebReadDeps> {
	return {
		status: async (port) => getWebSearchStatus(port),
		launch: async (port) => launchWebSearchChromeAndWait(port),
		navigate: async (port, url, signal) => navigateToUrl(createWebSearchClient({ port }), url, signal),
		evaluate: async (port, expression, signal) =>
			evaluateJs(createWebSearchClient({ port }), expression, signal, EVALUATE_TIMEOUT_MS),
		sleep,
	};
}

// ponytail: injected JS is enough for now; add selectors or @mozilla/readability only after bad real pages prove it.
const READABILITY_JS = `
	(function(){
		var remove = 'nav,header,footer,aside,script,style,noscript,svg,form,iframe,.ad,.ads,.sidebar,.menu,.nav,.footer,.header,[role=navigation],[role=banner],[role=search]';
		try { document.querySelectorAll(remove).forEach(function(n){ n.remove(); }); } catch(e){}
		var sel = ['article','main','[role=main]','#content','.content','.post','.article','.entry-content','#main'];
		var node = null;
		for (var i=0;i<sel.length;i++){
			var n = document.querySelector(sel[i]);
			if (n && n.innerText && n.innerText.trim().length > 200){ node = n; break; }
		}
		var text = ((node||document.body).innerText || '').trim();
		var h1 = document.querySelector('h1');
		var title = ((h1 && h1.innerText) || document.title || '').trim();
		return JSON.stringify({ title: title, text: text });
	})()
`;

async function ensureChrome(deps: Required<WebReadDeps>): Promise<void> {
	const status = await deps.status(WEB_SEARCH_DEFAULT_PORT);
	if (!status.online) await deps.launch(WEB_SEARCH_DEFAULT_PORT);
}

async function evaluateRead(deps: Required<WebReadDeps>, signal?: AbortSignal): Promise<{ title: string; text: string }> {
	try {
		const raw = await deps.evaluate(WEB_SEARCH_DEFAULT_PORT, READABILITY_JS, signal);
		const str = typeof raw === "string" ? raw : String(raw ?? "");
		const parsed = JSON.parse(str);
		return { title: String(parsed.title ?? ""), text: String(parsed.text ?? str) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/Inspected target navigated|Execution context was destroyed|Cannot find context|Target closed/i.test(message)) {
			throw error;
		}
		await deps.sleep(NAVIGATE_SETTLE_MS, signal);
		const raw = await deps.evaluate(WEB_SEARCH_DEFAULT_PORT, READABILITY_JS, signal);
		const str = typeof raw === "string" ? raw : String(raw ?? "");
		const parsed = JSON.parse(str);
		return { title: String(parsed.title ?? ""), text: String(parsed.text ?? str) };
	}
}

export async function doRead(
	params: { url: string; maxBytes?: number },
	overrides: WebReadDeps = {},
	signal?: AbortSignal,
): Promise<ToolResult> {
	const url = (params.url ?? "").trim();
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return textResult(`URL 解析失败: ${url}`, { ok: false, url });
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return textResult(`仅支持 http/https URL,收到 ${parsed.protocol}`, { ok: false, url });
	}

	const deps = { ...defaultWebReadDeps(), ...overrides };
	try {
		await ensureChrome(deps);
		await deps.navigate(WEB_SEARCH_DEFAULT_PORT, url, signal);
		await deps.sleep(NAVIGATE_SETTLE_MS, signal);
		const { title, text } = await evaluateRead(deps, signal);
		if (!text) return textResult(`页面无可见正文: ${url}`, { ok: false, url, title, empty: true });

		const truncated = truncateContent(text, params.maxBytes ?? DEFAULT_MAX_BYTES);
		const host = parsed.hostname.replace(/^www\./, "");
		const header = `${title ? `${title}\n` : ""}${url}\n(${host} · ${truncated.bytes} bytes${truncated.truncated ? ", 已截断" : ""})\n\n`;
		return textResult(header + truncated.text, {
			ok: true,
			url,
			host,
			title,
			bytes: truncated.bytes,
			truncated: truncated.truncated,
			fullText: truncated.text,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return textResult(`读取失败: ${url}\n原因: ${message}`, { ok: false, url, error: message });
	}
}
