import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	buildSearchUrl,
	detectFailure,
	truncateContent,
	validateSearchUrl,
} from "../extensions/web-search/config.ts";
import {
	createWebSearchClient,
	evaluateJs,
	getWebSearchStatus,
	navigateToUrl,
} from "../extensions/web-search/client.ts";
import {
	WEB_SEARCH_DEFAULT_PORT,
	__testOnly,
	getDefaultWebSearchProfilePath,
	getWebSearchLaunchCommand,
} from "../extensions/web-search/launcher.ts";
import { doSearch } from "../extensions/web-search/search.ts";
import { registerWebSearch } from "../extensions/web-search/index.ts";

const sampleTabs = [
	{
		id: "tab-1",
		type: "page",
		title: "Search",
		url: "about:blank",
		webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/tab-1",
	},
	{
		id: "worker-1",
		type: "service_worker",
		title: "Worker",
		url: "https://example.com/sw.js",
	},
];

function makeFetch(response: unknown, ok = true) {
	return async () =>
		({
			ok,
			status: ok ? 200 : 500,
			json: async () => response,
		}) as Response;
}

class FakeWebSocket {
	static sent: string[] = [];
	static response: unknown = { id: 1, result: {} };
	readonly url: string;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onclose: (() => void) | null = null;

	constructor(url: string) {
		this.url = url;
		queueMicrotask(() => this.onopen?.());
	}

	send(message: string) {
		FakeWebSocket.sent.push(message);
		queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(FakeWebSocket.response) }));
	}

	close() {
		this.onclose?.();
	}
}

test("web-search config builds whitelisted search URLs", () => {
	assert.equal(buildSearchUrl("LinkedIn 关键字 API", "google"), "https://www.google.com/search?q=LinkedIn%20%E5%85%B3%E9%94%AE%E5%AD%97%20API&hl=zh-CN");
	assert.equal(buildSearchUrl("LinkedIn 关键字 API", "bing"), "https://cn.bing.com/search?q=LinkedIn%20%E5%85%B3%E9%94%AE%E5%AD%97%20API&setlang=zh-CN");
	assert.deepEqual(validateSearchUrl("https://www.google.com/search?q=x"), { ok: true, host: "www.google.com" });
	assert.deepEqual(validateSearchUrl("https://evil.example/search?q=x"), { ok: false, reason: "host evil.example 不在白名单" });
	assert.equal(detectFailure("Our systems have detected unusual traffic").failed, true);
	assert.equal(detectFailure("请输入验证码").failed, true);
	assert.equal(detectFailure("This site can't be reached\nERR_CONNECTION_TIMED_OUT").failed, true);
	assert.equal(detectFailure("无法访问此网站\nERR_TUNNEL_CONNECTION_FAILED").failed, true);
	assert.deepEqual(detectFailure("正常搜索结果"), { failed: false });
});

test("truncateContent keeps returned text under the search limit", () => {
	const result = truncateContent("a".repeat(9000), 8192);

	assert.equal(result.truncated, true);
	assert.ok(Buffer.byteLength(result.text, "utf8") <= 8192);
	assert.equal(result.bytes, 9000);

	const chinese = truncateContent("字".repeat(4000), 8192);
	assert.equal(chinese.truncated, true);
	assert.ok(Buffer.byteLength(chinese.text, "utf8") <= 8192);
});

test("web-search client navigates and evaluateJs returns result.value", async () => {
	FakeWebSocket.sent = [];
	FakeWebSocket.response = { id: 1, result: { frameId: "frame-1" } };
	const client = createWebSearchClient({
		port: 9223,
		fetch: makeFetch(sampleTabs),
		WebSocket: FakeWebSocket as any,
	});

	const nav = await navigateToUrl(client, "https://www.google.com/search?q=x");
	assert.equal(nav.frameId, "frame-1");
	assert.deepEqual(JSON.parse(FakeWebSocket.sent[0]), {
		id: 1,
		method: "Page.navigate",
		params: { url: "https://www.google.com/search?q=x" },
	});

	FakeWebSocket.sent = [];
	FakeWebSocket.response = { id: 1, result: { result: { type: "string", value: "SERP text" } } };
	const text = await evaluateJs(client, "document.body.innerText");
	assert.equal(text, "SERP text");
	assert.deepEqual(JSON.parse(FakeWebSocket.sent[0]), {
		id: 1,
		method: "Runtime.evaluate",
		params: { expression: "document.body.innerText", returnByValue: true, awaitPromise: true },
	});
});

test("getWebSearchStatus reports offline without throwing", async () => {
	const status = await getWebSearchStatus(9223, async () => {
		throw new Error("ECONNREFUSED");
	});

	assert.deepEqual(status, { online: false, port: 9223, error: "ECONNREFUSED" });
});

test("web-search launcher uses isolated headless Chrome defaults", () => {
	assert.equal(WEB_SEARCH_DEFAULT_PORT, 9223);
	assert.equal(
		getDefaultWebSearchProfilePath(path.join("/Users", "demo")),
		path.join("/Users", "demo", ".ugk", "web-search-profile"),
	);
	const command = getWebSearchLaunchCommand({ port: 9223, homeDir: path.join("/Users", "demo"), platform: "darwin" });
	assert.equal(command.command, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
	assert.deepEqual(command.args, [
		"--remote-debugging-port=9223",
		"--remote-debugging-address=127.0.0.1",
		`--user-data-dir=${path.join("/Users", "demo", ".ugk", "web-search-profile")}`,
		"--headless=new",
		"--no-first-run",
		"--disable-gpu",
	]);
});

test("web-search teardown kills managed ports and clears them", () => {
	__testOnly.teardown();
	const killedPorts: number[] = [];
	const restoreKill = __testOnly.setKillImpl((port) => { killedPorts.push(port); });
	__testOnly.managedPorts.add(9223);
	__testOnly.managedPorts.add(9333);

	__testOnly.teardown();

	assert.equal(__testOnly.managedPorts.size, 0);
	assert.deepEqual(killedPorts.sort((a, b) => a - b), [9223, 9333]);
	restoreKill();
});

test("web-search launcher resolves Windows chrome.exe when present", () => {
	const fakeProgramFiles = path.join(os.tmpdir(), "ugk-web-search-pf");
	const chromeExe = path.join(fakeProgramFiles, "Google", "Chrome", "Application", "chrome.exe");
	fs.mkdirSync(path.dirname(chromeExe), { recursive: true });
	fs.writeFileSync(chromeExe, "");
	process.env.PROGRAMFILES = fakeProgramFiles;

	try {
		const command = getWebSearchLaunchCommand({ port: 9223, homeDir: os.tmpdir(), platform: "win32" });
		assert.equal(command.command, chromeExe);
		assert.ok(command.args.includes("--headless=new"));
	} finally {
		delete process.env.PROGRAMFILES;
		fs.rmSync(fakeProgramFiles, { recursive: true, force: true });
	}
});

test("doSearch launches Chrome, waits, evaluates SERP text, and returns details", async () => {
	const calls: string[] = [];
	const result = await doSearch(
		{ query: "LinkedIn API" },
		{
			status: async () => ({ online: false, port: 9223 }),
			launch: async (port) => {
				calls.push(`launch:${port}`);
				return "launched";
			},
			navigate: async (port, url) => {
				calls.push(`navigate:${port}:${url}`);
				return {};
			},
			evaluate: async (port, expr) => {
				calls.push(`evaluate:${port}`);
				assert.match(expr, /#search, #b_results/);
				return "LinkedIn API\nhttps://developers.linkedin.com";
			},
			sleep: async () => {
				calls.push("sleep");
			},
		},
	);

	assert.deepEqual(calls, [
		"launch:9223",
		"navigate:9223:https://www.google.com/search?q=LinkedIn%20API&hl=zh-CN",
		"sleep",
		"evaluate:9223",
	]);
	assert.equal(result.content[0].text, "LinkedIn API\nhttps://developers.linkedin.com");
	assert.equal(result.details.engine, "google");
	assert.equal(result.details.truncated, false);
	assert.equal(result.details.bytes, Buffer.byteLength("LinkedIn API\nhttps://developers.linkedin.com", "utf8"));
});

test("doSearch falls back from Google failure to Bing CN", async () => {
	const navigated: string[] = [];
	const result = await doSearch(
		{ query: "x search" },
		{
			status: async () => ({ online: true, port: 9223 }),
			launch: async () => "launched",
			navigate: async (_port, url) => {
				navigated.push(url);
				return {};
			},
			evaluate: async () => (navigated.length === 1 ? "Our systems have detected unusual traffic" : "Bing result"),
			sleep: async () => {},
		},
	);

	assert.deepEqual(navigated, [
		"https://www.google.com/search?q=x%20search&hl=zh-CN",
		"https://cn.bing.com/search?q=x%20search&setlang=zh-CN",
	]);
	assert.equal(result.content[0].text, "Bing result");
	assert.equal(result.details.engine, "bing");
});

test("doSearch retries evaluate once when navigation swaps the inspected target", async () => {
	let evaluateCalls = 0;
	const navigated: string[] = [];
	const result = await doSearch(
		{ query: "LinkedIn API" },
		{
			status: async () => ({ online: true, port: 9223 }),
			launch: async () => "launched",
			navigate: async (_port, url) => {
				navigated.push(url);
				return {};
			},
			evaluate: async () => {
				evaluateCalls += 1;
				if (evaluateCalls === 1) throw new Error("Inspected target navigated or closed");
				return "Recovered Google result";
			},
			sleep: async () => {},
		},
	);

	assert.deepEqual(navigated, ["https://www.google.com/search?q=LinkedIn%20API&hl=zh-CN"]);
	assert.equal(evaluateCalls, 2);
	assert.equal(result.content[0].text, "Recovered Google result");
	assert.equal(result.details.engine, "google");
});

test("registerWebSearch registers web_search with 5-arg execute signature", async () => {
	const tools = new Map<string, any>();
	registerWebSearch(
		{
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
		} as any,
		{
			status: async () => ({ online: true, port: 9223 }),
			launch: async () => "launched",
			navigate: async () => ({}),
			evaluate: async () => "registered result",
			sleep: async () => {},
		},
	);

	const tool = tools.get("web_search");
	assert.ok(tool);
	assert.equal(tool.execute.length, 5);
	const result = await tool.execute("call-1", { query: "hello" }, undefined, undefined, { hasUI: false });
	assert.equal(result.content[0].text, "registered result");
});
